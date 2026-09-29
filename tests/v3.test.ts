import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gistOf, stripWrappers } from '../src/ingest/quality.ts';
import { isTrivialPrompt } from '../src/mcp/push.ts';
import { usageStats } from '../src/learning/usage.ts';
import { benchNotWorse, type BenchResult } from '../src/learning/recallBench.ts';
import { realSamples } from '../src/learning/scoreSamples.ts';
import { suggestGate } from '../src/learning/confidenceGate.ts';
import type { QueryLogEntry, ScoreCalibration } from '../src/learning/types.ts';

function entry(p: Partial<QueryLogEntry>): QueryLogEntry {
  return {
    v: 1,
    ts: '2026-09-29T10:00:00.000Z',
    tool: 'search_memory',
    sessionId: 's1',
    query: 'q',
    k: 8,
    scope: null,
    project: null,
    projectStrict: null,
    diversity: null,
    hybridUsed: false,
    nResults: 0,
    topScore: null,
    scores: [],
    latencyMs: 1,
    hits: [],
    ...p,
  };
}

describe('gistOf', () => {
  it('corta em limite de palavra e marca reticência', () => {
    const g = gistOf('Decidimos usar RRF com k igual a sessenta no lugar da soma ponderada porque as escalas não eram comensuráveis entre cosseno e bm25 saturado de jeito nenhum', 80);
    assert.ok(g.length <= 81);
    assert.ok(g.endsWith('…'));
    assert.ok(!/\s…$/.test(g));
  });

  it('pula fragmento de overlap que começa no meio da palavra', () => {
    const g = gistOf('iveCandidatesOnFreight` quebra aqui. O bloqueio agora pega o caso da fila espelho.');
    assert.ok(g.startsWith('O bloqueio'), g);
  });

  it('pula anúncio inicial mas mantém a entrega', () => {
    const g = gistOf('Vou verificar o arquivo. O limite de convites é por empresa, não por operador.');
    assert.ok(g.startsWith('O limite'), g);
  });

  it('não mexe em texto curto e limpo', () => {
    assert.equal(gistOf('Token literal liga o BM25.'), 'Token literal liga o BM25.');
  });
});

describe('stripWrappers: aviso do mcp repassado', () => {
  it('remove só a linha do aviso, mantém o resto', () => {
    const t = stripWrappers('Antes de tudo, um aviso do mcp-talks-cc: tem uma proposta de tuning nova.\nO fix do mktemp usa template com 6 Xs.');
    assert.equal(t, 'O fix do mktemp usa template com 6 Xs.');
  });
});

describe('isTrivialPrompt', () => {
  for (const p of ['ok', 'sim pode', 'beleza!', 'commit', '/clear', 'faz isso']) {
    it(`trivial: "${p}"`, () => assert.equal(isTrivialPrompt(p), true));
  }
  for (const p of ['como funciona a fila de espera do contrato espelho?', 'vamos mexer na justificativa de postergação']) {
    it(`não trivial: "${p.slice(0, 30)}"`, () => assert.equal(isTrivialPrompt(p), false));
  }
});

describe('usageStats', () => {
  it('conta push expandido só com expand do mesmo id, mesma sessão, dentro da janela', () => {
    const hit = { id: 'c1', sessionId: 'old', source: 'conversation', project: null, vecScore: 0.9, bm25Score: null };
    const entries = [
      entry({ tool: 'search_memory', sessionId: 'a' }),
      entry({ tool: 'push', sessionId: 'b', ts: '2026-09-29T10:00:00.000Z', hits: [hit] }),
      entry({ tool: 'expand_hits', sessionId: 'b', ts: '2026-09-29T10:05:00.000Z', refChunkIds: ['c1'] }),
      entry({ tool: 'push', sessionId: 'c', ts: '2026-09-29T10:00:00.000Z', hits: [{ ...hit, id: 'c2' }] }),
      entry({ tool: 'expand_hits', sessionId: 'c', ts: '2026-09-29T11:00:00.000Z', refChunkIds: ['c2'] }),
      entry({ tool: 'push', sessionId: 'd', hits: [] }),
    ];
    const u = usageStats(entries, '2026-09-01', 30, 10);
    assert.equal(u.pushes.evaluated, 3);
    assert.equal(u.pushes.fired, 2);
    assert.equal(u.pushes.expanded, 1);
    assert.equal(u.sessionsWithSearch, 1);
    // sessões ativas: a (busca) + b (push expandido)
    assert.equal(u.adoption, 0.2);
  });
});

describe('benchNotWorse', () => {
  const base = { recallAtK: 0.8, mrr: 0.6 } as BenchResult;
  it('perder um caso de recall bloqueia', () => {
    assert.equal(benchNotWorse({ ...base, recallAtK: 0.78 } as BenchResult, base), false);
  });
  it('reordenação pequena de MRR passa', () => {
    assert.equal(benchNotWorse({ ...base, mrr: 0.595 } as BenchResult, base), true);
  });
  it('queda de MRR além da folga bloqueia', () => {
    assert.equal(benchNotWorse({ ...base, mrr: 0.58 } as BenchResult, base), false);
  });
});

describe('realSamples', () => {
  it('pega as últimas N amostras, sem janela de tempo', () => {
    const mk = (ts: string, v: number): QueryLogEntry =>
      entry({ ts, poolVecMedian: 0.8, hits: [{ id: ts, sessionId: null, source: 'conversation', project: null, vecScore: v, bm25Score: null }] });
    const r = realSamples([mk('2026-01-01', 0.1), mk('2026-09-01', 0.2), mk('2026-09-02', 0.3)], 2);
    assert.deepEqual(r.vecScores.sort(), [0.2, 0.3]);
    assert.equal(r.margins.length, 2);
  });
});

describe('suggestGate com bench', () => {
  it('gate do bench vence a cota quando existe', () => {
    const cal = { ready: true, percentiles: { p10: 0.8, p25: 0.82, p40: 0.84, p50: 0.85, p75: 0.87, p90: 0.9, p95: 0.92 } } as unknown as ScoreCalibration;
    const g = suggestGate([], cal, { strong: 0.94, floor: 0.35, nQueries: 39, source: 'bench' });
    assert.equal(g?.source, 'bench');
    assert.equal(g?.strong, 0.94);
  });
});
