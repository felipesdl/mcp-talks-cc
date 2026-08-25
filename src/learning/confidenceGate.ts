// Gate de citação: a partir de que confidence vale citar um hit de memória.
//
// Mora em módulo próprio porque tem TRÊS consumidores (tuner p/ o rationale,
// profile p/ persistir, primer p/ publicar no SessionStart) e o cálculo não pode
// ser duplicado: com dois lugares computando o mesmo percentil eles divergem, e o
// CLAUDE.md passa a apontar pra um valor que nenhum dos dois gerou.
import { confidenceFromVec } from '../mcp/scoreCalibration.ts';
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
export function suggestGate(
  graded: Array<{ entry: QueryLogEntry; grade: Grade }>,
  scoreCalibration: ScoreCalibration | null,
): ConfidenceGate | null {
  if (!scoreCalibration?.ready) return null;
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
  return { strong, floor, nQueries: topConfs.length };
}
