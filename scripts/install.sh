#!/usr/bin/env bash
# Setup/reinstall idempotente do mcp-talks-cc.
# Roda tudo do zero: deps -> docker -> schema -> 1o ingest -> registro MCP -> hook.
# Cada passo é seguro pra re-executar.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

step() { echo; echo "==> $1"; }

step "1/8 npm install"
npm install

step "2/8 .env"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "  .env criado a partir de .env.example — revise segredos se necessário."
else
  echo "  .env já existe, mantido."
fi

step "3/8 Neo4j (docker compose, espera healthy)"
npm run infra:up

step "4/8 schema (constraints + vector index)"
npm run db:init

step "5/8 ingest inicial (--source=all, incremental nas próximas vezes)"
npm run ingest -- --source=all

step "6/8 registro MCP no Claude Code"
if claude mcp get memory >/dev/null 2>&1; then
  echo "  server 'memory' já registrado, mantido."
else
  claude mcp add memory -s user \
    -- node \
    --env-file="${PROJECT_DIR}/.env" \
    --experimental-strip-types \
    "${PROJECT_DIR}/src/mcp/server.ts"
  echo "  server 'memory' registrado."
fi

step "7/8 hook SessionStart (auto-ingest)"
node "${PROJECT_DIR}/scripts/install-hook.mjs"

step "8/8 permissões"
chmod +x "${PROJECT_DIR}/scripts/session-ingest.sh"
echo "  scripts/session-ingest.sh executável."

echo
echo "================================================================"
echo "Setup completo."
echo "  Auto-ingest: dispara a cada SessionStart, log em ~/.cache/mcp-talks-cc/ingest.log"
echo "  Verificar grafo:  npm run db:stats"
echo "  Verificar MCP:    /mcp no Claude Code (server 'memory' conectado)"
echo "================================================================"
