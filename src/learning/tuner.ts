import { confidenceFromVec } from '../mcp/scoreCalibration.ts';
import { MIN_ECHO_SAMPLES, MIN_SCORE_SAMPLES, TUNING_BOUNDS, type EchoCalibration, type Grade, type Profile, type QueryLogEntry, type ScoreCalibration, type Tuning } from './types.ts';

export const MIN_SAMPLES = 30;
const MIN_HITS_PER_BUCKET = 20;
const MIN_PROJECT_ARG_QUERIES = 10;

function clamp(v: number, b: { min: number; max: number }): number {
  return Math.min(b.max, Math.max(b.min, v));
}

export interface TuningProposal {
  candidate: Tuning | null; // null = dados insuficientes
  rationale: string;
}

/**
 * Tuner coadjuvante: propõe SÓ boosts de ranking bounded, nunca aplica.
 * lambda/hybridVecWeight ficam como observação textual no rationale.
 */
export function buildTuningProposal(
  graded: Array<{ entry: QueryLogEntry; grade: Grade }>,
  profile: Profile,
  current: Tuning,
  calibration: EchoCalibration | null,
  scoreCalibration: ScoreCalibration | null = null,
): TuningProposal {
  const searches = graded.filter((g) => g.entry.tool === 'search_memory');
  const n = searches.length;
  const lines: string[] = [
    '# tuning-rationale',
    '',
    `gerado em ${new Date().toISOString()} | ${n} queries graded | mean utility ${profile.lastEval.meanUtility.toFixed(2)}`,
    '',
  ];

  if (calibration) {
    lines.push(
      `## echo`,
      calibration.ready
        ? `calibrado com ${calibration.nSamples} amostras: floor=p40=${calibration.floor.toFixed(3)}, ceil=p90=${calibration.ceil.toFixed(3)}`
        : `coletando distribuição: ${calibration.nSamples}/${MIN_ECHO_SAMPLES} amostras — echo com peso 0 na utility até calibrar`,
      `percentis: ${Object.entries(calibration.percentiles).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' ')}`,
      '',
    );
  }

  // Distribuição observada de confidence: é daqui que saem os cortes do
  // CLAUDE.md ("cita se conf >= X"), em vez de número chutado.
  if (scoreCalibration) {
    lines.push('## score / confidence');
    if (scoreCalibration.ready) {
      // passa o piso da query pra confidence do rationale bater com a que o
      // search_memory reporta (min entre percentil absoluto e de margem)
      const confs = searches
        .flatMap((g) =>
          g.entry.hits.map((h) =>
            confidenceFromVec(h.vecScore, scoreCalibration, g.entry.poolVecMedian),
          ),
        )
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      const q = (p: number): string =>
        confs.length > 0
          ? confs[Math.min(confs.length - 1, Math.round((p / 100) * (confs.length - 1)))]!.toFixed(2)
          : '-';
      const topConfs = searches
        .map((g) => {
          const vs = g.entry.hits.map(
            (h) => confidenceFromVec(h.vecScore, scoreCalibration, g.entry.poolVecMedian) ?? 0,
          );
          return vs.length > 0 ? Math.max(...vs) : 0;
        })
        .sort((a, b) => a - b);
      const qt = (p: number): string =>
        topConfs.length > 0
          ? topConfs[Math.min(topConfs.length - 1, Math.round((p / 100) * (topConfs.length - 1)))]!.toFixed(2)
          : '-';
      lines.push(
        `calibrado com ${scoreCalibration.nSamples} vec_scores | percentis vec: ${Object.entries(scoreCalibration.percentiles).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' ')}`,
        `confidence de todos os hits: p25=${q(25)} p50=${q(50)} p75=${q(75)} p90=${q(90)}`,
        `confidence do MELHOR hit por query: p25=${qt(25)} p50=${qt(50)} p75=${qt(75)} p90=${qt(90)}`,
        `sugestão de gate pro CLAUDE.md: forte >= ${qt(75)}, fraco entre ${qt(25)} e ${qt(75)}, ignorar < ${qt(25)}`,
        '',
      );
    } else {
      lines.push(
        `coletando: ${scoreCalibration.nSamples}/${MIN_SCORE_SAMPLES} vec_scores — search_memory devolve confidence=null até calibrar`,
        '',
      );
    }
  }

  if (n < MIN_SAMPLES) {
    lines.push(`## proposta`, '', `dados insuficientes (${n}/${MIN_SAMPLES} grades). Nenhum candidate gerado; search_memory segue com defaults/tuning atual.`);
    return { candidate: null, rationale: lines.join('\n') };
  }

  const meanUtility = profile.lastEval.meanUtility;

  // perSourceKind: boost proporcional ao desvio da média, com gate de amostra
  const perSourceKind: Record<string, number> = {};
  lines.push('## perSourceKind');
  for (const [source, { meanUtility: u, n: hits }] of Object.entries(profile.sourceKindUtility)) {
    if (hits < MIN_HITS_PER_BUCKET) {
      lines.push(`- ${source}: ${hits} hits graded (< ${MIN_HITS_PER_BUCKET}), sem proposta`);
      continue;
    }
    const boost = clamp(1 + 0.3 * (u - meanUtility), TUNING_BOUNDS.perSourceKind);
    perSourceKind[source] = Number(boost.toFixed(3));
    lines.push(`- ${source}: utility ${u.toFixed(2)} vs média ${meanUtility.toFixed(2)} em ${hits} hits → boost ${boost.toFixed(3)}`);
  }

  // perProject: afinidade aprendida (aplica mesmo sem arg project)
  const perProject: Record<string, number> = {};
  lines.push('', '## perProject');
  const projHits = new Map<string, { sum: number; n: number }>();
  for (const { entry, grade } of searches) {
    const credits = new Map(grade.hitCredits.map((c) => [c.id, c.credit]));
    for (const hit of entry.hits) {
      if (!hit.project) continue;
      const p = projHits.get(hit.project) ?? { sum: 0, n: 0 };
      p.sum += (credits.get(hit.id) ?? 0) * grade.confidence;
      p.n++;
      projHits.set(hit.project, p);
    }
  }
  for (const [project, { sum, n: hits }] of projHits) {
    if (hits < MIN_HITS_PER_BUCKET) continue;
    const u = sum / hits;
    const boost = clamp(1 + 0.3 * (u - meanUtility), TUNING_BOUNDS.perProject);
    perProject[project] = Number(boost.toFixed(3));
    lines.push(`- ${project}: utility ${u.toFixed(2)} em ${hits} hits → boost ${boost.toFixed(3)}`);
  }
  if (Object.keys(perProject).length === 0) lines.push('- nenhum projeto com amostra suficiente');

  // projectBoost: compara utility de hits same-repo vs cross-repo quando arg project foi usado
  let projectBoost = current.projectBoost;
  lines.push('', '## projectBoost (soft boost do arg project)');
  const withProject = searches.filter((g) => g.entry.project && !g.entry.projectStrict);
  if (withProject.length >= MIN_PROJECT_ARG_QUERIES) {
    let same = { sum: 0, n: 0 };
    let cross = { sum: 0, n: 0 };
    for (const { entry, grade } of withProject) {
      const credits = new Map(grade.hitCredits.map((c) => [c.id, c.credit]));
      for (const hit of entry.hits) {
        const bucket = hit.project === entry.project ? same : cross;
        bucket.sum += (credits.get(hit.id) ?? 0) * grade.confidence;
        bucket.n++;
      }
    }
    if (same.n >= MIN_HITS_PER_BUCKET && cross.n >= MIN_HITS_PER_BUCKET) {
      const uSame = same.sum / same.n;
      const uCross = cross.sum / cross.n;
      projectBoost = Number(clamp(1 + 0.5 * (uSame - uCross), TUNING_BOUNDS.projectBoost).toFixed(3));
      lines.push(
        `- same-repo utility ${uSame.toFixed(2)} (${same.n} hits) vs cross-repo ${uCross.toFixed(2)} (${cross.n} hits) → projectBoost ${projectBoost}`,
      );
    } else {
      lines.push(`- amostra por bucket insuficiente (same=${same.n}, cross=${cross.n}), mantém ${projectBoost}`);
    }
  } else {
    lines.push(`- só ${withProject.length} queries com arg project (< ${MIN_PROJECT_ARG_QUERIES}), mantém ${projectBoost}`);
  }

  // observações (NUNCA viram candidate): lambda / hybridVecWeight
  const reformRate = searches.filter((g) => g.grade.signals.reformulated === true).length / n;
  const zeroHitRate = searches.filter((g) => g.grade.signals.zeroHit).length / n;
  lines.push(
    '',
    '## observações (sem proposta — lambda e peso hybrid não são tunados)',
    `- taxa de reformulação: ${(reformRate * 100).toFixed(0)}%${reformRate > 0.25 ? ' (alta — considere diversity maior em queries amplas, ou queries mais específicas)' : ''}`,
    `- taxa de zero-hit: ${(zeroHitRate * 100).toFixed(0)}%${zeroHitRate > 0.15 ? ` (alta — termos problemáticos: ${profile.queryShapes.zeroHitTerms.slice(0, 5).join(', ') || '-'})` : ''}`,
    `- literal vs NL: ${profile.queryShapes.literalVsNL.lit} lit / ${profile.queryShapes.literalVsNL.nl} nl (BM25 só ativa com tokens literais)`,
  );

  const candidate: Tuning = {
    v: 1,
    updatedAt: new Date().toISOString(),
    projectBoost,
    perSourceKind,
    perProject,
    k: current.k,
  };

  lines.push('', '## aplicar', '', '```', 'npm run self-tune:accept', '```');
  return { candidate, rationale: lines.join('\n') };
}
