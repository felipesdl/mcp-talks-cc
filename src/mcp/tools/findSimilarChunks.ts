import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { toToolError } from '../../domain/errors.ts';
import { resolveCallerSession } from '../callerSession.ts';
import { logQuery } from '../../learning/queryLog.ts';

const inputSchema = {
  chunkId: z
    .string()
    .min(1)
    .describe('Chunk id (typically obtained from a search_memory hit `id` field).'),
  k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Number of similar chunks to return (default 5).'),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .default(0.75)
    .describe('Minimum cosine score for an edge to be returned (default 0.75).'),
  scope: z
    .array(z.enum(['conversation', 'tool_output', 'plan', 'todo', 'task_memory']))
    .optional()
    .describe('Filter neighbors by sourceKind.'),
};

export interface SimilarHit {
  id: string;
  score: number;
  snippet: string;
  source: string;
  sessionId: string | null;
  project: string | null;
  parentLabel: string | null;
  parentKey: string | null;
}

async function findSimilarChunks(args: {
  chunkId: string;
  k?: number;
  minScore?: number;
  scope?: ('conversation' | 'tool_output' | 'plan' | 'todo' | 'task_memory')[];
}): Promise<SimilarHit[]> {
  const k = args.k ?? 5;
  const minScore = args.minScore ?? 0.75;
  return withSession(async (s) => {
    const r = await s.run(
      `MATCH (src:Chunk { id: $chunkId })-[r:SIMILAR_TO]->(tgt:Chunk)
       WHERE r.score >= $minScore
         AND ($scope IS NULL OR tgt.sourceKind IN $scope)
       OPTIONAL MATCH (parent)-[:HAS_CHUNK]->(tgt)
       RETURN tgt.id AS id,
              r.score AS score,
              tgt.text AS snippet,
              tgt.sourceKind AS source,
              tgt.sessionId AS sessionId,
              tgt.projectPath AS project,
              labels(parent)[0] AS parentLabel,
              coalesce(parent.uuid, parent.path, parent.id) AS parentKey
       ORDER BY r.score DESC LIMIT toInteger($k)`,
      { chunkId: args.chunkId, k, minScore, scope: args.scope ?? null },
    );
    return r.records.map((rec) => ({
      id: rec.get('id'),
      score: Number(rec.get('score')),
      snippet: rec.get('snippet'),
      source: rec.get('source'),
      sessionId: rec.get('sessionId'),
      project: rec.get('project'),
      parentLabel: rec.get('parentLabel'),
      parentKey: rec.get('parentKey'),
    }));
  });
}

export function registerFindSimilarChunksTool(server: McpServer): void {
  server.registerTool(
    'find_similar_chunks',
    {
      description:
        'Graph traversal over precomputed SIMILAR_TO edges. Given a chunkId (from a search_memory hit), returns top-k semantically similar chunks across sessions WITHOUT re-embedding the query. Faster than search_memory for "show me more like this". Use after search_memory when a hit looks promising and you want to expand the context.',
      inputSchema,
    },
    async (args) => {
      try {
        const t0 = Date.now();
        const hits = await findSimilarChunks(args);
        // sinal de drill-in p/ o grader: expandir um chunk retornado por busca
        // anterior = crédito ao hit de origem
        void logQuery({
          v: 1,
          ts: new Date().toISOString(),
          tool: 'find_similar_chunks',
          sessionId: resolveCallerSession().sessionId,
          callerProject: resolveCallerSession().project,
          query: null,
          k: args.k ?? null,
          scope: args.scope ?? null,
          project: null,
          projectStrict: null,
          diversity: null,
          hybridUsed: null,
          nResults: hits.length,
          topScore: hits.length > 0 ? hits[0]!.score : null,
          scores: hits.map((h) => h.score),
          latencyMs: Date.now() - t0,
          hits: hits.map((h) => ({
            id: h.id,
            sessionId: h.sessionId,
            source: h.source,
            project: h.project,
            vecScore: h.score,
            bm25Score: null,
          })),
          refChunkId: args.chunkId,
        });
        const text =
          hits.length === 0
            ? 'No similar chunks above threshold.'
            : hits
                .map(
                  (h, i) =>
                    `[${i + 1}] score=${h.score.toFixed(3)} source=${h.source} project=${h.project ?? '-'} sessionId=${h.sessionId ?? '-'} parent=${h.parentLabel}/${h.parentKey}\n${h.snippet.slice(0, 400)}`,
                )
                .join('\n\n');
        return { content: [{ type: 'text', text }], structuredContent: { hits } };
      } catch (e) {
        const err = toToolError(e);
        return {
          isError: true,
          content: [
            { type: 'text', text: `find_similar_chunks ${err.errorType}: ${err.message}` },
          ],
          structuredContent: err,
        };
      }
    },
  );
}
