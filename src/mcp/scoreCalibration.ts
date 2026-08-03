import { readFileSync, statSync } from 'node:fs';
import { learningPaths } from '../learning/paths.ts';
import { MIN_SCORE_SAMPLES, type ScoreCalibration } from '../learning/types.ts';

/**
 * Calibração de score: o `score` do search_memory não é comparável entre
 * queries. O bge-m3 devolve cosseno alto (~0.85+) pra praticamente qualquer
 * par, e o BM25 fundido distorce mais a escala. Na prática os scores ficam
 * comprimidos numa faixa estreita, então corte absoluto (">= 0.70 = forte")
 * aprova todo hit, inclusive ruído.
 *
 * Solução: `confidence` = percentil do vec_score deste hit na distribuição
 * histórica de vec_score de TODOS os hits retornados (janela do self-tune).
 * Escala-estável e auto-recalibrável se o modelo de embedding mudar.
 * Mesmo padrão da calibração de echo (src/learning/grading/echo.ts).
 */

const RECHECK_MS = 60_000;

let _cal: ScoreCalibration | null = null;
let _lastCheck = 0;
let _lastMtimeMs = -1;

const PCTS = [10, 25, 40, 50, 75, 90, 95] as const;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[idx]!;
}

function percentilesOf(values: number[]): Record<string, number> {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const out: Record<string, number> = {};
  for (const p of PCTS) out[`p${p}`] = percentile(sorted, p);
  return out;
}

/**
 * Recomputa a CDF empírica a partir dos vec_score já observados no query-log.
 * `margins` (vec_score - poolVecMedian do hit) é opcional e habilita o corte
 * relativo ao piso da query — ver confidenceFromVec.
 */
export function buildScoreCalibration(
  vecScores: number[],
  minSamples = MIN_SCORE_SAMPLES,
  margins: number[] = [],
): ScoreCalibration {
  const sorted = [...vecScores].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const validMargins = margins.filter((v) => Number.isFinite(v));
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    nSamples: sorted.length,
    ready: sorted.length >= minSamples,
    percentiles: percentilesOf(sorted),
    ...(validMargins.length >= minSamples
      ? {
          marginPercentiles: percentilesOf(validMargins),
          nMarginSamples: validMargins.length,
        }
      : {}),
  };
}

/** Lê um bloco de percentis, exigindo monotonicidade. null = inválido. */
function readPercentiles(raw: unknown): Record<string, number> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const out: Record<string, number> = {};
  let prev = -Infinity;
  for (const p of PCTS) {
    const v = (raw as Record<string, unknown>)[`p${p}`];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < prev) return null;
    out[`p${p}`] = v;
    prev = v;
  }
  return out;
}

/** Sanitiza: arquivo meio-escrito ou percentis não-monotônicos → não ready. */
export function sanitizeScoreCalibration(raw: unknown): ScoreCalibration | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const percentiles = readPercentiles(r.percentiles);
  if (!percentiles) return null;
  const nSamples = typeof r.nSamples === 'number' ? r.nSamples : 0;
  // marginPercentiles é opcional: ausente ou corrompido só desliga o corte
  // relativo, sem invalidar a calibração absoluta.
  const marginPercentiles =
    r.marginPercentiles === undefined ? null : readPercentiles(r.marginPercentiles);
  const nMarginSamples = typeof r.nMarginSamples === 'number' ? r.nMarginSamples : 0;
  return {
    v: 1,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString(),
    nSamples,
    ready: r.ready === true && nSamples >= MIN_SCORE_SAMPLES,
    percentiles,
    ...(marginPercentiles && nMarginSamples >= MIN_SCORE_SAMPLES
      ? { marginPercentiles, nMarginSamples }
      : {}),
  };
}

/**
 * Mapeia vec_score → [0,1] por interpolação linear na CDF empírica.
 * Abaixo de p10 e acima de p95 extrapola com a inclinação da ponta, clampado.
 * Sem calibração pronta → null (o campo `confidence` sai omitido e o caller
 * cai no comportamento antigo, sem regressão).
 */
function interpolateCdf(value: number, percentiles: Record<string, number>): number {
  const pts: Array<[number, number]> = PCTS.map((p) => [percentiles[`p${p}`] ?? 0, p / 100]);

  const [firstX, firstY] = pts[0]!;
  if (value <= firstX) {
    // extrapola pra baixo com a inclinação p10→p25
    const [x1, y1] = pts[1]!;
    const slope = x1 > firstX ? (y1 - firstY) / (x1 - firstX) : 0;
    return Math.max(0, firstY + (value - firstX) * slope);
  }

  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (value <= x1) {
      if (x1 === x0) return y1;
      return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
    }
  }

  // acima de p95: inclinação p90→p95, clampado em 1
  const [xa, ya] = pts[pts.length - 2]!;
  const [xb, yb] = pts[pts.length - 1]!;
  const slope = xb > xa ? (yb - ya) / (xb - xa) : 0;
  return Math.min(1, yb + (value - xb) * slope);
}

/**
 * `confidence` = mínimo entre dois percentis:
 *
 * 1. absoluto — onde o vec_score cai na CDF histórica de todos os hits;
 * 2. relativo — onde a MARGEM sobre o piso daquela query (vec - poolVecMedian)
 *    cai na CDF histórica de margens.
 *
 * O percentil absoluto sozinho não distingue sinal de ruído: como o corpus todo
 * cabe em ~0.04 de cosseno, hit sentado na mediana do pool tirava 0.8+ (medido
 * em 2026-08-03: "PR verify start. Phase 1: pegar metadata." saiu com 0.88). O
 * termo relativo mata esse caso, porque margem zero é, por construção, a mediana
 * da distribuição de margens.
 *
 * `poolMedian` ausente ou calibração de margem ainda não pronta → cai no
 * comportamento antigo (só absoluto), sem regressão.
 */
export function confidenceFromVec(
  vec: number,
  cal: ScoreCalibration | null,
  poolMedian?: number | null,
): number | null {
  if (!cal?.ready || !Number.isFinite(vec)) return null;
  const absolute = interpolateCdf(vec, cal.percentiles);

  if (
    cal.marginPercentiles === undefined ||
    poolMedian === undefined ||
    poolMedian === null ||
    !Number.isFinite(poolMedian)
  ) {
    return absolute;
  }

  const relative = interpolateCdf(vec - poolMedian, cal.marginPercentiles);
  return Math.min(absolute, relative);
}

/**
 * Calibração aceita (score-calibration.json), cacheada em module scope.
 * Re-stat no máx 1x/min, igual getTuning().
 */
export function getScoreCalibration(): ScoreCalibration | null {
  const now = Date.now();
  if (now - _lastCheck < RECHECK_MS) return _cal;
  _lastCheck = now;
  try {
    const st = statSync(learningPaths.scoreCalibration);
    if (st.mtimeMs === _lastMtimeMs) return _cal;
    _lastMtimeMs = st.mtimeMs;
    _cal = sanitizeScoreCalibration(
      JSON.parse(readFileSync(learningPaths.scoreCalibration, 'utf8')),
    );
  } catch {
    _lastMtimeMs = -1;
    _cal = null;
  }
  return _cal;
}

/** Só p/ testes: zera o cache do módulo. */
export function resetScoreCalibrationCache(): void {
  _cal = null;
  _lastCheck = 0;
  _lastMtimeMs = -1;
}
