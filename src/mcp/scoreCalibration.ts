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

/** Recomputa a CDF empírica a partir dos vec_score já observados no query-log. */
export function buildScoreCalibration(
  vecScores: number[],
  minSamples = MIN_SCORE_SAMPLES,
): ScoreCalibration {
  const sorted = [...vecScores].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const percentiles: Record<string, number> = {};
  for (const p of PCTS) percentiles[`p${p}`] = percentile(sorted, p);
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    nSamples: sorted.length,
    ready: sorted.length >= minSamples,
    percentiles,
  };
}

/** Sanitiza: arquivo meio-escrito ou percentis não-monotônicos → não ready. */
export function sanitizeScoreCalibration(raw: unknown): ScoreCalibration | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const pct = r.percentiles;
  if (typeof pct !== 'object' || pct === null) return null;
  const percentiles: Record<string, number> = {};
  let prev = -Infinity;
  for (const p of PCTS) {
    const v = (pct as Record<string, unknown>)[`p${p}`];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < prev) return null;
    percentiles[`p${p}`] = v;
    prev = v;
  }
  const nSamples = typeof r.nSamples === 'number' ? r.nSamples : 0;
  return {
    v: 1,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString(),
    nSamples,
    ready: r.ready === true && nSamples >= MIN_SCORE_SAMPLES,
    percentiles,
  };
}

/**
 * Mapeia vec_score → [0,1] por interpolação linear na CDF empírica.
 * Abaixo de p10 e acima de p95 extrapola com a inclinação da ponta, clampado.
 * Sem calibração pronta → null (o campo `confidence` sai omitido e o caller
 * cai no comportamento antigo, sem regressão).
 */
export function confidenceFromVec(
  vec: number,
  cal: ScoreCalibration | null,
): number | null {
  if (!cal?.ready || !Number.isFinite(vec)) return null;
  const pts: Array<[number, number]> = PCTS.map((p) => [
    cal.percentiles[`p${p}`] ?? 0,
    p / 100,
  ]);

  const [firstX, firstY] = pts[0]!;
  if (vec <= firstX) {
    // extrapola pra baixo com a inclinação p10→p25
    const [x1, y1] = pts[1]!;
    const slope = x1 > firstX ? (y1 - firstY) / (x1 - firstX) : 0;
    return Math.max(0, firstY + (vec - firstX) * slope);
  }

  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (vec <= x1) {
      if (x1 === x0) return y1;
      return y0 + ((vec - x0) / (x1 - x0)) * (y1 - y0);
    }
  }

  // acima de p95: inclinação p90→p95, clampado em 1
  const [xa, ya] = pts[pts.length - 2]!;
  const [xb, yb] = pts[pts.length - 1]!;
  const slope = xb > xa ? (yb - ya) / (xb - xa) : 0;
  return Math.min(1, yb + (vec - xb) * slope);
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
