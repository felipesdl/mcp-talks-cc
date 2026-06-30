# mcp-talks-cc

MCP local que indexa toda a memória do Claude Code (conversas + plans + todos + task memory) em Neo4j com busca vetorial. Permite que o Claude busque contexto cross-conversa via tools MCP.

## Stack

- **TypeScript/Node 22+** (ESM, `--experimental-strip-types`)
- **Neo4j 5.26 community** via docker compose (porta 7687 Bolt, 7474 Browser)
- **Embeddings local** via `@huggingface/transformers` — modelo `Xenova/bge-m3` (1024-dim, multilíngue pt/en, quantizado q8 ~150MB)
- **MCP SDK** `@modelcontextprotocol/sdk` stdio transport

## Setup

Atalho: `./scripts/install.sh` roda os passos 1-6 abaixo + registra o MCP + instala o hook de auto-ingest (idempotente). Veja [Instalar / reinstalar do zero](#instalar--reinstalar-do-zero). Os passos manuais abaixo ficam como referência/fallback.

```bash
# 1. dependencies
npm install

# 2. env (defaults já funcionam)
cp .env.example .env

# 3. start Neo4j (waits for healthy)
npm run infra:up

# 4. create constraints + vector index
npm run db:init

# 5. ingest everything (~5-15min depending on corpus + cold model load on first call)
npm run ingest -- --source=all

# 6. check counts
npm run db:stats
```

## Sources ingeridos

| Source | Path | Nodes |
|---|---|---|
| `conversations` | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `Project`, `Session`, `Message`, `ToolCall`, `Chunk` |
| `plans` | `~/.claude/plans/*.md` | `Plan`, `Chunk` |
| `todos` | `~/.claude/todos/*.json` | `Todo` |
| `tasks` | `<project>/.claude/tasks/<TICKET>-*/*.md` | `Project`, `TaskMemoryDoc`, `Chunk` |

`Chunk.sourceKind`: `conversation` (msgs user/assistant) | `tool_output` (tool_result <2000 chars) | `plan` | `task_memory`.

Ingestão é **incremental** — `~/.cache/mcp-talks-cc/checkpoint.json` guarda `mtime + sha256` por arquivo. Re-rodar `npm run ingest` pula arquivos inalterados. Use `--force` pra reingerir tudo.

## Auto-ingest (SessionStart hook)

O ingest roda sozinho a cada abertura de sessão do Claude Code. Um hook `SessionStart` em `~/.claude/settings.json` dispara `scripts/session-ingest.sh` em background (`async: true`, não atrasa o boot da sessão).

O wrapper:
- checa a porta Bolt (`nc -z localhost 7687`) antes — se o Neo4j estiver down, loga "skip" e sai sem pendurar (o driver não tem connect-timeout);
- roda `npm run ingest -- --source=all` (incremental);
- append com timestamp em `~/.cache/mcp-talks-cc/ingest.log`.

```bash
tail -f ~/.cache/mcp-talks-cc/ingest.log   # acompanhar
```

**Por que SessionStart e não cron/Stop/SessionEnd:** conversa nova só nasce enquanto uso o Claude, então abrir uma sessão é o momento certo de indexar as anteriores. `Stop` dispara a cada turno (frequente demais); `SessionEnd` não roda confiável quando fecho o terminal direto (SIGHUP); cron seria redundante (rodaria sem nada novo). Custo ocioso é baixo: o embedder é lazy, então um run sem nada novo nem carrega o modelo — só conexão Neo4j + stat/hash dos arquivos.

**Gap conhecido:** o transcript da sessão atual só entra no próximo SessionStart. Aceitável pro uso.

Instalado via `./scripts/install.sh` (passo 7) ou direto com `node scripts/install-hook.mjs` — ambos fazem merge sem sobrescrever hooks existentes.

## CLI

```bash
npm run ingest -- --source=conversations|plans|todos|tasks|all [--limit=N] [--force]
npm run search -- --query="..." --k=5    # CLI de teste de busca vetorial
npm run db:stats                          # counts por label
npm run mcp:start                         # roda o MCP server (stdio)
npm run mcp:inspect                       # MCP Inspector UI
```

## Tools MCP expostas

| Tool | Para que serve |
|---|---|
| `search_memory(query, k?, scope?, project?, since?)` | Busca semântica em todo corpus. `scope` aceita `conversation\|tool_output\|plan\|todo\|task_memory` |
| `get_session_transcript(sessionId, limit?)` | Transcript completo de uma sessão. Retorna `found: false` se sessionId não existe |
| `find_related_plans(query, k?)` | Restrita a `Plan` (~/.claude/plans/*.md) |
| `find_decisions(query, taskId?, k?)` | Sem `taskId`: só decisions/learnings. Com `taskId`: todos os kinds da task |
| `list_project_activity(project, since?)` | Estatísticas por projeto (Cypher puro, sem embed). Retorna `found: false` se project não existe |

Prompts:
- `recall_context(query, scope?)` — guia Claude a buscar memória antes de responder
- `extract_decision(taskId, topic?)` — orquestra find_decisions + transcript pra extrair decisão estruturada

Resources:
- `memory://stats` — counts por label
- `memory://schema` — referência: nodes, edges, vector index, Cypher exemplos

## Registro no Claude Code

Para usar o MCP dentro do Claude Code, registre o server. Forma mais segura via CLI. O `-s user` registra em escopo de usuário (global, vale em todos os projetos); sem ele o default é escopo `local`, que só anexa o server no diretório de onde o comando rodou:

```bash
claude mcp add memory -s user \
  -- node \
  --env-file=/ABSOLUTE/PATH/TO/mcp-talks-cc/.env \
  --experimental-strip-types \
  /ABSOLUTE/PATH/TO/mcp-talks-cc/src/mcp/server.ts
```

Ou cole o snippet de `claude-mcp-config.snippet.json` em `~/.claude.json` (root level — não em `settings.json` se este tiver hooks). Depois `/mcp` no Claude Code lista o server `memory` como conectado.

## Instalar / reinstalar do zero

Caminho único pra montar tudo (máquina nova, reset, config quebrada):

```bash
./scripts/install.sh
```

Idempotente — seguro re-rodar. Faz, em ordem:

1. `npm install`
2. `.env` (cria de `.env.example` se faltar; mantém o existente)
3. `npm run infra:up` (Neo4j via docker, espera healthy)
4. `npm run db:init` (constraints + vector index)
5. `npm run ingest -- --source=all` (1º ingest; incremental depois)
6. registra o MCP `memory` no Claude Code — só se ainda não estiver (`claude mcp get memory`)
7. instala o hook `SessionStart` de auto-ingest (`scripts/install-hook.mjs`) — merge sem clobber, backup em `~/.claude/settings.json.bak`
8. `chmod +x` no wrapper

No fim imprime onde fica o log e como verificar (`npm run db:stats`, `/mcp`).

## Schema Neo4j

```
(Project)-[:HAS_SESSION]->(Session)-[:HAS_MESSAGE]->(Message)-[:HAS_CHUNK]->(Chunk)
(Message)-[:REPLIES_TO]->(Message)          ← parentUuid
(Message)-[:INVOKED]->(ToolCall)            ← tool_use/tool_result blocks
(Plan)-[:HAS_CHUNK]->(Chunk)
(TaskMemoryDoc)-[:HAS_CHUNK]->(Chunk)
(Project)-[:HAS_TASK_MEMORY]->(TaskMemoryDoc)
(Session)-[:HAS_TODO]->(Todo)               ← linked via sessionId in filename
```

Vector index `chunks_embedding`: `Chunk.embedding` (1024d cosine).

## Segurança

Antes de embedar, redactor remove tokens/keys comuns (OpenAI/Anthropic/GitHub/Bearer/JWT/AWS keys + env-style secrets). Não é exaustivo — corpus deve permanecer local. Veja `src/ingest/redact.ts`.

## Limitações conhecidas (MVP)

- Embed cold-start (~30-60s primeira invocação por causa do bge-m3 q8). MCP server pré-carrega no boot.
- Tool calls (Bash outputs etc.) **não** são embedados — só ficam como nodes `ToolCall` rastreáveis via Cypher.
- LLM (síntese, re-rank) fora do MVP. Fase F opcional adicionaria via OpenRouter.

## Troubleshooting

- **`vector.dimensions mismatch`**: trocou de modelo e a dimensão difere de 1024. Ou ajuste `EMBED_DIM` no `.env` ou rode `npm run infra:reset && npm run db:init`.
- **MCP não aparece no `/mcp`**: cheque que o path em `~/.claude.json` é absoluto e que `npm run mcp:start` funciona direto no terminal.
- **bge-m3 download lento**: primeira chamada baixa o modelo (~150MB q8) pra `~/.cache/huggingface/`.
