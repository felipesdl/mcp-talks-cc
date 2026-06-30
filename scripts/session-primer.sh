#!/usr/bin/env bash
# Hook SessionStart SÍNCRONO: injeta o primer aprendido (profile do self-tune)
# como additionalContext. Puro bash, sem Node/Neo4j — o primer.json já vem no
# envelope final {"hookSpecificOutput":{...}} pré-escapado pelo builder JS.
set -u

PRIMER="${HOME}/.cache/mcp-talks-cc/primer.json"

# sem primer ainda (cold start) -> não injeta nada
[ -s "$PRIMER" ] || exit 0

# staleness guard: primer com >14 dias provavelmente reflete trabalho velho
if [ -n "$(find "$PRIMER" -mtime +14 2>/dev/null)" ]; then
  exit 0
fi

cat "$PRIMER"
