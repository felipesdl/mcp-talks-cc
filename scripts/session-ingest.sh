#!/usr/bin/env bash
# Auto-ingest disparado pelo hook SessionStart do Claude Code.
# Roda incremental, em background, e pula se o Neo4j estiver down.
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${HOME}/.cache/mcp-talks-cc"
LOG="${LOG_DIR}/ingest.log"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR" || exit 0

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# Guard: o driver Neo4j não tem connect-timeout, então checamos a porta Bolt
# antes pra não pendurar o processo caso o container esteja parado.
if ! nc -z localhost 7687 2>/dev/null; then
  echo "$(ts) [session-ingest] neo4j down (7687 closed), skip" >> "$LOG"
  exit 0
fi

# Lock: evita empilhar ingests concorrentes. Cada sessão Claude dispara este
# hook; sem o lock, abrir várias sessões acumula processos node (cada um
# carrega o modelo de embedding ~1.5GB). flock -n pula se já houver um rodando.
LOCK="${LOG_DIR}/ingest.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(ts) [session-ingest] já tem ingest rodando, skip" >> "$LOG"
  exit 0
fi

echo "$(ts) [session-ingest] start" >> "$LOG"
npm run ingest -- --source=all >> "$LOG" 2>&1
code=$?
echo "$(ts) [session-ingest] done (exit $code)" >> "$LOG"

# Loop de aprendizado: roda DEPOIS do ingest pra gradar queries da sessão
# anterior com o transcript já no grafo. Tem lock próprio; nunca falha o hook.
echo "$(ts) [self-tune] start" >> "$LOG"
npm run self-tune >> "$LOG" 2>&1
echo "$(ts) [self-tune] done (exit $?)" >> "$LOG"
exit 0
