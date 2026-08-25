import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTuningProposal, MIN_SAMPLES } from '../../src/learning/tuner.ts';
import { suggestGate } from '../../src/learning/confidenceGate.ts';
import { DEFAULT_TUNING } from '../../src/mcp/tuning.ts';
import type {
  EchoCalibration,
  Grade,
  Profile,
  QueryLogEntry,
  ScoreCalibration,
} from '../../src/learning/types.ts';

const PROJECT = '/p/web-app'; // projeto fictício; o real vem do corpus em runtime

function entry(i: number): QueryLogEntry {
  return {
    v: 1,
    ts: `2026-08-${String(1 + (i % 20)).padStart(2, '0')}T12:00:${String(i % 60).padStart(2, '0')}.000Z`,
    tool: 'search_memory',
    sessionId: `s${i}`,
    query: `query ${i}`,
    k: 1,
    scope: null,
    project: null,
    projectStrict: null,
    diversity: null,
    hybridUsed: false,
    nResults: 1,
    topScore: 0.89,
    scores: [0.89],
    latencyMs: 100,
    poolVecMedian: 0.88,
    hits: [
      { id: `h${i}`, sessionId: `s${i}`, source: 'conversation', project: PROJECT, vecScore: 0.89, bm25Score: null },
    ],
  };
}

function grade(i: number, credit: number): Grade {
  return {
    v: 1,
    ts: `2026-08-24T00:00:00.000Z`,
    queryTs: entry(i).ts,
    utility: 0.5,
    confidence: 1,
    signals: { echoRaw: 0.8, echoCalibrated: credit, reformulated: null, drillIn: null, zeroHit: false },
    joinMethod: 'session',
    hitCredits: [{ id: `h${i}`, credit }],
  };
}

/** n queries gradadas, todas com o mesmo credit por hit. */
function graded(n: number, credit: number): Array<{ entry: QueryLogEntry; grade: Grade }> {
  return Array.from({ length: n }, (_, i) => ({ entry: entry(i), grade: grade(i, credit) }));
}

function profile(sourceUtility: number, meanUtility: number, hits = 30): Profile {
  return {
    v: 1,
    generatedAt: '2026-08-24T00:00:00.000Z',
    windowDays: 30,
    topProjects: [{ path: PROJECT, name: 'web-app', share: 1, meanUtility: sourceUtility }],
    projectClusters: [],
    recurringTopics: [],
    terminology: [],
    sourceKindUtility: { conversation: { meanUtility: sourceUtility, n: hits } },
    queryShapes: { zeroHitTerms: [], medianK: 6, literalVsNL: { lit: 0, nl: 30 } },
    recentHighValue: [],
    lastEval: { ranAt: '2026-08-24T00:00:00.000Z', queriesGraded: 30, meanUtility, healthy: true },
  };
}

function echo(over: Partial<EchoCalibration> = {}): EchoCalibration {
  return {
    v: 1,
    updatedAt: '2026-08-24T00:00:00.000Z',
    nSamples: 40,
    ready: true,
    floor: 0.767,
    ceil: 0.836,
    percentiles: { p10: 0.72, p25: 0.76, p40: 0.767, p50: 0.78, p75: 0.81, p90: 0.836, p95: 0.843 },
    ...over,
  };
}

describe('buildTuningProposal — gate de echo', () => {
  it('echo não calibrado -> sem candidate, mesmo com grades de sobra', () => {
    // O bug que isso trava: credit é 0 por construção quando o echo não está
    // calibrado, e 1 + 0.3 * (0 - mean) virava penalidade nas fontes mais usadas.
    const { candidate, rationale } = buildTuningProposal(
      graded(MIN_SAMPLES, 0),
      profile(0, 0.21),
      DEFAULT_TUNING,
      echo({ ready: false, nSamples: 23 }),
    );
    assert.equal(candidate, null);
    assert.match(rationale, /sem proposta: echo não calibrado \(23\/30 amostras\)/);
    // nenhuma linha de proposta de boost (o "→ boost X" que o tuner emite por bucket)
    assert.doesNotMatch(rationale, /→ boost/);
  });

  it('echo ausente -> sem candidate', () => {
    const { candidate, rationale } = buildTuningProposal(
      graded(MIN_SAMPLES, 0),
      profile(0, 0.21),
      DEFAULT_TUNING,
      null,
    );
    assert.equal(candidate, null);
    assert.match(rationale, /sem amostra/);
  });

  it('echo ready MAS grades sem echo calibrado -> sem candidate, e manda regradar', () => {
    // O run em que o echo fecha: arquivo diz ready, mas gradeEntry congelou
    // echoCalibrated=null nas grades antigas e a recalibração rodou depois.
    // Sem esse gate, esse run propõe penalidade (medido: 0.902 em conversation).
    const stale = graded(MIN_SAMPLES, 0).map((g) => ({
      ...g,
      grade: { ...g.grade, signals: { ...g.grade.signals, echoCalibrated: null } },
    }));
    const { candidate, rationale, blockedBy } = buildTuningProposal(
      stale,
      profile(0, 0.33),
      DEFAULT_TUNING,
      echo(),
    );
    assert.equal(candidate, null);
    assert.match(rationale, /só 0\/30 grades carregam echo calibrado/);
    assert.match(rationale, /--regrade-from=all/);
    assert.match(blockedBy!, /--regrade-from=all/);
  });

  it('maioria calibrada -> passa o gate e propõe', () => {
    const mixed = graded(MIN_SAMPLES, 1).map((g, i) =>
      i < 10 // 20/30 calibradas = 67%, acima do piso de 50%
        ? { ...g, grade: { ...g.grade, signals: { ...g.grade.signals, echoCalibrated: null } } }
        : g,
    );
    const { candidate } = buildTuningProposal(mixed, profile(0.6, 0.2), DEFAULT_TUNING, echo());
    assert.ok(candidate);
  });

  it('grades insuficientes vence antes do gate de echo', () => {
    const { candidate, rationale } = buildTuningProposal(
      graded(MIN_SAMPLES - 1, 1),
      profile(0.6, 0.2),
      DEFAULT_TUNING,
      echo(),
    );
    assert.equal(candidate, null);
    assert.match(rationale, /dados insuficientes/);
  });
});

