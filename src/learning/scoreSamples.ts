import { readFileSync } from 'node:fs';
import { buildScoreCalibration } from '../mcp/scoreCalibration.ts';
import { MIN_SCORE_SAMPLES, type QueryLogEntry, type ScoreCalibration } from './types.ts';
import { learningPaths } from './paths.ts';

/**
 * Amostras que alimentam a CDF de vec_score (e de margem) por trás da
 * `confidence`.
 *
 * Antes era "todo hit dos últimos 30 dias". A distribuição de cosseno depende
 * do embedder e do corpus, não da data, então a janela por tempo só servia pra
 * desligar a calibração quando o uso caía: em 2026-09-29 setembro teve pouca
 * busca, a janela encolheu pra 193/200 amostras e `confidence` voltou a null,
 * deixando o gate do CLAUDE.md inerte. Agora são as últimas N amostras reais do
 * log inteiro (N segura deriva de corpus sem depender de tráfego recente) mais
 * as amostras de probe sintético (src/cli/calibrateProbe.ts), que garantem
 * calibração pronta desde o primeiro dia.
 */

export const MAX_REAL_SAMPLES = 1500;

export interface ProbeSamples {
  v: 1;
  generatedAt: string;
  nQueries: number;
  vecScores: number[];
  margins: number[];
}

export function realSamples(
  entries: QueryLogEntry[],
  max = MAX_REAL_SAMPLES,
): { vecScores: number[]; margins: number[] } {
  const searches = entries
    .filter((e) => e.tool === 'search_memory')
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const vecScores: number[] = [];
  const margins: number[] = [];
  // do mais novo pro mais velho até encher
  for (let i = searches.length - 1; i >= 0 && vecScores.length < max; i--) {
    const e = searches[i]!;
    for (const h of e.hits) {
      vecScores.push(h.vecScore);
      if (typeof e.poolVecMedian === 'number') margins.push(h.vecScore - e.poolVecMedian);
    }
  }
  return { vecScores, margins };
}

export function readProbeSamples(path: string = learningPaths.probeSamples): ProbeSamples | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ProbeSamples;
    if (!Array.isArray(raw.vecScores) || !Array.isArray(raw.margins)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** CDF real + probe. É a única forma de montar score-calibration.json. */
export function mergedScoreCalibration(
  entries: QueryLogEntry[],
  probe: ProbeSamples | null = readProbeSamples(),
): ScoreCalibration & { nReal: number; nProbe: number } {
  const real = realSamples(entries);
  const vec = [...real.vecScores, ...(probe?.vecScores ?? [])];
  const margins = [...real.margins, ...(probe?.margins ?? [])];
  return {
    ...buildScoreCalibration(vec, MIN_SCORE_SAMPLES, margins),
    nReal: real.vecScores.length,
    nProbe: probe?.vecScores.length ?? 0,
  };
}
