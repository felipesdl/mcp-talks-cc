#!/usr/bin/env bash
# Auto-ingest disparado pelo hook SessionStart do Claude Code (async).
# Roda incremental, sobe o Neo4j se estiver parado, e grava health.json em
# TODOS os caminhos de saída (o session-primer.sh lê isso pra avisar staleness).
set -uo pipefail

# A distilação chama `claude -p`, que dispara SessionStart de novo. Sem esta
# guarda cada distilação abriria outro ingest (recursão).
[ "${MCP_TALKS_IN_DISTILL:-}" = "1" ] && exit 0

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${HOME}/.cache/mcp-talks-cc"
LOG="${LOG_DIR}/ingest.log"
HEALTH="${LOG_DIR}/health.json"
LOCK_DIR="${LOG_DIR}/ingest.lock.d"
SIMILAR_STAMP="${LOG_DIR}/last-similar.stamp"
LOCK_STALE_SECS=3600      # lock mais velho que isso = processo morto
SIMILAR_MIN_AGE_SECS=72000 # rebuild:similar no máx 1x/20h

# Tudo que este hook roda é background: o localEmbedder limita as threads do
# onnx a metade dos cores pra não travar a máquina a cada sessão aberta.
export MCP_TALKS_BG=1

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR" || exit 0

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) [session-ingest] $*" >> "$LOG"; }
now_epoch() { date +%s; }

# mtime portátil. GNU primeiro: no Linux `stat -f` é "filesystem status", joga
# lixo no stdout antes de falhar e esse lixo quebrava a aritmética do caller.
# No macOS `stat -c` falha limpo (sem stdout), então a ordem inversa é segura.
mtime_of() {
  local m
  m="$(stat -c %Y "$1" 2>/dev/null)" || m="$(stat -f %m "$1" 2>/dev/null)" || m=0
  case "$m" in '' | *[!0-9]*) m=0 ;; esac
  echo "$m"
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

# Onde o Neo4j mora vem do NEO4J_URI (env ganha do .env, como no `node
# --env-file`; default igual ao src/config.ts). Com localhost:7687 fixo, URI
# remota ou porta trocada virava "down" falso e o hook subia Docker à toa.
NEO4J_URI_VAL="${NEO4J_URI:-}"
if [ -z "$NEO4J_URI_VAL" ] && [ -f "${PROJECT_DIR}/.env" ]; then
  NEO4J_URI_VAL="$(sed -nE 's/^NEO4J_URI=["]?([^"[:space:]]*).*/\1/p' "${PROJECT_DIR}/.env" | tail -1)"
fi
[ -z "$NEO4J_URI_VAL" ] && NEO4J_URI_VAL="bolt://localhost:7687"
hostport="${NEO4J_URI_VAL#*://}"
hostport="${hostport%%/*}"
hostport="${hostport##*@}"
NEO4J_HOST="${hostport%:*}"
NEO4J_PORT="${hostport##*:}"
[ "$NEO4J_PORT" = "$hostport" ] && NEO4J_PORT=7687 # URI sem porta
NEO4J_HOST="${NEO4J_HOST#[}"
NEO4J_HOST="${NEO4J_HOST%]}"
case "$NEO4J_HOST" in
  localhost | 127.0.0.1 | ::1 | 0.0.0.0) NEO4J_LOCAL=1 ;;
  *) NEO4J_LOCAL=0 ;;
esac

# nc não vem em toda distro (Debian slim, Arch base). Sem fallback, ausência do
# binário virava "neo4j-down" permanente com o banco de pé.
neo4j_up() {
  if command -v nc >/dev/null 2>&1; then
    nc -z "$NEO4J_HOST" "$NEO4J_PORT" 2>/dev/null
  else
    (exec 3<>"/dev/tcp/${NEO4J_HOST}/${NEO4J_PORT}") 2>/dev/null
  fi
}

# timeout portátil: o macOS não traz `timeout` (só `gtimeout` via coreutils).
# Sem nenhum dos dois roda sem teto, como antes.
TO=""
command -v timeout >/dev/null 2>&1 && TO="timeout"
command -v gtimeout >/dev/null 2>&1 && TO="gtimeout"
with_timeout() {
  local secs="$1"
  shift
  if [ -n "$TO" ]; then "$TO" "$secs" "$@"; else "$@"; fi
}

