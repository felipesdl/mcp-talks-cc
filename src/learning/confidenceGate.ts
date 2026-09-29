// Gate de citação: a partir de que confidence vale citar um hit de memória.
//
// Mora em módulo próprio porque tem TRÊS consumidores (tuner p/ o rationale,
// profile p/ persistir, primer p/ publicar no SessionStart) e o cálculo não pode
// ser duplicado: com dois lugares computando o mesmo percentil eles divergem, e o
// CLAUDE.md passa a apontar pra um valor que nenhum dos dois gerou.
import { readFileSync } from 'node:fs';
import { confidenceFromVec } from '../mcp/scoreCalibration.ts';
import { learningPaths } from './paths.ts';
import type { ConfidenceGate, Grade, QueryLogEntry, ScoreCalibration } from './types.ts';

/** Percentil por ordem, sobre lista JÁ ordenada crescente. */
export function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))]!;
}

/**
 * p75/p25 da confidence do MELHOR hit por query.
 *
 * É 1 ponto por query, então a amostra é pequena e o número DERIVA: medido em
 * 2026-08-24, `strong` andou de 0.89 pra 0.91 com 5 queries novas, sem a CDF de
 * score mudar. Por isso o gate é publicado a cada sessão em vez de virar
 * constante em doc.
 *
 * null quando a calibração de score não está pronta: aí `confidence` sai null no
 * search_memory e não existe gate a publicar.
 */
/** Gate do bench vale por 14 dias: depois disso o corpus mudou o bastante pra re-rodar. */
const BENCH_GATE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

/**
 * Gate derivado do gabarito (bench:recall): a confidence a partir da qual os
 * hits são relevantes de fato. É o que deve ir pro CLAUDE.md/primer. null se
 * não houver bench recente.
 */
export function benchGate(path: string = learningPaths.benchGate): ConfidenceGate | null {
  try {
    const g = JSON.parse(readFileSync(path, 'utf8')) as { at: string; strong: number; floor: number; nCases: number };
    if (Date.now() - Date.parse(g.at) > BENCH_GATE_MAX_AGE_MS) return null;
    if (typeof g.strong !== 'number' || typeof g.floor !== 'number') return null;
    return { strong: g.strong, floor: g.floor, nQueries: g.nCases, source: 'bench' };
  } catch {
    return null;
  }
}

export function suggestGate(
  graded: Array<{ entry: QueryLogEntry; grade: Grade }>,
  scoreCalibration: ScoreCalibration | null,
  // explícito (não lido aqui dentro) pra função seguir pura e testável;
  // os callers passam benchGate()
  fromBench: ConfidenceGate | null = null,
): ConfidenceGate | null {
  if (!scoreCalibration?.ready) return null;
  // Gabarito vence cota: o p75/p25 abaixo aprova 25% das queries como "forte"
  // por construção, relevante ou não.
  if (fromBench) return fromBench;
  const searches = graded.filter((g) => g.entry.tool === 'search_memory');
  // o piso da própria query entra no cálculo pra bater com o que search_memory
  // reporta (min entre percentil absoluto e de margem)
  const topConfs = searches
    .map((g) => {
      const vs = g.entry.hits.map(
        (h) => confidenceFromVec(h.vecScore, scoreCalibration, g.entry.poolVecMedian) ?? 0,
      );
      return vs.length > 0 ? Math.max(...vs) : 0;
    })
    .sort((a, b) => a - b);
  const strong = pct(topConfs, 75);
  const floor = pct(topConfs, 25);
  if (strong === null || floor === null) return null;
  return { strong, floor, nQueries: topConfs.length, source: 'quota' };
}
