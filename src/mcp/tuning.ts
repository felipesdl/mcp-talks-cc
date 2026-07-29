import { readFileSync, statSync } from 'node:fs';
import { learningPaths } from '../learning/paths.ts';
import { TUNING_BOUNDS, type Tuning } from '../learning/types.ts';

// Defaults de retrieval — única fonte (antes duplicados em searchMemory.ts).
// lambda e peso hybrid NÃO são tunados pelo loop (decisão: tuner coadjuvante);
// o self-tune apenas comenta sobre eles no rationale.
export const LAMBDA_DEFAULT = 0.7;
export const HYBRID_VEC_WEIGHT = 0.7;

// Decay de recência: multiplica SÓ o termo de relevância do MMR (ranking),
// nunca o score reportado. Sem isso um chunk de janeiro empata com o de ontem.
// Floor alto de propósito: memória velha ainda é o valor do produto.
export const RECENCY_HALFLIFE_DAYS = 120;
export const RECENCY_FLOOR = 0.75;

export const DEFAULT_TUNING: Tuning = {
  v: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  projectBoost: 1.15,
  perSourceKind: {},
  perProject: {},
  k: 8,
};

const RECHECK_MS = 60_000;

let _tuning: Tuning = DEFAULT_TUNING;
let _lastCheck = 0;
let _lastMtimeMs = -1;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function clampRecord(
  raw: unknown,
  bounds: { min: number; max: number },
): Record<string, number> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      out[key] = clamp(val, bounds.min, bounds.max);
    }
  }
  return out;
}

/** Sanitiza campo a campo: arquivo meio-escrito não envenena o resto. */
export function sanitizeTuning(raw: unknown): Tuning {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_TUNING;
  const r = raw as Record<string, unknown>;
  return {
    v: 1,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : DEFAULT_TUNING.updatedAt,
    projectBoost:
      typeof r.projectBoost === 'number' && Number.isFinite(r.projectBoost)
        ? clamp(r.projectBoost, TUNING_BOUNDS.projectBoost.min, TUNING_BOUNDS.projectBoost.max)
        : DEFAULT_TUNING.projectBoost,
    perSourceKind: clampRecord(r.perSourceKind, TUNING_BOUNDS.perSourceKind),
    perProject: clampRecord(r.perProject, TUNING_BOUNDS.perProject),
    k:
      typeof r.k === 'number' && Number.isInteger(r.k)
        ? clamp(r.k, TUNING_BOUNDS.k.min, TUNING_BOUNDS.k.max)
        : DEFAULT_TUNING.k,
  };
}

/**
 * Tuning aceito (tuning.json), cacheado em module scope.
 * Re-stat no máx 1x/min; entre checks, zero syscall.
 * Ausente/corrupto → último valor bom ou defaults (== comportamento sem loop).
 */
export function getTuning(): Tuning {
  const now = Date.now();
  if (now - _lastCheck < RECHECK_MS) return _tuning;
  _lastCheck = now;
  try {
    const st = statSync(learningPaths.tuning);
    if (st.mtimeMs === _lastMtimeMs) return _tuning;
    _lastMtimeMs = st.mtimeMs;
    _tuning = sanitizeTuning(JSON.parse(readFileSync(learningPaths.tuning, 'utf8')));
  } catch {
    _lastMtimeMs = -1;
    _tuning = DEFAULT_TUNING;
  }
  return _tuning;
}

/** Só p/ testes: zera o cache do módulo. */
export function resetTuningCache(): void {
  _tuning = DEFAULT_TUNING;
  _lastCheck = 0;
  _lastMtimeMs = -1;
}
