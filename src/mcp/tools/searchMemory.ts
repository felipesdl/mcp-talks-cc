import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { embed } from '../../embeddings/localEmbedder.ts';
import { toToolError } from '../../domain/errors.ts';
import {
  getTuning,
  LAMBDA_DEFAULT,
  RRF_K,
  RECENCY_FLOOR,
  RECENCY_HALFLIFE_DAYS,
  VALUE_DEMOTE_THRESHOLD,
  RECALL_POOL,
  RECALL_POOL_MAX,
  MMR_POOL_MULT,
  MMR_POOL_MAX,
} from '../tuning.ts';
import { confidenceFromVec, getScoreCalibration } from '../scoreCalibration.ts';
import { lexicalHints } from '../../ingest/quality.ts';
import { resolveCallerSession } from '../callerSession.ts';
import { logQuery } from '../../learning/queryLog.ts';

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
  /** Percentil histórico do vec_score. null = calibração ainda não pronta. */
  confidence: number | null;
  vec_score: number;
  bm25_score: number | null;
  /** P(entrega) do classificador de valor; null se o chunk ainda não foi classificado. */
  value_score: number | null;
  source: string;
  sessionId: string | null;
  project: string | null;
  timestamp: string | null;
  snippet: string;
  neighbors: string[];
  parentLabel: string | null;
  parentKey: string | null;
}

/**
 * Token literal DE VERDADE: só isso deve ligar o BM25.
 * Cuidado com padrão frouxo aqui: um branch tipo `\b[a-z][A-Za-z0-9_]{4,}\b`
 * casa qualquer palavra com 5+ letras ("quando", "memoria"), o que liga hybrid
 * em toda query em prosa e infla o score de todo hit topo via BM25.
 */
export const LITERAL_TOKEN_RE = new RegExp(
  [
    '\\b[A-Z]{2,}-\\d+\\b', // EDC-2410
    '\\b[\\w/.-]+\\.(?:ts|tsx|js|jsx|mjs|php|md|py|go|rb|sql|json|ya?ml|sh|css|scss)\\b', // path/arquivo
    '\\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\\b', // camelCase: useEffect, projectBoost
    '\\b[a-z][a-z0-9]*_[a-z0-9_]+\\b', // snake_case
    '\\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\\b', // CONST_CASE
    '\\b[A-Z]{3,}\\b', // sigla: MCP, SQL, JWT
    '\\b\\d+\\.\\d+(?:\\.\\d+)?\\b', // versão: 5.26, 1.2.3
  ].join('|'),
  'g',
);

/**
 * Token "de vocabulário" (palavra de 5+ letras). NÃO serve pra gatear hybrid,
 * só pra extrair terminologia recorrente no profile (src/learning/profile.ts).
 */
export const TERM_TOKEN_RE = /\b[a-zA-Zà-úÀ-Ú][A-Za-zà-úÀ-Ú0-9_]{4,}\b/g;

export function hasLiteralTokens(q: string): boolean {
  LITERAL_TOKEN_RE.lastIndex = 0;
  return LITERAL_TOKEN_RE.test(q);
}

/**
 * Decay de recência aplicado SÓ no termo de relevância do MMR. Sem isso um
 * chunk de janeiro empata com o de ontem no ranking.
 */
export function recencyMult(
  timestamp: string | null,
  nowMs: number = Date.now(),
): number {
  if (!timestamp) return 1;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return 1;
  const ageDays = (nowMs - t) / 86_400_000;
  if (ageDays <= 0) return 1;
  return Math.max(RECENCY_FLOOR, Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS));
}

/**
 * Query lexical a partir SÓ dos tokens literais, cada um como frase exata.
 *
 * O escape antigo (`q.replace(/[+\-...]/g, '\\$&')`) preservava o hífen como
 * caractere mas não como separador: o analyzer padrão quebrava `EDC\-3197` em
 * `EDC` OR `3197`, então a busca casava todo chunk que citasse qualquer EDC.
 * Medido: `EDC\-3197` batia em 500 chunks (o pool inteiro), `"EDC-3197"` bate
 * em 15, que é exatamente o `CONTAINS` real. Com tudo casando, o BM25 não
 * discriminava nada e o sinal lexical virava ruído uniforme.
 *
 * Só os tokens de LITERAL_TOKEN_RE entram: o resto da frase é prosa, que já é
 * trabalho do vetor. Retorna null quando não há token literal (o caller então
 * não roda fulltext nenhum).
 */