# Context do Docker onde o container do Neo4j mora, anotado pelo próprio hook
# quando acha o banco de pé. "-" = fora do Docker (nativo); vazio = nunca visto.
RUNTIME_FILE="${LOG_DIR}/neo4j-runtime"
CONTAINER="$(sed -nE 's/^[[:space:]]*container_name:[[:space:]]*([^[:space:]#]+).*/\1/p' docker-compose.yml 2>/dev/null | head -1)"
[ -z "$CONTAINER" ] && CONTAINER="mcp-talks-neo4j"

# Comando docker apontado pro context do Neo4j. Array, não função: `timeout`
# não executa função do shell.
DK_CTX=""
set_dk() {
  if [ -n "$DK_CTX" ]; then DK=(docker --context "$DK_CTX"); else DK=(docker); fi
}
set_dk

docker_up() { with_timeout 10 "${DK[@]}" info >/dev/null 2>&1; }

# Endpoint do daemon do context escolhido. Sem context, DOCKER_HOST ganha do
# context ativo, igual ao próprio CLI.
docker_endpoint() {
  if [ -n "$DK_CTX" ]; then
    with_timeout 5 docker context inspect "$DK_CTX" --format '{{.Endpoints.docker.Host}}' 2>/dev/null
  elif [ -n "${DOCKER_HOST:-}" ]; then
    echo "$DOCKER_HOST"
  else
    with_timeout 5 docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null
  fi
}

