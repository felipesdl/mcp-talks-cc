#!/usr/bin/env bash
# Auto-ingest disparado pelo hook SessionStart do Claude Code (async).
# Roda incremental, sobe o Neo4j se estiver parado, e grava health.json em
# TODOS os caminhos de saída (o session-primer.sh lê isso pra avisar staleness).
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${HOME}/.cache/mcp-talks-cc"
LOG="${LOG_DIR}/ingest.log"
HEALTH="${LOG_DIR}/health.json"
LOCK_DIR="${LOG_DIR}/ingest.lock.d"
SIMILAR_STAMP="${LOG_DIR}/last-similar.stamp"
LOCK_STALE_SECS=3600      # lock mais velho que isso = processo morto
SIMILAR_MIN_AGE_SECS=72000 # rebuild:similar no máx 1x/20h

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR" || exit 0

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) [session-ingest] $*" >> "$LOG"; }
now_epoch() { date +%s; }

# mtime portátil (BSD stat no macOS, GNU stat no Linux)
mtime_of() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# health.json: status atual + epoch do último ok (preservado entre runs).
# detail é sanitizado pra ASCII simples porque entra em JSON escrito com printf.
write_health() {
  local status="$1" detail="${2:-}" prev_ok now
  now="$(now_epoch)"
  prev_ok="$(sed -nE 's/.*"lastOkEpoch"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$HEALTH" 2>/dev/null | head -1)"
  [ -z "$prev_ok" ] && prev_ok=0
  [ "$status" = "ok" ] && prev_ok="$now"
  detail="$(printf '%s' "$detail" | tr -cd '[:alnum:] ._:/=-')"
  printf '{"v":1,"status":"%s","detail":"%s","checkedEpoch":%s,"lastOkEpoch":%s}\n' \
    "$status" "$detail" "$now" "$prev_ok" > "${HEALTH}.tmp" 2>/dev/null &&
    mv "${HEALTH}.tmp" "$HEALTH" 2>/dev/null
}

neo4j_up() { nc -z localhost 7687 2>/dev/null; }

# ── Neo4j: sobe em vez de desistir ──────────────────────────────────────────
# O driver não tem connect-timeout, então checamos a porta Bolt antes.
if ! neo4j_up; then
  if command -v docker >/dev/null 2>&1; then
    log "neo4j down (7687 fechada), subindo container"
    TO=""
    command -v timeout >/dev/null 2>&1 && TO="timeout 240"
    command -v gtimeout >/dev/null 2>&1 && TO="gtimeout 240"
    # shellcheck disable=SC2086
    $TO docker compose up -d --wait >> "$LOG" 2>&1
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      neo4j_up && break
      sleep 2
    done
  else
    log "neo4j down e docker ausente no PATH"
  fi
fi

if ! neo4j_up; then
  log "neo4j indisponível, skip"
  write_health "neo4j-down" "porta 7687 fechada apos tentativa de up"
  exit 0
fi

# ── Lock: mkdir é atômico em POSIX (flock não existe no macOS) ───────────────
# Evita empilhar ingests concorrentes: cada sessão Claude dispara este hook e
# cada processo node carrega o modelo de embedding (~1.5GB).
# Liveness por pid, não por idade: o backlog inicial leva horas e um reclaim
# por tempo roubaria o lock no meio do run, criando dois ingests concorrentes.
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "${LOCK_DIR}/pid"
    return 0
  fi
  [ -d "$LOCK_DIR" ] || return 1

  local holder age
  holder="$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo '')"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    return 1 # dono vivo
  fi

  age=$(( $(now_epoch) - $(mtime_of "$LOCK_DIR") ))
  if [ -z "$holder" ] && [ "$age" -le "$LOCK_STALE_SECS" ]; then
    return 1 # sem pid ainda (corrida no mkdir), respeita por até 1h
  fi

  log "lock órfão (pid='${holder}', ${age}s), reclamando"
  rm -rf "$LOCK_DIR" 2>/dev/null
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "${LOCK_DIR}/pid"
    return 0
  fi
  return 1
}

LOCK_HELD=0
if acquire_lock; then
  LOCK_HELD=1
  trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM
elif [ -d "$LOCK_DIR" ]; then
  log "já tem ingest rodando (lock ativo), skip"
  write_health "lock-held" "outro ingest em andamento"
  exit 0
else
  # Fail-open: guard quebrado nunca pode virar skip permanente. Guard que falha
  # fechado (ex.: binário de lock ausente no PATH) mata o ingest em silêncio.
  log "AVISO: lockdir não criável e ausente, seguindo sem lock (fail-open)"
fi

# ── Ingest ──────────────────────────────────────────────────────────────────
log "start (lock=${LOCK_HELD})"
OUT="$(mktemp -t mcp-talks-ingest)"
npm run ingest -- --source=all > "$OUT" 2>&1
code=$?
cat "$OUT" >> "$LOG"
# soma de `chunks: N` de todas as sources pra decidir se vale rebuild:similar
new_chunks="$(sed -nE 's/.*chunks:[[:space:]]*([0-9]+).*/\1/p' "$OUT" | awk '{s+=$1} END {print s+0}')"
rm -f "$OUT"
log "done (exit $code, chunks novos: ${new_chunks})"

if [ "$code" -eq 0 ]; then
  write_health "ok" "chunks=${new_chunks}"
else
  write_health "failed" "ingest exit ${code}"
fi

# ── SIMILAR_TO: edges do find_similar_chunks só cobrem chunk já processado ───
if [ "${new_chunks:-0}" -gt 0 ]; then
  similar_age=$(( $(now_epoch) - $(mtime_of "$SIMILAR_STAMP") ))
  if [ "$similar_age" -gt "$SIMILAR_MIN_AGE_SECS" ]; then
    log "rebuild:similar start"
    npm run rebuild:similar >> "$LOG" 2>&1
    log "rebuild:similar done (exit $?)"
    date '+%Y-%m-%dT%H:%M:%S%z' > "$SIMILAR_STAMP"
  else
    log "rebuild:similar pulado (rodou há ${similar_age}s)"
  fi
fi

# ── Loop de aprendizado ─────────────────────────────────────────────────────
# Roda DEPOIS do ingest pra gradar queries da sessão anterior com o transcript
# já no grafo. Tem lock próprio; nunca falha o hook.
log "self-tune start"
npm run self-tune >> "$LOG" 2>&1
log "self-tune done (exit $?)"
exit 0
