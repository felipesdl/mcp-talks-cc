import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { combineSignals, type CombineInput } from '../../src/learning/grading/grade.ts';
import { applyCalibration, calibrateEcho, dot } from '../../src/learning/grading/echo.ts';
import { computeDrillIn } from '../../src/learning/grading/drillIn.ts';
import type { QueryLogEntry } from '../../src/learning/types.ts';

function entry(over: Partial<QueryLogEntry> = {}): QueryLogEntry {
  return {
    v: 1,
    ts: '2026-06-10T12:00:00.000Z',
    tool: 'search_memory',
    sessionId: null,
    query: 'feature flag react query cache',
    k: null,
    scope: null,
    project: null,
    projectStrict: null,
    diversity: null,
    hybridUsed: false,
    nResults: 2,
    topScore: 0.8,
    scores: [0.8, 0.7],
    latencyMs: 100,
    hits: [
      { id: 'c1', sessionId: 's1', source: 'conversation', project: '/p/a', vecScore: 0.8, bm25Score: null },
      { id: 'c2', sessionId: 's2', source: 'plan', project: '/p/b', vecScore: 0.7, bm25Score: null },
    ],
    ...over,
  };
}

function combineInput(over: Partial<CombineInput> = {}): CombineInput {
  return {
    signals: { echoRaw: null, echoCalibrated: null, reformulated: null, drillIn: null, zeroHit: false },
    joinMethod: 'session',
    ambiguous: false,
    assistantTextChars: 1000,
    nHits: 3,
    queryTokens: 5,
    ...over,
  };
}

describe('combineSignals', () => {
  it('zero-hit: utility 0, confidence 1 (falha inequívoca)', () => {
    const r = combineSignals(
      combineInput({ signals: { echoRaw: null, echoCalibrated: null, reformulated: null, drillIn: null, zeroHit: true } }),
    );
    assert.deepEqual(r, { utility: 0, confidence: 1 });
  });

  it('sem nenhum sinal: neutro com confidence quase nula', () => {
    const r = combineSignals(combineInput());
    assert.equal(r.utility, 0.5);
    assert.equal(r.confidence, 0.05);
  });

  // O join por time-window com 2+ sessões candidatas escolhe a mais provável e
  // marca ambiguous, em vez de descartar o sinal: sinal com confidence menor
  // vale mais que sinal nenhum.
  it('ambiguous derruba confidence mas mantém o sinal utilizável', () => {
    const signals = {
      echoRaw: 0.7,
      echoCalibrated: 0.8,
      reformulated: null,
      drillIn: null,
      zeroHit: false,
    };
    const claro = combineSignals(combineInput({ signals, joinMethod: 'timeWindow' }));
    const ambiguo = combineSignals(
      combineInput({ signals, joinMethod: 'timeWindow', ambiguous: true }),
    );
    assert.equal(claro.utility, ambiguo.utility, 'utility não depende do join');
    assert.ok(
      ambiguo.confidence < claro.confidence,
      `ambiguous deveria penalizar: ${ambiguo.confidence} vs ${claro.confidence}`,
    );
    assert.ok(
      ambiguo.confidence > 0.05,
      'ainda tem que valer mais que o caso "nenhum sinal" (0.05)',
    );
  });

  it('echo não calibrado tem peso 0 (só echoRaw presente -> sem sinal)', () => {
    const r = combineSignals(
      combineInput({ signals: { echoRaw: 0.85, echoCalibrated: null, reformulated: null, drillIn: null, zeroHit: false } }),
    );
    assert.equal(r.utility, 0.5, 'echoRaw sem calibração não entra na utility');
  });

  it('echo calibrado vira a utility quando é o único sinal', () => {
    const r = combineSignals(
      combineInput({ signals: { echoRaw: 0.8, echoCalibrated: 0.75, reformulated: null, drillIn: null, zeroHit: false } }),
    );
    assert.ok(Math.abs(r.utility - 0.75) < 1e-9);
  });

  it('drill-in domina echo (peso 0.45 vs 0.35)', () => {
    const r = combineSignals(
      combineInput({ signals: { echoRaw: 0.5, echoCalibrated: 0.2, reformulated: null, drillIn: true, zeroHit: false } }),
    );
    // (0.45*1 + 0.35*0.2) / 0.8 = 0.65
    assert.ok(Math.abs(r.utility - 0.65) < 1e-9);
  });

  it('reformulação puxa pra baixo', () => {
    const withReform = combineSignals(
      combineInput({ signals: { echoRaw: 0.8, echoCalibrated: 0.9, reformulated: true, drillIn: null, zeroHit: false } }),
    );
    const without = combineSignals(
      combineInput({ signals: { echoRaw: 0.8, echoCalibrated: 0.9, reformulated: null, drillIn: null, zeroHit: false } }),
    );
    assert.ok(withReform.utility < without.utility);
  });

  it('timeWindow join + ambíguo reduz confidence vs session join', () => {
    const signals = { echoRaw: 0.8, echoCalibrated: 0.7, reformulated: null, drillIn: null, zeroHit: false };
    const session = combineSignals(combineInput({ signals }));
    const tw = combineSignals(combineInput({ signals, joinMethod: 'timeWindow', ambiguous: true }));
    assert.ok(tw.confidence < session.confidence);
  });

  it('confidence nunca sai de [0.05, 1]', () => {
    const r = combineSignals(
      combineInput({
        signals: { echoRaw: 0.1, echoCalibrated: 0.1, reformulated: null, drillIn: null, zeroHit: false },
        joinMethod: 'timeWindow',
        ambiguous: true,
        assistantTextChars: 50,
        nHits: 1,
        queryTokens: 2,
      }),
    );
    assert.ok(r.confidence >= 0.05 && r.confidence <= 1);
  });
});

