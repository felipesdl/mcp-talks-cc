#!/usr/bin/env bash
# Hook de push do mcp-talks-cc. Um script, dois eventos:
#   push-recall.sh prompt  -> UserPromptSubmit: ponteiro de memória pro prompt
#   push-recall.sh file    -> PostToolUse (Read|Edit|Write): histórico do arquivo
#
# O trabalho pesado (embedding, Neo4j, gate, dedup) roda no MCP server já
# quente, via unix socket (src/mcp/warmSocket.ts). Aqui só repassa o JSON do
# hook e imprime o que voltar. O server devolve o JSON de saída pronto, ou nada.
#
# FAIL-OPEN: sem curl, sem server vivo, timeout ou erro = sai 0 sem imprimir.
# Hook de prompt que falha fechado travaria toda mensagem do user.
set -u

# claude -p da distilação não recebe primer nem push
[ "${MCP_TALKS_IN_DISTILL:-}" = "1" ] && exit 0

ROUTE="${1:-prompt}"
CACHE="${HOME}/.cache/mcp-talks-cc"
SOCK_DIR="${CACHE}/sock"
SESSIONS="${CACHE}/sessions"

INPUT="$(cat 2>/dev/null || true)"
[ -z "$INPUT" ] && exit 0

# Refresca o registro da sessão chamadora a cada prompt: com 2 sessões no mesmo
# cwd, o SessionStart da segunda sobrescrevia o da primeira, e o MCP da primeira
# passava a logar com o sessionId errado. Última sessão ativa vence.
if [ "$ROUTE" = "prompt" ]; then
  SID="$(printf '%s' "$INPUT" | sed -nE 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -1)"
  CWD="$(printf '%s' "$INPUT" | sed -nE 's/.*"cwd"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -1)"
  if [ -n "$SID" ] && [ -n "$CWD" ]; then
    SLUG="$(printf '%s' "$CWD" | tr -c '[:alnum:]' '-')"
    mkdir -p "$SESSIONS" 2>/dev/null
    printf '{"sessionId":"%s","project":"%s","updatedEpoch":%s}\n' \
      "$SID" "$CWD" "$(date +%s)" > "${SESSIONS}/${SLUG}.json" 2>/dev/null
  fi
fi

command -v curl >/dev/null 2>&1 || exit 0
[ -d "$SOCK_DIR" ] || exit 0

# Prazo TOTAL, não por socket: cada sessão aberta tem o próprio server, e com a
# máquina em swap vários demoram >1s. Com 1s por socket, 3 lentos seguidos já
# estouravam o timeout de 3s do hook. Server saudável responde em <850ms
# (BUDGET_MS em warmSocket.ts), então 1 tentativa cheia + sobra cabe aqui.
# Sobra ~0,5s pro overhead de bash/curl em swap (medido: 2s de prazo = 2,5s).
DEADLINE_MS=1700
PER_TRY_MS=1000
SPENT_MS=0
# pid do último server que respondeu: tenta ele primeiro. É o que já tem o
# bge-m3 quente; a ordem do glob é alfabética e acertava server frio.
LAST_FILE="${SOCK_DIR}/last"

try_sock() {
  local s="$1" pid left mt res rc t sec frac
  [ -S "$s" ] || return 1
  pid="$(basename "$s" .sock)"
  kill -0 "$pid" 2>/dev/null || return 1
  left=$((DEADLINE_MS - SPENT_MS))
  [ "$left" -lt 150 ] && return 1
  mt=$PER_TRY_MS
  [ "$left" -lt "$mt" ] && mt=$left
  res="$(printf '%s' "$INPUT" | curl -s -w '\n%{time_total}' \
    --max-time "$(printf '%d.%03d' $((mt / 1000)) $((mt % 1000)))" \
    --unix-socket "$s" -X POST --data-binary @- "http://mcp/${ROUTE}" 2>/dev/null)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    res="${res%$'\n'*}"
    [ -n "$res" ] && printf '%s\n' "$res"
    if [ "$(cat "$LAST_FILE" 2>/dev/null)" != "$pid" ]; then
      printf '%s' "$pid" > "${LAST_FILE}.$$" 2>/dev/null && mv -f "${LAST_FILE}.$$" "$LAST_FILE" 2>/dev/null
    fi
    exit 0
  fi
  # time_total do curl ("1.001234") em ms; sem ele, conta a tentativa cheia
  t="${res##*$'\n'}"
  case "$t" in
    [0-9]*.[0-9]*)
      sec="${t%%.*}"
      frac="${t#*.}000"
      SPENT_MS=$((SPENT_MS + 10#$sec * 1000 + 10#${frac:0:3}))
      ;;
    *) SPENT_MS=$((SPENT_MS + mt)) ;;
  esac
  return 1
}

LAST="$(cat "$LAST_FILE" 2>/dev/null)"
[ -n "$LAST" ] && try_sock "${SOCK_DIR}/${LAST}.sock"
for s in "$SOCK_DIR"/*.sock; do
  [ "$s" = "${SOCK_DIR}/${LAST}.sock" ] && continue
  try_sock "$s"
done
exit 0