# Comando que sobe o runtime por trás do endpoint. Genérico de propósito: o
# hook não assume OrbStack nem Docker Desktop, deduz pelo socket do context.
# MCP_TALKS_DOCKER_START (env ou .env) ganha de tudo, pra runtime que a
# heurística não conhece. Daemon de sistema no Linux (/var/run/docker.sock)
# precisa de root e já sobe no boot, então fica de fora.
docker_start_cmd() {
  local custom ep
  custom="${MCP_TALKS_DOCKER_START:-}"
  if [ -z "$custom" ] && [ -f "${PROJECT_DIR}/.env" ]; then
    custom="$(sed -nE 's/^MCP_TALKS_DOCKER_START=(.*)$/\1/p' "${PROJECT_DIR}/.env" | tail -1)"
    custom="${custom%\"}"
    custom="${custom#\"}"
  fi
  if [ -n "$custom" ]; then
    echo "$custom"
    return
  fi
  ep="$(docker_endpoint)"
  case "$ep" in
    */.orbstack/*) command -v orb >/dev/null 2>&1 && echo "orb start" ;;
    */.colima/*) command -v colima >/dev/null 2>&1 && echo "colima start" ;;
    */.rd/*) command -v rdctl >/dev/null 2>&1 && echo "rdctl start" ;;
    *podman*) command -v podman >/dev/null 2>&1 && echo "podman machine start" ;;
    */run/user/*) command -v systemctl >/dev/null 2>&1 && echo "systemctl --user start docker" ;;
    *)
      # Docker Desktop: ~/.docker/run/docker.sock ou /var/run/docker.sock no macOS
      if [ "$(uname -s)" = "Darwin" ] && [ -d /Applications/Docker.app ]; then
        echo "open -ga Docker"
      fi
      ;;
  esac
}

# Com o banco de pé, anota em qual context o container está. Só pergunta pra
# daemon que já responde (o do Neo4j responde, ele está de pé): nunca sobe nada.
# Nenhum context com o container = Neo4j fora do Docker.
record_runtime() {
  local ctx found=""
  if command -v docker >/dev/null 2>&1; then
    if [ -n "${DOCKER_HOST:-}" ]; then
      with_timeout 5 docker ps -q --filter "name=^${CONTAINER}$" 2>/dev/null | grep -q . && found="@DOCKER_HOST"
    else
      for ctx in $(with_timeout 5 docker context ls -q 2>/dev/null); do
        if with_timeout 5 docker --context "$ctx" ps -q --filter "name=^${CONTAINER}$" 2>/dev/null | grep -q .; then
          found="$ctx"
          break
        fi
      done
    fi
  fi
  echo "${found:--}" > "$RUNTIME_FILE" 2>/dev/null
}

# ── Neo4j: sobe em vez de desistir ──────────────────────────────────────────
# O driver não tem connect-timeout, então checamos a porta Bolt antes.
# Sessão aberta logo depois do boot pega o runtime do Docker ainda parado (sem
# start no login): sobe ele primeiro, senão o compose falha e o primer alerta.
# Só mexe no runtime onde o Neo4j mora: remoto ou nativo não liga daemon nenhum.
DOCKER_TRIED=0
if ! neo4j_up; then
  RT="$(cat "$RUNTIME_FILE" 2>/dev/null || true)"
  if [ "$NEO4J_LOCAL" -eq 0 ]; then
    log "neo4j remoto (${NEO4J_HOST}:${NEO4J_PORT}) fora do ar, não sobe nada local"
  elif [ "$RT" = "-" ]; then
    log "neo4j local fora do Docker (nativo) e fora do ar, não mexe em daemon"
  elif ! command -v docker >/dev/null 2>&1; then
    log "neo4j down e docker ausente no PATH"
  else
    DOCKER_TRIED=1
    # sem anotação (instalação nova) vai no context ativo, que é onde o compose
    # criaria o container; context anotado e depois removido também
    case "$RT" in
      "" | @DOCKER_HOST) DK_CTX="" ;;
      *) DK_CTX="$RT" ;;
    esac
    if [ -n "$DK_CTX" ] && ! with_timeout 5 docker context inspect "$DK_CTX" >/dev/null 2>&1; then
      DK_CTX=""
    fi
    set_dk
    if ! docker_up; then
      start_cmd="$(docker_start_cmd)"
      if [ -n "$start_cmd" ]; then
        log "docker daemon fora (context: ${DK_CTX:-ativo}), subindo runtime: ${start_cmd}"
        with_timeout 120 sh -c "$start_cmd" >> "$LOG" 2>&1
        # `open -ga Docker` volta na hora; o daemon leva até ~1min pra responder
        for _ in $(seq 1 45); do
          docker_up && break
          sleep 2
        done
      else
        log "docker daemon fora e runtime não identificado (endpoint: $(docker_endpoint)); defina MCP_TALKS_DOCKER_START no .env"
      fi
    fi
    if docker_up; then
      log "neo4j down (${NEO4J_HOST}:${NEO4J_PORT} fechada), subindo container (context: ${DK_CTX:-ativo})"
      with_timeout 240 "${DK[@]}" compose up -d --wait >> "$LOG" 2>&1
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        neo4j_up && break
        sleep 2
      done
    fi
  fi
fi

if ! neo4j_up; then
  log "neo4j indisponível, skip"
  if [ "$DOCKER_TRIED" -eq 1 ] && ! docker_up; then
    write_health "docker-down" "daemon do docker nao respondeu apos tentativa de start"
  else
    write_health "neo4j-down" "${NEO4J_HOST}:${NEO4J_PORT} fechada apos tentativa de up"
  fi
  exit 0
fi
[ "$NEO4J_LOCAL" -eq 1 ] && record_runtime

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
  # NÃO grava health: quem tem o lock grava o status final logo depois. Gravar
  # lock-held aqui virava [ALERTA] falso no primer da sessão seguinte (abrir
  # sessões em sequência, /clear) e o Claude reagia rodando outro ingest à toa.
  # Lock órfão (pid morto) não cai aqui: acquire_lock rouba por liveness.
  log "já tem ingest rodando (lock ativo), skip"
  exit 0
else
  # Fail-open: guard quebrado nunca pode virar skip permanente. Guard que falha
  # fechado (ex.: binário de lock ausente no PATH) mata o ingest em silêncio.
  log "AVISO: lockdir não criável e ausente, seguindo sem lock (fail-open)"
fi

# ── Ingest ──────────────────────────────────────────────────────────────────
log "start (lock=${LOCK_HELD})"
# Template com X explícito: `-t prefixo` puro é só BSD, o GNU sai com exit 1.
OUT="$(mktemp "${TMPDIR:-/tmp}/mcp-talks-ingest.XXXXXX")" || OUT="${LOG_DIR}/ingest.out"
npm run ingest -- --source=all > "$OUT" 2>&1
code=$?
cat "$OUT" >> "$LOG"
# soma de `chunks: N` de todas as sources pra decidir se vale rebuild:similar
new_chunks="$(sed -nE 's/.*chunks:[[:space:]]*([0-9]+).*/\1/p' "$OUT" | awk '{s+=$1} END {print s+0}')"
# arquivo que sumiu (vanished) é esperado; failed é erro de leitura que não
# derrubou o run mas precisa aparecer no health em vez de sumir em silêncio.
read_failed="$(sed -nE 's/.*[^[:alpha:]]failed:[[:space:]]*([0-9]+).*/\1/p' "$OUT" | awk '{s+=$1} END {print s+0}')"
rm -f "$OUT"
log "done (exit $code, chunks novos: ${new_chunks}, leituras falhas: ${read_failed})"

if [ "$code" -eq 0 ]; then
  if [ "$read_failed" -gt 0 ]; then
    write_health "ok" "chunks=${new_chunks} read_failed=${read_failed} ver ingest.log"
  else
    write_health "ok" "chunks=${new_chunks}"
  fi
else
  write_health "failed" "ingest exit ${code}"
fi

# ── Classificação de valor: chunk novo entra sem valueScore ─────────────────
# Sem isto o conteúdo recente fica neutro e a demoção de narração só vale pro
# acervo velho, ou seja o benefício decai com o tempo. Roda direto, sem throttle:
# o predicado por versão só toca o que falta e a varredura custa ~12s no acervo
# inteiro. Fail-open, como o resto do hook.
#
# O modelo mora no cache, não no repo: máquina nova ou cache limpo fica sem ele,
# e pular em silêncio travava também o distill (pendingSessions exige chunk com
# valueScore). Então, sem modelo, treina aqui (~20s, o hook é async). --strict
# não grava modelo que não separa (grafo pequeno); aí tenta de novo na próxima.
VALUE_MODEL="$HOME/.cache/mcp-talks-cc/value-model.json"
trained_now=0
if [ ! -f "$VALUE_MODEL" ]; then
  log "train:value start (sem value-model.json)"
  npm run train:value -- --apply --strict >> "$LOG" 2>&1
  tcode=$?
  log "train:value done (exit ${tcode})"
  [ "$tcode" -eq 0 ] && [ -f "$VALUE_MODEL" ] && trained_now=1
fi
# Modelo recém-treinado tem versão nova: classifica o acervo inteiro mesmo sem
# chunk novo, senão o que entrou sem score fica sem até a próxima sessão.
if [ "${new_chunks:-0}" -gt 0 ] || [ "$trained_now" -eq 1 ]; then
  if [ -f "$VALUE_MODEL" ]; then
    log "classify:chunks start"
    npm run classify:chunks -- --apply >> "$LOG" 2>&1
    log "classify:chunks done (exit $?)"
  else
    log "classify:chunks pulado (sem value-model.json)"
  fi
fi

# ── Entidades: task e arquivo da sessão que acabou de entrar ────────────────
# Idempotente (MERGE + SET de valor absoluto) e custa ~3s sobre o acervo
# inteiro, então roda sem throttle. Fail-open.
if [ "${new_chunks:-0}" -gt 0 ]; then
  log "build:entities start"
  npm run build:entities -- --apply >> "$LOG" 2>&1
  log "build:entities done (exit $?)"
  # Vínculo task -> epic, parte sem custo: linha [task] do pré-prompt + regex.
  # A parte com Haiku roda no bloco opt-in da distilação, mais abaixo.
  log "link:epics (sem LLM) start"
  npm run link:epics -- --apply --no-llm >> "$LOG" 2>&1
  log "link:epics (sem LLM) done (exit $?)"
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

# ── Distilação: sessões fechadas viram nós Decision (src/distill/) ─────────
# Depois do self-tune de propósito: cada sessão custa ~15-30s de claude -p, e
# o primer desta rodada não pode esperar por isso (a próxima já pega). Teto
# baixo por run, em duas filas:
#   1. recentes (últimos 7 dias), até DISTILL_N: o que está em uso fica em dia;
#   2. backlog, até DISTILL_BACKLOG_N, da MAIS ANTIGA pra mais nova: o
#      histórico vai sendo destilado sem mexer no que é recente.
# MCP_TALKS_DISTILL_PER_RUN=0 desliga tudo; MCP_TALKS_DISTILL_BACKLOG_PER_RUN=0 só o backlog.
DISTILL_N="${MCP_TALKS_DISTILL_PER_RUN:-5}"
DISTILL_BACKLOG_N="${MCP_TALKS_DISTILL_BACKLOG_PER_RUN:-3}"
# OPT-IN: gasta tokens da conta de quem roda. Liga com MCP_TALKS_DISTILL=1 no
# .env (ou no ambiente). Quem só atualizou o repo não passa a pagar sem saber.
DISTILL_ON="${MCP_TALKS_DISTILL:-}"
if [ -z "$DISTILL_ON" ] && [ -f "${PROJECT_DIR}/.env" ]; then
  DISTILL_ON="$(sed -nE 's/^MCP_TALKS_DISTILL=([^[:space:]#]*).*/\1/p' "${PROJECT_DIR}/.env" | tail -1)"
fi
# Vínculo task -> epic com Haiku: opt-in próprio, bem mais barato que a
# distilação (~2k tokens e só em sessão que cita epic). Sem resposta (linha
# ausente), segue a distilação: quem já pagava por ela não muda nada.
EPIC_ON="${MCP_TALKS_EPIC_LLM:-}"
if [ -z "$EPIC_ON" ] && [ -f "${PROJECT_DIR}/.env" ]; then
  EPIC_ON="$(sed -nE 's/^MCP_TALKS_EPIC_LLM=([^[:space:]#]*).*/\1/p' "${PROJECT_DIR}/.env" | tail -1)"
fi
[ -z "$EPIC_ON" ] && EPIC_ON="$DISTILL_ON"
LINK_N="${MCP_TALKS_EPIC_LINK_PER_RUN:-5}"
DO_DISTILL=0; DO_LINK=0
[ "$DISTILL_ON" = "1" ] && [ "$DISTILL_N" -gt 0 ] 2>/dev/null && DO_DISTILL=1
[ "$EPIC_ON" = "1" ] && [ "$LINK_N" -gt 0 ] 2>/dev/null && DO_LINK=1
[ "$DO_DISTILL" -eq 0 ] && log "distill desligado (MCP_TALKS_DISTILL=1 no .env liga)"
[ "$DO_LINK" -eq 0 ] && log "link:epics com Haiku desligado (MCP_TALKS_EPIC_LLM=1 no .env liga)"
if [ $(( DO_DISTILL + DO_LINK )) -gt 0 ] && command -v claude >/dev/null 2>&1; then
  # Solta o lock do ingest ANTES: a distilação leva minutos, e com o lock preso
  # toda sessão aberta nesse meio tempo gravava health=lock-held, o que virava
  # [ALERTA] falso no primer da sessão seguinte. Lock próprio (mkdir atômico)
  # só pra não ter 2 runs chamando o claude pras mesmas sessões.
  rm -rf "$LOCK_DIR" 2>/dev/null
  trap - EXIT INT TERM
  DISTILL_LOCK="${LOG_DIR}/distill.lock.d"
  if [ -d "$DISTILL_LOCK" ] && [ $(( $(now_epoch) - $(mtime_of "$DISTILL_LOCK") )) -gt 1800 ]; then
    rm -rf "$DISTILL_LOCK" 2>/dev/null # distilação morta há 30min+
  fi
  if mkdir "$DISTILL_LOCK" 2>/dev/null; then
    trap 'rm -rf "$DISTILL_LOCK" 2>/dev/null || true' EXIT INT TERM
    # Antes do distill: chamada menor (~2k tokens, só trechos em volta de
    # "épico/parent"), e o vínculo é o que faz a regra cruzar repos.
    if [ "$DO_LINK" -eq 1 ]; then
      log "link:epics start (limit $LINK_N)"
      npm run link:epics -- --apply --limit="$LINK_N" >> "$LOG" 2>&1
      log "link:epics done (exit $?)"
    fi
    if [ "$DO_DISTILL" -eq 1 ]; then
      log "distill start (limit $DISTILL_N)"
      npm run distill -- --limit="$DISTILL_N" --recent-days=7 >> "$LOG" 2>&1
      log "distill done (exit $?)"
      if [ "$DISTILL_BACKLOG_N" -gt 0 ] 2>/dev/null; then
        log "distill backlog start (limit $DISTILL_BACKLOG_N, mais antigas primeiro)"
        npm run distill -- --limit="$DISTILL_BACKLOG_N" --oldest-first >> "$LOG" 2>&1
        log "distill backlog done (exit $?)"
      fi
    fi
  else
    log "distill/link pulado (outro run com claude rodando)"
  fi
fi
exit 0