describe('calibrateEcho / applyCalibration', () => {
  it('não fica ready abaixo de minSamples e applyCalibration devolve null', () => {
    const cal = calibrateEcho([0.5, 0.6, 0.7], 50);
    assert.equal(cal.ready, false);
    assert.equal(applyCalibration(0.8, cal), null);
  });

  it('ready com amostras suficientes; floor=p40, ceil=p90', () => {
    const raws = Array.from({ length: 100 }, (_, i) => i / 100); // 0.00..0.99
    const cal = calibrateEcho(raws, 50);
    assert.equal(cal.ready, true);
    assert.ok(Math.abs(cal.floor - 0.4) < 0.05, `floor ~p40, got ${cal.floor}`);
    assert.ok(Math.abs(cal.ceil - 0.9) < 0.05, `ceil ~p90, got ${cal.ceil}`);
    assert.equal(applyCalibration(cal.floor, cal), 0);
    assert.equal(applyCalibration(cal.ceil, cal), 1);
    const mid = applyCalibration((cal.floor + cal.ceil) / 2, cal);
    assert.ok(mid !== null && mid > 0.4 && mid < 0.6);
  });

  it('clampa fora do range', () => {
    const cal = calibrateEcho(Array.from({ length: 60 }, (_, i) => 0.3 + i / 200), 50);
    assert.equal(applyCalibration(0.0, cal), 0);
    assert.equal(applyCalibration(0.99, cal), 1);
  });
});

describe('computeDrillIn', () => {
  const base = entry();

  it('transcript de sessão dos hits credita o hit certo', () => {
    const later = [
      entry({ ts: '2026-06-10T12:05:00.000Z', tool: 'get_session_transcript', refSessionId: 's1', hits: [] }),
    ];
    const r = computeDrillIn(base, later);
    assert.equal(r.drillIn, true);
    assert.deepEqual(r.creditedHitIds, ['c1']);
  });

  it('find_similar_chunks num chunk dos hits credita por id', () => {
    const later = [
      entry({ ts: '2026-06-10T12:03:00.000Z', tool: 'find_similar_chunks', refChunkId: 'c2', hits: [] }),
    ];
    const r = computeDrillIn(base, later);
    assert.equal(r.drillIn, true);
    assert.deepEqual(r.creditedHitIds, ['c2']);
  });

  it('fora da janela de 10min não conta', () => {
    const later = [
      entry({ ts: '2026-06-10T12:20:00.000Z', tool: 'get_session_transcript', refSessionId: 's1', hits: [] }),
    ];
    const r = computeDrillIn(base, later);
    assert.equal(r.drillIn, null);
  });

  it('sem drill-in: null (ausência não é negativo)', () => {
    assert.equal(computeDrillIn(base, []).drillIn, null);
  });
});

describe('dot', () => {
  it('vetores normalizados: dot == cosine', () => {
    assert.equal(dot([1, 0], [1, 0]), 1);
    assert.equal(dot([1, 0], [0, 1]), 0);
  });
});