describe('buildTuningProposal — com echo calibrado', () => {
  it('fonte acima da média ganha boost > 1', () => {
    const { candidate } = buildTuningProposal(
      graded(MIN_SAMPLES, 1),
      profile(0.6, 0.2),
      DEFAULT_TUNING,
      echo(),
    );
    assert.ok(candidate);
    assert.ok(
      candidate!.perSourceKind.conversation! > 1,
      `esperado boost > 1, veio ${candidate!.perSourceKind.conversation}`,
    );
    assert.ok(candidate!.perProject[PROJECT]! > 1);
  });

  it('credit zero COM echo calibrado é medição, não artefato: penaliza', () => {
    // Contraponto do gate: zero observado com calibração pronta é sinal legítimo.
    // O gate existe pra distinguir isso de zero estrutural, não pra proibir queda.
    const { candidate } = buildTuningProposal(
      graded(MIN_SAMPLES, 0),
      profile(0, 0.21),
      DEFAULT_TUNING,
      echo(),
    );
    assert.ok(candidate);
    assert.ok(
      candidate!.perSourceKind.conversation! < 1,
      `esperado boost < 1, veio ${candidate!.perSourceKind.conversation}`,
    );
  });
});

function scoreCal(over: Partial<ScoreCalibration> = {}): ScoreCalibration {
  return {
    v: 1,
    updatedAt: '2026-08-24T00:00:00.000Z',
    nSamples: 222,
    ready: true,
    percentiles: { p10: 0.862, p25: 0.871, p40: 0.877, p50: 0.880, p75: 0.890, p90: 0.900, p95: 0.906 },
    ...over,
  };
}

/** n queries, cada uma com 1 hit de vec_score crescente. */
function gradedWithVec(n: number, base: number): Array<{ entry: QueryLogEntry; grade: Grade }> {
  return Array.from({ length: n }, (_, i) => {
    const e = entry(i);
    e.hits[0]!.vecScore = base + i * 0.001;
    return { entry: e, grade: grade(i, 0.5) };
  });
}

describe('suggestGate', () => {
  it('calibração não pronta -> null (é o estado em que confidence sai null)', () => {
    assert.equal(suggestGate(gradedWithVec(20, 0.87), scoreCal({ ready: false })), null);
    assert.equal(suggestGate(gradedWithVec(20, 0.87), null), null);
  });

  it('sem query nenhuma -> null', () => {
    assert.equal(suggestGate([], scoreCal()), null);
  });

  it('devolve floor <= strong e conta a amostra por QUERY, não por hit', () => {
    const g = suggestGate(gradedWithVec(20, 0.87), scoreCal());
    assert.ok(g);
    assert.ok(g!.floor <= g!.strong, `floor ${g!.floor} > strong ${g!.strong}`);
    assert.equal(g!.nQueries, 20);
    assert.ok(g!.strong >= 0 && g!.strong <= 1);
  });

  it('corpus mais similar -> gate mais alto (o número deriva com o dado)', () => {
    const baixo = suggestGate(gradedWithVec(20, 0.862), scoreCal())!;
    const alto = suggestGate(gradedWithVec(20, 0.895), scoreCal())!;
    assert.ok(alto.strong > baixo.strong, `${alto.strong} deveria ser > ${baixo.strong}`);
  });
});