export function buildFulltextQuery(q: string): string | null {
  LITERAL_TOKEN_RE.lastIndex = 0;
  const tokens = [...new Set(q.match(LITERAL_TOKEN_RE) ?? [])];
  if (tokens.length === 0) return null;
  return tokens
    .map((t) => `"${t.replace(/[\\"]/g, '\\$&')}"`)
    .join(' OR ');
}

/**
 * Saturação do BM25 pra [0,1): `s / (s + med)`, com med = mediana do pool
 * retornado. Antes era max-normalização, que forçava o top a 1.0 sempre e
 * dava +0.30 fixo no score do primeiro hit, independente
 * de o match lexical ser bom ou ruim. Monótona e sem teto artificial.
 */
export function saturateBm25(values: number[]): number[] {
  const sorted = [...values].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const med = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;
  const c = med > 0 ? med : 1;
  return values.map((v) => (v > 0 ? v / (v + c) : 0));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // already normalized (HF normalize: true)
}

/** Metadata do estágio A: tudo que dá pra rankear sem trafegar o embedding. */
interface CandidateMeta {
  id: string;
  source: string;
  sessionId: string | null;
  project: string | null;
  timestamp: string | null;
  /** P(entrega) do classificador de valor; null = chunk ainda sem classificação. */
  valueScore: number | null;
  role: string | null;
}

/** Candidato do estágio A (pool largo): sem embedding, sem texto. */
interface PreCandidate {
  id: string;
  /** null = veio só do BM25; o cosseno real é calculado no estágio B. */
  vec_score: number | null;
  bm25_score: number | null;
  /** Posição 1-based em cada lista; null = não apareceu naquela lista. */
  vec_rank: number | null;
  bm25_rank: number | null;
  meta: CandidateMeta;
}

/** Finalista do estágio B: embedding e texto buscados só pra estes. */
interface Candidate extends PreCandidate {
  embedding: number[];
  snippet: string;
  /** No estágio B todo finalista tem cosseno, inclusive o que veio só do BM25. */
  vec_score: number;
}

/**
 * Fusão por rank (RRF), não por soma de scores.
 *
 * A fusão anterior era `0.7*vec + 0.3*bm25`, com `bm25 null` caindo pra `vec`
 * puro. Como o cosseno do bge-m3 vive comprimido em ~0.82-0.89 e o BM25
 * saturado gira em torno de 0.5, misturar ABAIXAVA o score: casar lexicalmente
 * virava penalidade, e um chunk sem match nenhum guardava o vec inteiro. Na
 * busca por `EDC-3197` o plano da própria task caía pro rank 349 enquanto os
 * finalistas são os 25 primeiros.
 *
 * RRF compara posições, não magnitudes, então as duas escalas deixam de
 * precisar ser comensuráveis e aparecer nas duas listas só soma.
 */
function rrfScore(c: Pick<PreCandidate, 'vec_rank' | 'bm25_rank'>): number {
  return (
    (c.vec_rank !== null ? 1 / (RRF_K + c.vec_rank) : 0) +
    (c.bm25_rank !== null ? 1 / (RRF_K + c.bm25_rank) : 0)
  );
}

/**
 * Relevância crua em [0,1], que é o que o MMR e o campo `score` consomem.
 *
 * Sem híbrido continua sendo o cosseno, igual antes. Com híbrido é o RRF
 * normalizado min-max DENTRO dos finalistas: o RRF cru vale ~0.03 no topo, e
 * nessa escala o termo de diversidade do MMR (`(1-lambda)*maxSim`, ~0.27)
 * engoliria a relevância por completo e a seleção degeneraria em diversidade
 * pura.
 */
