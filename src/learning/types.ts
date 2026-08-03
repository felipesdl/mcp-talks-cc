import { z } from 'zod';

// ── query-log.jsonl ──────────────────────────────────────────────────────────

export interface QueryLogHit {
  id: string;
  sessionId: string | null;
  source: string;
  project: string | null;
  vecScore: number;
  bm25Score: number | null;
}

export interface QueryLogEntry {
  v: 1;
  ts: string;
  tool: 'search_memory' | 'get_session_transcript' | 'find_similar_chunks';
  sessionId: string | null; // sessão chamadora (resolvida via src/mcp/callerSession.ts)
  callerProject?: string | null; // cwd da sessão chamadora — NÃO confundir com o arg `project`
  query: string | null;
  k: number | null;
  scope: string[] | null;
  project: string | null;
  projectStrict: boolean | null;
  diversity: number | null;
  hybridUsed: boolean | null;
  nResults: number;
  topScore: number | null;
  scores: number[];
  latencyMs: number;
  hits: QueryLogHit[];
  /** Piso de similaridade daquela busca (mediana do pool de recall). */
  poolVecMedian?: number | null;
  refSessionId?: string | null; // get_session_transcript alvo
  refChunkId?: string | null; // find_similar_chunks origem
}

export const queryLogEntrySchema = z.object({
  v: z.literal(1),
  ts: z.string(),
  tool: z.enum(['search_memory', 'get_session_transcript', 'find_similar_chunks']),
  sessionId: z.string().nullable(),
  // optional: linhas gravadas antes deste campo existir precisam seguir válidas
  callerProject: z.string().nullable().optional(),
  query: z.string().nullable(),
  k: z.number().nullable(),
  scope: z.array(z.string()).nullable(),
  project: z.string().nullable(),
  projectStrict: z.boolean().nullable(),
  diversity: z.number().nullable(),
  hybridUsed: z.boolean().nullable(),
  nResults: z.number(),
  topScore: z.number().nullable(),
  scores: z.array(z.number()),
  latencyMs: z.number(),
  hits: z.array(
    z.object({
      id: z.string(),
      sessionId: z.string().nullable(),
      source: z.string(),
      project: z.string().nullable(),
      vecScore: z.number(),
      bm25Score: z.number().nullable(),
    }),
  ),
  poolVecMedian: z.number().nullable().optional(),
  refSessionId: z.string().nullable().optional(),
  refChunkId: z.string().nullable().optional(),
});

// ── grades.jsonl ─────────────────────────────────────────────────────────────

export interface GradeSignals {
  echoRaw: number | null;
  echoCalibrated: number | null;
  reformulated: boolean | null;
  drillIn: boolean | null;
  zeroHit: boolean;
}

export interface Grade {
  v: 1;
  ts: string;
  queryTs: string; // join key com query-log
  utility: number; // [0,1]
  confidence: number; // [0,1] — downstream multiplica por isso
  signals: GradeSignals;
  joinMethod: 'session' | 'timeWindow';
  hitCredits: Array<{ id: string; credit: number }>;
}

export const gradeSchema = z.object({
  v: z.literal(1),
  ts: z.string(),
  queryTs: z.string(),
  utility: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  signals: z.object({
    echoRaw: z.number().nullable(),
    echoCalibrated: z.number().nullable(),
    reformulated: z.boolean().nullable(),
    drillIn: z.boolean().nullable(),
    zeroHit: z.boolean(),
  }),
  joinMethod: z.enum(['session', 'timeWindow']),
  hitCredits: z.array(z.object({ id: z.string(), credit: z.number() })),
});

// ── echo-calibration.json ────────────────────────────────────────────────────

export const MIN_ECHO_SAMPLES = 50;

export interface EchoCalibration {
  v: 1;
  updatedAt: string;
  nSamples: number;
  ready: boolean; // nSamples >= MIN_ECHO_SAMPLES
  floor: number; // p40 da distribuição real de echoRaw
  ceil: number; // p90
  percentiles: Record<string, number>; // p10..p95 p/ rationale
}

// ── score-calibration.json ───────────────────────────────────────────────────
// CDF empírica de vec_score, usada pra derivar `confidence` em search_memory.
// Ver src/mcp/scoreCalibration.ts.

export const MIN_SCORE_SAMPLES = 200;

export interface ScoreCalibration {
  v: 1;
  updatedAt: string;
  nSamples: number;
  ready: boolean; // nSamples >= MIN_SCORE_SAMPLES
  percentiles: Record<string, number>; // p10..p95 de vec_score
  /**
   * CDF empírica da MARGEM do hit sobre o piso da própria query
   * (vec_score - poolVecMedian). Opcional: só existe depois que o query-log
   * passou a gravar poolVecMedian. Sem ela, `confidence` cai no percentil
   * absoluto puro, que é o comportamento antigo.
   */
  marginPercentiles?: Record<string, number>;
  nMarginSamples?: number;
}

// ── profile.json ─────────────────────────────────────────────────────────────

export interface Profile {
  v: 1;
  generatedAt: string;
  windowDays: number;
  topProjects: Array<{ path: string; name: string; share: number; meanUtility: number }>;
  projectClusters: string[][]; // repos que co-ocorrem nas mesmas sessões
  recurringTopics: string[];
  terminology: string[];
  sourceKindUtility: Record<string, { meanUtility: number; n: number }>;
  queryShapes: {
    zeroHitTerms: string[];
    medianK: number;
    literalVsNL: { lit: number; nl: number };
  };
  recentHighValue: Array<{ gist: string; when: string; ref: string }>;
  lastEval: { ranAt: string; queriesGraded: number; meanUtility: number; healthy: boolean };
}

// ── tuning.json / tuning.candidate.json ──────────────────────────────────────
// SÓ boosts de ranking (coadjuvante). lambda e hybridVecWeight NÃO são tunados:
// vivem como constantes em src/mcp/tuning.ts e viram observação no rationale.

export const TUNING_BOUNDS = {
  projectBoost: { min: 1.0, max: 1.5 },
  perSourceKind: { min: 0.85, max: 1.25 },
  perProject: { min: 0.9, max: 1.2 },
  k: { min: 1, max: 50 },
} as const;

export interface Tuning {
  v: 1;
  updatedAt: string;
  projectBoost: number; // soft boost do arg `project` no ranking
  perSourceKind: Record<string, number>;
  perProject: Record<string, number>; // afinidade aprendida, aplica sem arg project
  k: number;
}

export const tuningSchema = z.object({
  v: z.literal(1),
  updatedAt: z.string(),
  projectBoost: z.number().min(TUNING_BOUNDS.projectBoost.min).max(TUNING_BOUNDS.projectBoost.max),
  perSourceKind: z.record(
    z.number().min(TUNING_BOUNDS.perSourceKind.min).max(TUNING_BOUNDS.perSourceKind.max),
  ),
  perProject: z.record(
    z.number().min(TUNING_BOUNDS.perProject.min).max(TUNING_BOUNDS.perProject.max),
  ),
  k: z.number().int().min(TUNING_BOUNDS.k.min).max(TUNING_BOUNDS.k.max),
});
