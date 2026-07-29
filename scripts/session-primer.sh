#!/usr/bin/env bash
# Hook SessionStart SÍNCRONO. Duas funções:
#   1. registra a sessão (session_id + cwd) em sessions/<slug>.json, porque o
#      Claude Code não passa o session id pro processo MCP e sem isso o grader
#      do self-tune não consegue casar busca com resposta (echo sempre nulo).
#   2. injeta o primer aprendido (profile do self-tune) como additionalContext,
#      com aviso quando o ingest está atrasado ou falhando.
# Puro bash, sem Node/Neo4j: o primer.json já vem pré-escapado do builder JS.
set -u

CACHE="${HOME}/.cache/mcp-talks-cc"
PRIMER="${CACHE}/primer.json"
HEALTH="${CACHE}/health.json"
SESSIONS="${CACHE}/sessions"
STALE_SECS=172800 # 48h sem ingest bem-sucedido = memória desatualizada

# ── 1) registro da sessão ───────────────────────────────────────────────────
INPUT="$(cat 2>/dev/null || true)"
SID="$(printf '%s' "$INPUT" | sed -nE 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -1)"
CWD="$(printf '%s' "$INPUT" | sed -nE 's/.*"cwd"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -1)"
[ -z "$CWD" ] && CWD="$PWD"

if [ -n "$SID" ]; then
  # slug igual ao cwdSlug() de src/mcp/callerSession.ts
  SLUG="$(printf '%s' "$CWD" | tr -c '[:alnum:]' '-')"
  mkdir -p "$SESSIONS" 2>/dev/null
  printf '{"sessionId":"%s","project":"%s","updatedEpoch":%s}\n' \
    "$SID" "$CWD" "$(date +%s)" > "${SESSIONS}/${SLUG}.json" 2>/dev/null
  # limpa registros com mais de 7 dias
  find "$SESSIONS" -name '*.json' -mtime +7 -delete 2>/dev/null
fi

# ── 2) aviso de saúde do ingest ─────────────────────────────────────────────
# Texto ASCII e sem os caracteres | & " \ porque entra num sed sobre JSON.
WARN=""
if [ -s "$HEALTH" ]; then
  STATUS="$(sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$HEALTH" | head -1)"
  LAST_OK="$(sed -nE 's/.*"lastOkEpoch"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$HEALTH" | head -1)"
  [ -z "$LAST_OK" ] && LAST_OK=0
  AGE=$(( $(date +%s) - LAST_OK ))
  if [ "$LAST_OK" -eq 0 ] || [ "$AGE" -gt "$STALE_SECS" ]; then
    DAYS=$(( AGE / 86400 ))
    WARN="[ALERTA mcp-talks-cc] memoria DESATUALIZADA: ultimo ingest ok ha ${DAYS}d (status atual: ${STATUS}). Avise o user na primeira resposta e sugira rodar npm run ingest -- --source=all em ~/Documents/code/mcp-talks-cc. Resultados de search_memory nao cobrem conversas recentes. "
  elif [ "$STATUS" != "ok" ]; then
    WARN="[ALERTA mcp-talks-cc] ultimo ingest terminou em status ${STATUS}; conferir ~/.cache/mcp-talks-cc/ingest.log. "
  fi
else
  WARN="[ALERTA mcp-talks-cc] sem health.json: o hook de ingest nunca completou nesta maquina. Conferir ~/.cache/mcp-talks-cc/ingest.log. "
fi

# ── 3) saída ────────────────────────────────────────────────────────────────
PRIMER_OK=0
if [ -s "$PRIMER" ]; then
  # primer com mais de 14 dias reflete trabalho velho; o ALERTA não expira.
  if [ -z "$(find "$PRIMER" -mtime +14 2>/dev/null)" ]; then
    PRIMER_OK=1
  fi
fi

if [ "$PRIMER_OK" -eq 1 ]; then
  if [ -n "$WARN" ]; then
    sed -e "s|\"additionalContext\":\"|\"additionalContext\":\"${WARN}|" "$PRIMER"
  else
    cat "$PRIMER"
  fi
  exit 0
fi

if [ -n "$WARN" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$WARN"
fi
exit 0
