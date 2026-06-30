import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { embed } from '../../embeddings/localEmbedder.ts';
import { toToolError } from '../../domain/errors.ts';
import { getTuning, LAMBDA_DEFAULT, HYBRID_VEC_WEIGHT } from '../tuning.ts';
import { logQuery } from '../../learning/queryLog.ts';

// Claude Code não expõe a sessão chamadora na env do MCP child hoje;
// fica null e o grader resolve por time-window join (src/learning/grading).
const CALLER_SESSION_ID = process.env.CLAUDE_SESSION_ID ?? null;

const inputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'Natural language query. Hybrid retrieval: vector embed (semantic) + BM25 fulltext (exact terms like ABC-XXXX, useEffect, file paths).',
    ),
  // Sem .default(): o SDK preencheria antes do handler e anularia o valor aprendido (tuning.json).
  k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Number of results to return (default 8, learned via tuning).'),
  scope: z
    .array(z.enum(['conversation', 'tool_output', 'plan', 'todo', 'task_memory']))
    .optional()
    .describe('Restrict to specific source kinds. Omit to search everything.'),
  project: z
    .string()
    .optional()
    .describe(
      'Absolute project path (e.g. /Users/you/Documents/code/your-project). SOFT BOOST: same-project hits rank higher but cross-repo hits stay eligible (rules often span repos). Use projectStrict to hard-filter.',
    ),
  projectStrict: z
    .boolean()
    .optional()
    .describe('If true, `project` becomes a hard filter (old behavior). Default false (soft boost).'),
  since: z
    .string()
    .optional()
    .describe('ISO timestamp. Only chunks with timestamp >= since.'),
  diversity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'MMR lambda. 0 = max diversity (different sessions), 1 = pure relevance. Default 0.7. Use 0.3 for panorama, 0.9 to focus a single topic.',
    ),
  hybrid: z
    .boolean()
    .default(true)
    .describe('Combine vector + BM25 fulltext. Disable only for debug.'),
};

export interface SearchHit {
  id: string;
  score: number;
  vec_score: number;
  bm25_score: number | null;
  source: string;
  sessionId: string | null;
  project: string | null;
  timestamp: string | null;
  snippet: string;
  neighbors: string[];
  parentLabel: string | null;
  parentKey: string | null;
}

export const LITERAL_TOKEN_RE =
  /\b[A-Z]{2,}-\d+\b|\b[\w/-]+\.(?:ts|tsx|php|md|py|go|rb|js|jsx)\b|\b[a-z][A-Za-z0-9_]{4,}\b/g;

function hasLiteralTokens(q: string): boolean {
  LITERAL_TOKEN_RE.lastIndex = 0;
  return LITERAL_TOKEN_RE.test(q);
}