function normalizeRelevance(values: number[]): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  return values.map((v) => (span > 0 ? (v - min) / span : 1));
}

/**
 * Demoção assimétrica de narração.
 *
 * Promover conteúdo bom não precisa de cuidado; REBAIXAR precisa, porque o erro
 * some com informação. Por isso o multiplicador só sai de 1 quando as três
 * condições valem, e qualquer falha devolve neutro em vez de punir:
 *
 *  1. `valueScore` abaixo do limiar (medido: em 0,30 acerta 87,5%);
 *  2. papel diferente de `user` — pedido e restrição são curtos e imperativos,
 *     sintaticamente iguais a anúncio, e são 18,5 mil chunks. Tratá-los pelo
 *     mesmo modelo rebaixaria mais de um terço do acervo por acidente;
 *  3. veto lexical: bloco de código, bullet, `porque`/`because` ou seta indicam
 *     entrega, e vencem o modelo. Defesa contra o overlap de 150 chars do
 *     chunker, que faz um pedaço começar com cauda de anúncio e mesmo assim
 *     entregar conteúdo.
 *
 * Aplicado SÓ no MMR, nunca no corte do estágio A: lá o texto ainda não foi
 * buscado, então o veto não teria como rodar e um chunk bom poderia cair fora
 * do pool de finalistas sem chance de defesa.
 */
function valueMult(c: Candidate, demote: number): number {
  if (demote >= 1) return 1;
  const p = c.meta.valueScore;
  if (p === null || p >= VALUE_DEMOTE_THRESHOLD) return 1;
  if (c.meta.role === 'user') return 1;
  if (lexicalHints(c.snippet).payload) return 1;
  return demote;
}

