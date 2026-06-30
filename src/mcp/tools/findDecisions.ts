import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { embed } from '../../embeddings/localEmbedder.ts';
import { toToolError } from '../../domain/errors.ts';

const inputSchema = {
  query: z.string().min(1).describe('Topic / question you want decisions or learnings about.'),
  taskId: z
    .string()
    .optional()
    .describe(
      'Restrict to a specific ABC-XXXX. When set, searches ALL kinds of that task. Without, searches only decisions/learnings across every task.',
    ),
  k: z.number().int().min(1).max(20).default(8).describe('Number of results (default 8).'),
  hybrid: z
    .boolean()
    .default(true)
    .describe('Combine vector + BM25 fulltext when query has literal tokens.'),
};

export interface DecisionHit {
  score: number;
  vec_score: number;
  bm25_score: number | null;
  taskId: string;
  kind: string;
  project: string | null;
  path: string;
  snippet: string;
  chunkId: string;
}

const LITERAL_RE =
  /\b[A-Z]{2,}-\d+\b|\b[\w/-]+\.(?:ts|tsx|php|md|py|go|rb)\b|\b[a-z][A-Za-z0-9_]{4,}\b/g;

function hasLiterals(q: string): boolean {
  LITERAL_RE.lastIndex = 0;
  return LITERAL_RE.test(q);
}

function escapeLucene(q: string): string {
  return q.replace(/[+\-!(){}\[\]^"~*?:\\/]/g, '\\$&');
}

function normalizeMax(values: number[]): number[] {
  const max = Math.max(...values, 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => v / max);
}

async function findDecisions(args: {
  query: string;
  taskId?: string;
  k?: number;
  hybrid?: boolean;
}): Promise<DecisionHit[]> {
  const k = args.k ?? 8;
  const hybrid = (args.hybrid ?? true) && hasLiterals(args.query);
  const [qvec] = await embed([args.query.trim()]);
  if (!qvec) return [];

  return withSession(async (s) => {
    const filter = args.taskId
      ? `d.taskId = $taskId`
      : `d.kind IN ['decisions', 'learnings']`;
    const vecRes = await s.run(
      `CALL db.index.vector.queryNodes('chunks_embedding', toInteger($k) * 8, $vec)
       YIELD node, score
       WHERE node.sourceKind = 'task_memory'
       MATCH (d:TaskMemoryDoc)-[:HAS_CHUNK]->(node)
       WHERE ${filter}
       RETURN d.taskId AS taskId, d.kind AS kind, d.projectPath AS project, d.path AS path,
              node.id AS chunkId, node.text AS snippet, score AS vec_score`,
      { k, vec: qvec, taskId: args.taskId ?? null },
    );

    const ftMap = new Map<string, number>();
    if (hybrid) {
      try {
        const ftRes = await s.run(
          `CALL db.index.fulltext.queryNodes('chunks_text', $query, { limit: toInteger($limit) })
           YIELD node, score
           WHERE node.sourceKind = 'task_memory'
           RETURN node.id AS id, score`,
          { query: escapeLucene(args.query), limit: k * 8 },
        );
        const raw = ftRes.records.map((r) => Number(r.get('score')));
        const norm = normalizeMax(raw);
        ftRes.records.forEach((r, i) => ftMap.set(r.get('id') as string, norm[i] ?? 0));
      } catch (e) {
        console.error('[decisions] fulltext skipped:', e instanceof Error ? e.message : String(e));
      }
    }

    const hits: DecisionHit[] = vecRes.records.map((rec) => {
      const chunkId = rec.get('chunkId') as string;
      const vec_score = Number(rec.get('vec_score'));
      const bm25_score = ftMap.has(chunkId) ? ftMap.get(chunkId)! : null;
      const final = bm25_score !== null ? 0.7 * vec_score + 0.3 * bm25_score : vec_score;
      return {
        score: final,
        vec_score,
        bm25_score,
        taskId: rec.get('taskId'),
        kind: rec.get('kind'),
        project: rec.get('project'),
        path: rec.get('path'),
        snippet: rec.get('snippet'),
        chunkId,
      };
    });
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  });
}

export function registerFindDecisionsTool(server: McpServer): void {
  server.registerTool(
    'find_decisions',
    {
      description:
        'Hybrid search (vec + bm25) over task memory under `<project>/.claude/tasks/ABC-XXXX/`. Without `taskId`: only decisions.md / learnings.md across all tasks. With `taskId`: all kinds for that ticket.',
      inputSchema,
    },
    async (args) => {
      try {
        const hits = await findDecisions(args);
        const text =
          hits.length === 0
            ? 'No matching decisions/learnings.'
            : hits
                .map(
                  (h, i) =>
                    `[${i + 1}] score=${h.score.toFixed(3)} vec=${h.vec_score.toFixed(3)}${h.bm25_score !== null ? ` bm25=${h.bm25_score.toFixed(3)}` : ''} ${h.taskId}/${h.kind} (${h.project ?? '-'})\n  ${h.snippet.slice(0, 400)}`,
                )
                .join('\n\n');
        return { content: [{ type: 'text', text }], structuredContent: { hits } };
      } catch (e) {
        const err = toToolError(e);
        return {
          isError: true,
          content: [{ type: 'text', text: `find_decisions ${err.errorType}: ${err.message}` }],
          structuredContent: err,
        };
      }
    },
  );
}