function escapeLucene(q: string): string {
  // Neo4j fulltext uses Lucene syntax; escape special chars to treat as literal
  return q.replace(/[+\-!(){}\[\]^"~*?:\\/]/g, '\\$&');
}

function normalizeMax(values: number[]): number[] {
  const max = Math.max(...values, 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => v / max);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // already normalized (HF normalize: true)
}

interface Candidate {
  id: string;
  vec_score: number;
  bm25_score: number | null;
  embedding: number[];
  data: Omit<SearchHit, 'score' | 'vec_score' | 'bm25_score' | 'neighbors'>;
}

/** Score híbrido cru (sem boosts) — é o que sai no campo `score` dos hits. */
function rawScore(c: Candidate, hybrid: boolean): number {
  return hybrid && c.bm25_score !== null
    ? HYBRID_VEC_WEIGHT * c.vec_score + (1 - HYBRID_VEC_WEIGHT) * c.bm25_score
    : c.vec_score;
}

function mmrSelect(
  pool: Candidate[],
  lambda: number,
  k: number,
  hybrid: boolean,
  boostOf: (c: Candidate) => number,
): Candidate[] {
  const selected: Candidate[] = [];
  const remaining = [...pool];

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!;
      // boost multiplica SÓ o termo de relevância (ranking); o termo de
      // diversidade (maxSim) e o score reportado ficam crus.
      const rel = rawScore(c, hybrid) * boostOf(c);
      const maxSim =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((s) => cosine(c.embedding, s.embedding)));
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return selected;
}

async function searchMemory(args: {
  query: string;
  k?: number;
  scope?: ('conversation' | 'tool_output' | 'plan' | 'todo' | 'task_memory')[];
  project?: string;
  projectStrict?: boolean;
  since?: string;
  diversity?: number;
  hybrid?: boolean;
}): Promise<SearchHit[]> {
  const tuning = getTuning();
  const k = args.k ?? tuning.k;
  const lambda = args.diversity ?? LAMBDA_DEFAULT;
  const hybrid = (args.hybrid ?? true) && hasLiteralTokens(args.query);
  const oversample = Math.min(k * 5, 200);

  // project é soft boost por padrão (regras cruzam repos); hard filter só com projectStrict
  const projectFilter = args.projectStrict ? (args.project ?? null) : null;
  const boostOf = (c: Candidate): number =>
    (args.project && !args.projectStrict && c.data.project === args.project
      ? tuning.projectBoost
      : 1) *
    (tuning.perSourceKind[c.data.source] ?? 1) *
    (c.data.project ? (tuning.perProject[c.data.project] ?? 1) : 1);

  const [qvec] = await embed([args.query.trim()]);
  if (!qvec) return [];

  return withSession(async (s) => {
    // (1) Vector candidates
    const vecRes = await s.run(
      `CALL db.index.vector.queryNodes('chunks_embedding', toInteger($oversample), $vec)
       YIELD node, score
       WHERE ($scope IS NULL OR node.sourceKind IN $scope)
         AND ($project IS NULL OR node.projectPath = $project)
         AND ($since IS NULL OR node.timestamp >= $since)
       RETURN node.id AS id,
              score AS vec_score,
              node.text AS snippet,
              node.embedding AS embedding,
              node.sourceKind AS source,
              node.sessionId AS sessionId,
              node.projectPath AS project,
              node.timestamp AS timestamp
       ORDER BY score DESC`,
      {
        vec: qvec,
        oversample,
        scope: args.scope ?? null,
        project: projectFilter,
        since: args.since ?? null,
      },
    );

    // (2) Fulltext candidates (parallel, optional)
    const ftMap = new Map<string, number>();
    if (hybrid) {
      try {
        const ftRes = await s.run(
          `CALL db.index.fulltext.queryNodes('chunks_text', $query, { limit: toInteger($limit) })
           YIELD node, score
           WHERE ($scope IS NULL OR node.sourceKind IN $scope)
             AND ($project IS NULL OR node.projectPath = $project)
             AND ($since IS NULL OR node.timestamp >= $since)
           RETURN node.id AS id, score`,
          {
            query: escapeLucene(args.query),
            limit: oversample,
            scope: args.scope ?? null,
            project: projectFilter,
            since: args.since ?? null,
          },
        );
        const rawScores = ftRes.records.map((r) => Number(r.get('score')));
        const normalized = normalizeMax(rawScores);
        ftRes.records.forEach((r, i) => {
          ftMap.set(r.get('id') as string, normalized[i] ?? 0);
        });
      } catch (e) {
        // fulltext index may not exist yet — fall back to vector only
        console.error('[search] fulltext skipped:', e instanceof Error ? e.message : String(e));
      }
    }

    // (3) Merge into Candidate[]
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const rec of vecRes.records) {
      const id = rec.get('id') as string;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({
        id,
        vec_score: Number(rec.get('vec_score')),
        bm25_score: ftMap.has(id) ? ftMap.get(id)! : null,
        embedding: rec.get('embedding') as number[],
        data: {
          id,
          source: rec.get('source'),
          sessionId: rec.get('sessionId'),
          project: rec.get('project'),
          timestamp: rec.get('timestamp'),
          snippet: rec.get('snippet'),
          parentLabel: null,
          parentKey: null,
        },
      });
    }

    if (candidates.length === 0) return [];

    // (4) MMR (ranking usa boosts aprendidos; scores reportados ficam crus)
    const picked = mmrSelect(candidates, lambda, k, hybrid, boostOf);

    // (5) Context expansion + parent lookup
    const ids = picked.map((p) => p.id);
    const ctxRes = await s.run(
      `UNWIND $ids AS id
       MATCH (c:Chunk { id: id })
       OPTIONAL MATCH (parent)-[:HAS_CHUNK]->(c)
       OPTIONAL MATCH (parent)-[:HAS_CHUNK]->(sib:Chunk)
       WHERE sib.id <> c.id AND abs(sib.ordinal - c.ordinal) <= 1
       WITH c, parent, collect(DISTINCT sib.text)[..2] AS neighbors
       RETURN c.id AS id,
              labels(parent)[0] AS parentLabel,
              coalesce(parent.uuid, parent.path, parent.id) AS parentKey,
              neighbors`,
      { ids },
    );
    const ctxMap = new Map<string, { parentLabel: string; parentKey: string; neighbors: string[] }>();
    for (const rec of ctxRes.records) {
      ctxMap.set(rec.get('id') as string, {
        parentLabel: rec.get('parentLabel'),
        parentKey: rec.get('parentKey'),
        neighbors: (rec.get('neighbors') as string[]) ?? [],
      });
    }

    return picked.map((c) => {
      const ctx = ctxMap.get(c.id);
      return {
        id: c.id,
        // score RAW (sem boost): thresholds absolutos do CLAUDE.md (>=0.70 etc.)
        // dependem dessa calibração. Ordem dos hits pode divergir do score.
        score: rawScore(c, hybrid),
        vec_score: c.vec_score,
        bm25_score: c.bm25_score,
        source: c.data.source,
        sessionId: c.data.sessionId,
        project: c.data.project,
        timestamp: c.data.timestamp,
        snippet: c.data.snippet,
        neighbors: ctx?.neighbors ?? [],
        parentLabel: ctx?.parentLabel ?? null,
        parentKey: ctx?.parentKey ?? null,
      };
    });
  });
}

