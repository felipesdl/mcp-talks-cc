import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { embed } from '../../embeddings/localEmbedder.ts';
import { toToolError } from '../../domain/errors.ts';

const inputSchema = {
  query: z.string().min(1).describe('What you are looking for in past plan documents.'),
  k: z.number().int().min(1).max(20).default(5).describe('Number of plans (default 5).'),
  hybrid: z
    .boolean()
    .default(true)
    .describe('Combine vector + BM25 fulltext when query has literal tokens.'),
};

export interface PlanHit {
  score: number;
  vec_score: number;
  bm25_score: number | null;
  slug: string;
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

async function findRelatedPlans(args: {
  query: string;
  k?: number;
  hybrid?: boolean;
}): Promise<PlanHit[]> {
  const k = args.k ?? 5;
  const hybrid = (args.hybrid ?? true) && hasLiterals(args.query);
  const [qvec] = await embed([args.query.trim()]);
  if (!qvec) return [];

  return withSession(async (s) => {
    const vecRes = await s.run(
      `CALL db.index.vector.queryNodes('chunks_embedding', toInteger($k) * 8, $vec)
       YIELD node, score
       WHERE node.sourceKind = 'plan'
       MATCH (p:Plan)-[:HAS_CHUNK]->(node)
       RETURN p.slug AS slug, p.path AS path, node.id AS chunkId, node.text AS snippet, score AS vec_score`,
      { k, vec: qvec },
    );

    const ftMap = new Map<string, number>();
    if (hybrid) {
      try {
        const ftRes = await s.run(
          `CALL db.index.fulltext.queryNodes('chunks_text', $query, { limit: toInteger($limit) })
           YIELD node, score
           WHERE node.sourceKind = 'plan'
           RETURN node.id AS id, score`,
          { query: escapeLucene(args.query), limit: k * 8 },
        );
        const raw = ftRes.records.map((r) => Number(r.get('score')));
        const norm = normalizeMax(raw);
        ftRes.records.forEach((r, i) => ftMap.set(r.get('id') as string, norm[i] ?? 0));
      } catch (e) {
        console.error('[plans] fulltext skipped:', e instanceof Error ? e.message : String(e));
      }
    }

    // Group by Plan, keep best (combined-score) chunk per plan
    const byPlan = new Map<string, PlanHit>();
    for (const rec of vecRes.records) {
      const slug = rec.get('slug') as string;
      const chunkId = rec.get('chunkId') as string;
      const vec_score = Number(rec.get('vec_score'));
      const bm25_score = ftMap.has(chunkId) ? ftMap.get(chunkId)! : null;
      const final = bm25_score !== null ? 0.7 * vec_score + 0.3 * bm25_score : vec_score;
      const existing = byPlan.get(slug);
      if (!existing || final > existing.score) {
        byPlan.set(slug, {
          score: final,
          vec_score,
          bm25_score,
          slug,
          path: rec.get('path') as string,
          snippet: rec.get('snippet') as string,
          chunkId,
        });
      }
    }
    return [...byPlan.values()].sort((a, b) => b.score - a.score).slice(0, k);
  });
}

export function registerFindRelatedPlansTool(server: McpServer): void {
  server.registerTool(
    'find_related_plans',
    {
      description:
        'Semantic + fulltext search restricted to plan documents (~/.claude/plans/*.md). Returns top plans grouped by file with best matching snippet, score, and path. Hybrid (vec + bm25) auto-applied when query contains literal tokens.',
      inputSchema,
    },
    async (args) => {
      try {
        const hits = await findRelatedPlans(args);
        const text =
          hits.length === 0
            ? 'No matching plans.'
            : hits
                .map(
                  (h, i) =>
                    `[${i + 1}] score=${h.score.toFixed(3)} vec=${h.vec_score.toFixed(3)}${h.bm25_score !== null ? ` bm25=${h.bm25_score.toFixed(3)}` : ''} ${h.slug}\n  path: ${h.path}\n  ${h.snippet.slice(0, 400)}`,
                )
                .join('\n\n');
        return { content: [{ type: 'text', text }], structuredContent: { hits } };
      } catch (e) {
        const err = toToolError(e);
        return {
          isError: true,
          content: [{ type: 'text', text: `find_related_plans ${err.errorType}: ${err.message}` }],
          structuredContent: err,
        };
      }
    },
  );
}
