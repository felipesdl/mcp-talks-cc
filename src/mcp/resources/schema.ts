import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withSession } from '../../neo4j/driver.ts';

/**
 * Inventário de nós e arestas lido do banco, não escrito à mão.
 *
 * A versão anterior era 92 linhas de markdown fixo, e já estava errada antes de
 * qualquer mudança nova: documentava `HAS_TODO`, que nunca produziu uma aresta
 * sequer, e descrevia o score como `RRF: 1/(60+rank_vec) + 1/(60+rank_bm25)`, substituído por RRF.
 * Doc de schema mantida à mão drifta; gerar é a única forma de não voltar a
 * mentir. O glossário semântico abaixo continua escrito à mão porque ISSO o
 * banco não sabe dizer.
 */
async function liveInventory(): Promise<string> {
  try {
    return await withSession(async (s) => {
      const nodes = await s.run(
        `CALL db.labels() YIELD label
         CALL (label) { WITH label MATCH (n) WHERE label IN labels(n) RETURN count(n) AS n }
         RETURN label, n ORDER BY n DESC`,
      );
      const edges = await s.run(
        `CALL db.relationshipTypes() YIELD relationshipType AS t
         CALL (t) { WITH t MATCH ()-[r]->() WHERE type(r) = t RETURN count(r) AS n }
         RETURN t, n ORDER BY n DESC`,
      );
      const fmt = (rs: { get: (k: string) => unknown }[], a: string, b: string): string =>
        rs.map((r) => `- ${String(r.get(a))} — ${String(r.get(b))}`).join('\n');
      return [
        '## Nodes (live count)',
        fmt(nodes.records, 'label', 'n'),
        '',
        '## Edges (live count)',
        fmt(edges.records, 't', 'n'),
      ].join('\n');
    });
  } catch {
    return '_(inventário indisponível: Neo4j fora do ar)_';
  }
}

const SCHEMA_DOC = `# mcp-talks-cc — Neo4j schema

## Nodes
- Project { path, name, lastIndexed }                  — one per cwd
- Session { id, projectPath, startedAt, endedAt,
            messageCount, gitBranch, version }         — one per JSONL file
- Message { uuid, sessionId, role, timestamp,
            parentUuid, text }                         — one per user/assistant event
- ToolCall { id, name, outputSnippet, timestamp }      — extracted from tool_use/tool_result blocks
- Chunk { id, text, embedding (vec 1024 cosine),
          ordinal, sourceKind, projectPath,
          sessionId, timestamp }                       — embeddable unit
- Plan { path, slug, createdAt }                       — ~/.claude/plans/*.md
- Todo { ... } :Orphan                                — fonte dormente: ~/.claude/todos sumiu do disco;
                                                        os 72 nós referenciam sessões inexistentes
- Task { key, prefix, sessionCount,
         firstSeenAt, lastSeenAt }                    — EDC-3197 etc, da branch e do texto
- File { key, repo, path, ext, sessionCount, idf }    — arquivo tocado, do input do ToolCall
- TaskMemoryDoc { path, taskId, kind, projectPath,
                  lastModified }                       — <project>/.claude/tasks/ABC-XXXX/*.md

## Edges
- (Project)-[:HAS_SESSION]->(Session)
- (Session)-[:HAS_MESSAGE]->(Message)
- (Message)-[:REPLIES_TO]->(Message)        — via parentUuid
- (Message)-[:HAS_CHUNK]->(Chunk)
- (Message)-[:INVOKED]->(ToolCall)
- (ToolCall)-[:HAS_CHUNK]->(Chunk)          — only when tool output < 2k chars
- (Plan)-[:HAS_CHUNK]->(Chunk)
- (TaskMemoryDoc)-[:HAS_CHUNK]->(Chunk)
- (Project)-[:HAS_TASK_MEMORY]->(TaskMemoryDoc)
- (Session)-[:ON_TASK]->(Task)            — task da branch da sessão
- (Chunk)-[:MENTIONS_TASK]->(Task)        — task citada no texto
- (Session)-[:WROTE|READ]->(File)         — arquivo mudado / lido
- (Task)-[:TOUCHES]->(File)               — derivada, responde trabalho relacionado em 1 hop
- (Task)-[:IN_PROJECT]->(Project)
- (Plan)-[:PLANNED_IN]->(Session), (Plan)-[:ABOUT_TASK]->(Task), (Project)-[:HAS_PLAN]->(Plan)
- (Chunk)-[:SIMILAR_TO {score, computedAt}]->(Chunk)
  precomputed cross-chunk semantic neighbors (top-3, threshold>=0.75)
  use traversal via find_similar_chunks tool (no re-embed)

## Vector index
chunks_embedding  ON  (c:Chunk) ON (c.embedding)
  vector.dimensions = 1024
  vector.similarity_function = 'cosine'

## Fulltext index
chunks_text  ON  (c:Chunk) ON EACH [c.text]
  Lucene-based BM25
  used by hybrid scoring in search_memory / find_related_plans / find_decisions

## Hybrid retrieval scoring
When query has literal tokens (ABC-XXXX, file paths, identifiers >= 5 chars):
  final_score = 0.7 * vec_cosine + 0.3 * bm25_normalized
Otherwise vector-only. MMR (diversity param) diversifies top-k.

## sourceKind values on Chunk
- conversation   — user/assistant message text
- tool_output    — tool_result content (< 2000 chars)
- plan           — ~/.claude/plans markdown
- task_memory    — <project>/.claude/tasks/<TICKET>/*.md
(Todo is stored as node, not embedded)

## Useful Cypher

# top 10 chunks for embedding (when you have the query vector):
CALL db.index.vector.queryNodes('chunks_embedding', 10, $vec)
YIELD node, score
RETURN node.text, node.sourceKind, score

# all sessions in a project ordered by date:
MATCH (p:Project { path: $cwd })-[:HAS_SESSION]->(s:Session)
RETURN s.id, s.startedAt, s.gitBranch ORDER BY s.startedAt DESC

# decisions for a single ticket task:
MATCH (d:TaskMemoryDoc { taskId: 'ABC-123', kind: 'decisions' })
MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
RETURN c.text ORDER BY c.ordinal
`;

export function registerSchemaResource(server: McpServer): void {
  server.registerResource(
    'memory://schema',
    'memory://schema',
    {
      description:
        'Reference: nodes, edges, vector index, sourceKind values and useful Cypher queries for the indexed memory.',
    },
    async () => ({
      contents: [
        {
          uri: 'memory://schema',
          mimeType: 'text/markdown',
          text: `${await liveInventory()}\n\n${SCHEMA_DOC}`,
        },
      ],
    }),
  );
}