export function registerSearchMemoryTool(server: McpServer): void {
  server.registerTool(
    'search_memory',
    {
      description:
        'Hybrid semantic + fulltext search across your Claude Code history (conversations, tool outputs, plans, task memory, todos). Returns top-k chunks diversified via MMR (avoids 5 hits from same session). **Use BEFORE answering questions about past decisions, approaches, or context.** Pass `diversity` (0..1, default 0.7) to balance relevance vs variety. Auto-detects literal tokens (ABC-XXXX, file paths, identifiers) to combine BM25 with vector scoring. `project` is a soft ranking boost (cross-repo hits stay visible); result order may differ from raw `score`, which stays uncalibrated by learned boosts.',
      inputSchema,
    },
    async (args) => {
      try {
        const t0 = Date.now();
        const hits = await searchMemory(args);
        void logQuery({
          v: 1,
          ts: new Date().toISOString(),
          tool: 'search_memory',
          sessionId: CALLER_SESSION_ID,
          query: args.query,
          k: args.k ?? null,
          scope: args.scope ?? null,
          project: args.project ?? null,
          projectStrict: args.projectStrict ?? null,
          diversity: args.diversity ?? null,
          hybridUsed: (args.hybrid ?? true) && hasLiteralTokens(args.query),
          nResults: hits.length,
          topScore: hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null,
          scores: hits.map((h) => h.score),
          latencyMs: Date.now() - t0,
          hits: hits.map((h) => ({
            id: h.id,
            sessionId: h.sessionId,
            source: h.source,
            project: h.project,
            vecScore: h.vec_score,
            bm25Score: h.bm25_score,
          })),
        });
        const text =
          hits.length === 0
            ? 'No matches in indexed memory.'
            : hits
                .map((h, i) => {
                  const bm25 =
                    h.bm25_score !== null ? ` bm25=${h.bm25_score.toFixed(3)}` : '';
                  const ctx =
                    h.neighbors.length > 0
                      ? `\n  context: ${h.neighbors.map((n) => n.slice(0, 100)).join(' | ')}`
                      : '';
                  return `[${i + 1}] score=${h.score.toFixed(3)} vec=${h.vec_score.toFixed(3)}${bm25} source=${h.source} project=${h.project ?? '-'} sessionId=${h.sessionId ?? '-'} parent=${h.parentLabel}/${h.parentKey}\n${h.snippet}${ctx}`;
                })
                .join('\n\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: { hits },
        };
      } catch (e) {
        const err = toToolError(e);
        return {
          isError: true,
          content: [{ type: 'text', text: `search_memory ${err.errorType}: ${err.message}` }],
          structuredContent: err,
        };
      }
    },
  );
}