function mmrSelect(
  pool: Candidate[],
  lambda: number,
  k: number,
  relOf: (c: Candidate) => number,
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
      const rel = relOf(c) * boostOf(c);
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

export interface SearchResult {
  hits: SearchHit[];
  /** Fundo daquela query: mediana de vec_score do pool de candidatos. */
  poolVecMedian: number | null;
  poolSize: number;
  calibrated: boolean;
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
}): Promise<SearchResult> {
  const tuning = getTuning();
  const k = args.k ?? tuning.k;
  const lambda = args.diversity ?? LAMBDA_DEFAULT;
  const hybrid = (args.hybrid ?? true) && hasLiteralTokens(args.query);
  // Estágio B: só os finalistas trazem `node.embedding` (1024 doubles) pro MMR
  // client-side, que era a maior parte do p90 de latência.
  const mmrPool = Math.min(k * MMR_POOL_MULT, MMR_POOL_MAX);

  // project é soft boost por padrão (regras cruzam repos); hard filter só com projectStrict
  const projectFilter = args.projectStrict ? (args.project ?? null) : null;
  const nowMs = Date.now();
  const boostOf = (m: CandidateMeta): number =>
    (args.project && !args.projectStrict && m.project === args.project
      ? tuning.projectBoost
      : 1) *
    (tuning.perSourceKind[m.source] ?? 1) *
    (m.project ? (tuning.perProject[m.project] ?? 1) : 1) *
    recencyMult(m.timestamp, nowMs);

  const empty: SearchResult = { hits: [], poolVecMedian: null, poolSize: 0, calibrated: false };

  const [qvec] = await embed([args.query.trim()]);
  if (!qvec) return empty;

  return withSession(async (s) => {
    // (1) Estágio A — pool largo de recall, SEM embedding nem texto.
    // scope/project/since são post-filter (o índice vetorial do Neo4j 5.26
    // community não aceita pre-filter), então o pool precisa ser fundo o
    // bastante pra sobrar material depois deles.
    const stageA = async (poolSize: number): Promise<PreCandidate[]> => {
      const vecRes = await s.run(
        `CALL db.index.vector.queryNodes('chunks_embedding', toInteger($poolSize), $vec)
         YIELD node, score
         WHERE ($scope IS NULL OR node.sourceKind IN $scope)
           AND ($project IS NULL OR node.projectPath = $project)
           AND ($since IS NULL OR node.timestamp >= $since)
         RETURN node.id AS id,
                score AS vec_score,
                node.sourceKind AS source,
                node.sessionId AS sessionId,
                node.projectPath AS project,
                node.timestamp AS timestamp,
                node.valueScore AS valueScore,
                node.role AS role
         ORDER BY score DESC`,
        {
          vec: qvec,
          poolSize,
          scope: args.scope ?? null,
          project: projectFilter,
          since: args.since ?? null,
        },
      );

      // Fulltext no mesmo tamanho de pool; BM25 satura sobre ele (só pra
      // reportar: quem ordena agora é o rank, via RRF).
      const ftMap = new Map<string, { score: number; rank: number; meta: CandidateMeta }>();
      const ftQuery = hybrid ? buildFulltextQuery(args.query) : null;
      if (ftQuery) {
        try {
          const ftRes = await s.run(
            `CALL db.index.fulltext.queryNodes('chunks_text', $query, { limit: toInteger($limit) })
             YIELD node, score
             WHERE ($scope IS NULL OR node.sourceKind IN $scope)
               AND ($project IS NULL OR node.projectPath = $project)
               AND ($since IS NULL OR node.timestamp >= $since)
             RETURN node.id AS id,
                    score,
                    node.sourceKind AS source,
                    node.sessionId AS sessionId,
                    node.projectPath AS project,
                    node.timestamp AS timestamp,
                    node.valueScore AS valueScore,
                    node.role AS role
             ORDER BY score DESC`,
            {
              query: ftQuery,
              limit: poolSize,
              scope: args.scope ?? null,
              project: projectFilter,
              since: args.since ?? null,
            },
          );
          const rawScores = ftRes.records.map((r) => Number(r.get('score')));
          const saturated = saturateBm25(rawScores);
          ftRes.records.forEach((r, i) => {
            const id = r.get('id') as string;
            if (ftMap.has(id)) return;
            ftMap.set(id, {
              score: saturated[i] ?? 0,
              rank: i + 1,
              meta: {
                id,
                source: r.get('source'),
                sessionId: r.get('sessionId'),
                project: r.get('project'),
                timestamp: r.get('timestamp'),
                valueScore: r.get('valueScore') === null ? null : Number(r.get('valueScore')),
                role: r.get('role'),
              },
            });
          });
        } catch (e) {
          // fulltext index may not exist yet — fall back to vector only
          console.error('[search] fulltext skipped:', e instanceof Error ? e.message : String(e));
        }
      }

      // Pool = UNIÃO das duas listas. Antes o loop iterava só `vecRes`, então
      // um hit de BM25 fora do top-N vetorial era calculado, saturado, posto no
      // ftMap e descartado em silêncio: na prática o "hybrid" era recall
      // vetorial com rerank lexical, e casar o token literal nunca recrutava
      // ninguém. Medido em `EDC-3197`: dos 500 hits de fulltext, só 155 caíam
      // no pool vetorial.
      const seen = new Set<string>();
      const out: PreCandidate[] = [];
      vecRes.records.forEach((rec, i) => {
        const id = rec.get('id') as string;
        if (seen.has(id)) return;
        seen.add(id);
        const ft = ftMap.get(id);
        out.push({
          id,
          vec_score: Number(rec.get('vec_score')),
          bm25_score: ft?.score ?? null,
          vec_rank: i + 1,
          bm25_rank: ft?.rank ?? null,
          meta: {
            id,
            source: rec.get('source'),
            sessionId: rec.get('sessionId'),
            project: rec.get('project'),
            timestamp: rec.get('timestamp'),
            valueScore: rec.get('valueScore') === null ? null : Number(rec.get('valueScore')),
            role: rec.get('role'),
          },
        });
      });
      for (const [id, ft] of ftMap) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          vec_score: null,
          bm25_score: ft.score,
          vec_rank: null,
          bm25_rank: ft.rank,
          meta: ft.meta,
        });
      }
      return out;
    };

    let pool = await stageA(RECALL_POOL);
    // Post-filter apertado (scope/projectStrict/since) devolvia menos que k
    // mesmo com material de sobra no grafo: aprofunda uma vez.
    if (pool.length < k && RECALL_POOL < RECALL_POOL_MAX) {
      pool = await stageA(RECALL_POOL_MAX);
    }
    if (pool.length === 0) return empty;

    // fundo da query: mediana de vec do pool de RECALL (não do top-k), pra o
    // caller ver o quão alto o piso de similaridade está naquela busca. É a
    // estimativa de ruído que a confidence consome (ver scoreCalibration.ts).
    // Só quem veio da lista vetorial entra: é o piso de SIMILARIDADE da query,
    // e candidato recrutado só pelo BM25 ainda não tem cosseno neste estágio.
    const poolVec = pool
      .map((c) => c.vec_score)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const poolVecMedian = poolVec[Math.floor(poolVec.length / 2)] ?? null;
    const calibration = getScoreCalibration();

    // (2) Re-ranking com os boosts aprendidos ANTES do corte. Aqui é que
    // perProject/perSourceKind/recência ganham poder de trazer pro top-k um
    // chunk que o cosseno puro tinha deixado de fora.
    // Ordenação de corte: RRF cru quando híbrido (monótono, a normalização
    // vem depois, sobre os finalistas), cosseno puro quando não.
    const cutScore = (c: PreCandidate): number =>
      hybrid ? rrfScore(c) : (c.vec_score ?? 0);
    const finalists = [...pool]
      .sort((a, b) => cutScore(b) * boostOf(b.meta) - cutScore(a) * boostOf(a.meta))
      .slice(0, mmrPool);

    // (3) Estágio B — embedding e texto só dos finalistas.
    const embRes = await s.run(
      `UNWIND $ids AS id
       MATCH (c:Chunk { id: id })
       RETURN c.id AS id, c.text AS snippet, c.embedding AS embedding`,
      { ids: finalists.map((f) => f.id) },
    );
    const embMap = new Map<string, { snippet: string; embedding: number[] }>();
    for (const rec of embRes.records) {
      embMap.set(rec.get('id') as string, {
        snippet: rec.get('snippet') as string,
        embedding: rec.get('embedding') as number[],
      });
    }
    const candidates: Candidate[] = finalists.flatMap((f) => {
      const e = embMap.get(f.id);
      if (!e) return [];
      return [
        {
          ...f,
          snippet: e.snippet,
          embedding: e.embedding,
          // Recrutado só pelo BM25 não passou pelo índice vetorial, então o
          // cosseno sai aqui. Sem isso ele ficaria sem `confidence`, que é
          // justamente o número que decide se o hit pode ser citado.
          vec_score: f.vec_score ?? cosine(e.embedding, qvec),
        },
      ];
    });
    if (candidates.length === 0) return empty;

    // (4) MMR (ranking usa boosts aprendidos; scores reportados ficam crus).
    // A relevância é normalizada em [0,1] sobre os finalistas pra ficar na
    // mesma escala do termo de diversidade (cosseno) dentro do MMR.
    const relRaw = candidates.map((c) => (hybrid ? rrfScore(c) : c.vec_score));
    const relNorm = hybrid ? normalizeRelevance(relRaw) : relRaw;
    const relMap = new Map<string, number>();
    candidates.forEach((c, i) => relMap.set(c.id, relNorm[i] ?? 0));

    const picked = mmrSelect(
      candidates,
      lambda,
      k,
      (c) => relMap.get(c.id) ?? 0,
      (c) => boostOf(c.meta) * valueMult(c, tuning.valueDemote),
    );

    // (5) Context expansion + parent lookup (só dos k finais)
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

    const hits = picked.map((c) => {
      const ctx = ctxMap.get(c.id);
      return {
        id: c.id,
        // score RAW (sem boost) serve pra ORDENAÇÃO e comparação dentro da
        // mesma query. Pra decidir se cita, use `confidence`: o score cru não
        // é comparável entre queries (ver src/mcp/scoreCalibration.ts).
        score: relMap.get(c.id) ?? 0,
        confidence: confidenceFromVec(c.vec_score, calibration, poolVecMedian),
        vec_score: c.vec_score,
        bm25_score: c.bm25_score,
        value_score: c.meta.valueScore,
        source: c.meta.source,
        sessionId: c.meta.sessionId,
        project: c.meta.project,
        timestamp: c.meta.timestamp,
        snippet: c.snippet,
        neighbors: ctx?.neighbors ?? [],
        parentLabel: ctx?.parentLabel ?? null,
        parentKey: ctx?.parentKey ?? null,
      };
    });

    return {
      hits,
      poolVecMedian,
      // pool de RECALL, não de finalistas: é o denominador que dá sentido ao
      // poolVecMedian reportado.
      poolSize: pool.length,
      calibrated: calibration?.ready === true,
    };
  });
}

