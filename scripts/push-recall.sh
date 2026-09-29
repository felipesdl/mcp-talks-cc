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

for s in "$SOCK_DIR"/*.sock; do
  [ -S "$s" ] || continue
  pid="$(basename "$s" .sock)"
  kill -0 "$pid" 2>/dev/null || continue
  if OUT="$(printf '%s' "$INPUT" | curl -s --max-time 1 --unix-socket "$s" \
      -X POST --data-binary @- "http://mcp/${ROUTE}" 2>/dev/null)"; then
    [ -n "$OUT" ] && printf '%s\n' "$OUT"
    exit 0
  fi
done
exit 0