export function registerSearchMemoryTool(server: McpServer): void {
  server.registerTool(
    'search_memory',
    {
      description:
        'Hybrid semantic + fulltext search across your Claude Code history (conversations, tool outputs, plans, task memory, todos). Returns top-k chunks diversified via MMR (avoids 5 hits from same session). **Use BEFORE answering questions about past decisions, approaches, or context.** Pass `diversity` (0..1, default 0.7) to balance relevance vs variety. BM25 only kicks in for genuinely literal tokens (ABC-1234, file paths, camelCase identifiers, acronyms); plain prose stays pure vector. **Read `confidence` (0..1), not `score`, to decide whether to cite a hit**: confidence is the hit\'s vec_score percentile against the historical distribution, so it is comparable across queries, while `score` is only meaningful for ordering within one query. `confidence` is null until the local calibration has enough samples. `project` is a soft ranking boost (cross-repo hits stay visible).',
      inputSchema,
      // read-only: sem isso o plan mode do Claude Code pede permissão a cada chamada
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const t0 = Date.now();
        const { hits, poolVecMedian, poolSize, calibrated } = await searchMemory(args);
        const caller = resolveCallerSession();
        void logQuery({
          v: 1,
          ts: new Date().toISOString(),
          tool: 'search_memory',
          sessionId: caller.sessionId,
          callerProject: caller.project,
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
          // piso da query: o self-tune calibra a CDF de margens a partir disto
          poolVecMedian,
          hits: hits.map((h) => ({
            id: h.id,
            sessionId: h.sessionId,
            source: h.source,
            project: h.project,
            vecScore: h.vec_score,
            bm25Score: h.bm25_score,
          })),
        });
        const header =
          `pool: ${poolSize} candidatos, vec mediano=${poolVecMedian?.toFixed(3) ?? '-'}` +
          (calibrated
            ? ' | confidence = percentil histórico do vec (use isto pra decidir se cita)'
            : ' | confidence indisponível (calibração ainda coletando amostras)');
        const body =
          hits.length === 0
            ? 'No matches in indexed memory.'
            : hits
                .map((h, i) => {
                  const conf =
                    h.confidence !== null ? h.confidence.toFixed(2) : 'n/a';
                  const bm25 =
                    h.bm25_score !== null ? ` bm25=${h.bm25_score.toFixed(3)}` : '';
                  const ctx =
                    h.neighbors.length > 0
                      ? `\n  context: ${h.neighbors.map((n) => n.slice(0, 100)).join(' | ')}`
                      : '';
                  return `[${i + 1}] conf=${conf} score=${h.score.toFixed(3)} vec=${h.vec_score.toFixed(3)}${bm25} source=${h.source} project=${h.project ?? '-'} sessionId=${h.sessionId ?? '-'} parent=${h.parentLabel}/${h.parentKey}\n${h.snippet}${ctx}`;
                })
                .join('\n\n');
        return {
          content: [{ type: 'text', text: `${header}\n\n${body}` }],
          structuredContent: { hits, poolVecMedian, poolSize, calibrated },
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
