import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScoreCalibration,
  confidenceFromVec,
  sanitizeScoreCalibration,
} from '../../src/mcp/scoreCalibration.ts';
import { MIN_SCORE_SAMPLES } from '../../src/learning/types.ts';

// Distribuição parecida com a real do bge-m3: tudo empilhado entre 0.80 e 0.95.
// É exatamente por isso que corte absoluto no score não separava nada.
function sampleScores(n = MIN_SCORE_SAMPLES + 50): number[] {
  return Array.from({ length: n }, (_, i) => 0.8 + (0.15 * i) / (n - 1));
}

describe('buildScoreCalibration', () => {
  it('não fica ready abaixo do mínimo de amostras', () => {
    const cal = buildScoreCalibration([0.8, 0.9]);
    assert.equal(cal.ready, false);
    assert.equal(cal.nSamples, 2);
  });

  it('fica ready com amostra suficiente e percentis monotônicos', () => {
    const cal = buildScoreCalibration(sampleScores());
    assert.equal(cal.ready, true);
    const ps = [10, 25, 40, 50, 75, 90, 95].map((p) => cal.percentiles[`p${p}`]!);
    for (let i = 1; i < ps.length; i++) {
      assert.ok(ps[i]! >= ps[i - 1]!, `p${i} deveria ser >= anterior`);
    }
  });

  it('ignora valores não finitos', () => {
    const cal = buildScoreCalibration([...sampleScores(), NaN, Infinity]);
    assert.equal(cal.nSamples, MIN_SCORE_SAMPLES + 50);
  });
});

describe('confidenceFromVec', () => {
  const cal = buildScoreCalibration(sampleScores());

  it('sem calibração pronta devolve null', () => {
    assert.equal(confidenceFromVec(0.9, null), null);
    assert.equal(confidenceFromVec(0.9, buildScoreCalibration([0.9])), null);
  });

  it('mapeia a mediana pra ~0.5', () => {
    const c = confidenceFromVec(cal.percentiles.p50!, cal)!;
    assert.ok(Math.abs(c - 0.5) < 0.02, `esperado ~0.5, veio ${c}`);
  });

  it('discrimina hits que o score cru empatava', () => {
    const alto = confidenceFromVec(cal.percentiles.p90!, cal)!;
    const baixo = confidenceFromVec(cal.percentiles.p25!, cal)!;
    assert.ok(alto - baixo > 0.5, `contraste esperado > 0.5, veio ${alto - baixo}`);
  });

  it('é monotônico e clampado em [0,1]', () => {
    let prev = -1;
    for (const v of [0.1, 0.5, 0.79, 0.85, 0.9, 0.94, 0.99, 1]) {
      const c = confidenceFromVec(v, cal)!;
      assert.ok(c >= 0 && c <= 1, `fora de [0,1]: ${c}`);
      assert.ok(c >= prev, `deveria ser monotônico: ${c} < ${prev}`);
      prev = c;
    }
  });
});

// Margens reais são pequenas e centradas perto de zero: o pool inteiro cabe em
// ~0.04 de cosseno (medido em 2026-08-03).
function sampleMargins(n = MIN_SCORE_SAMPLES + 50): number[] {
  return Array.from({ length: n }, (_, i) => -0.02 + (0.04 * i) / (n - 1));
}

describe('confidenceFromVec — corte relativo ao piso da query', () => {
  const calAbs = buildScoreCalibration(sampleScores());
  const calRel = buildScoreCalibration(sampleScores(), MIN_SCORE_SAMPLES, sampleMargins());

  it('só habilita o corte relativo com amostra de margem', () => {
    assert.equal(calAbs.marginPercentiles, undefined);
    assert.ok(calRel.marginPercentiles);
  });

  it('hit sentado na mediana do pool não passa de ~0.5, mesmo com vec alto', () => {
    const vecAlto = calRel.percentiles.p95!;
    // margem zero = o hit está exatamente no piso da própria query
    const c = confidenceFromVec(vecAlto, calRel, vecAlto)!;
    assert.ok(c <= 0.55, `esperado <= 0.55 (ruído no piso), veio ${c}`);
    // sem o termo relativo, o mesmo hit tirava nota máxima
    assert.ok(confidenceFromVec(vecAlto, calAbs)! > 0.9);
  });

  it('hit bem acima do piso mantém confidence alta', () => {
    const vecAlto = calRel.percentiles.p95!;
    const c = confidenceFromVec(vecAlto, calRel, vecAlto - 0.02)!;
    assert.ok(c > 0.9, `esperado > 0.9 (margem no topo), veio ${c}`);
  });

  it('sem poolMedian o resultado é idêntico ao comportamento antigo', () => {
    for (const v of [0.82, 0.87, 0.9, 0.94]) {
      assert.equal(confidenceFromVec(v, calRel), confidenceFromVec(v, calAbs));
    }
  });
});

describe('sanitizeScoreCalibration', () => {
  it('rejeita lixo e percentil fora de ordem', () => {
    assert.equal(sanitizeScoreCalibration(null), null);
    assert.equal(sanitizeScoreCalibration({ percentiles: {} }), null);
    const cal = buildScoreCalibration(sampleScores());
    const quebrado = { ...cal, percentiles: { ...cal.percentiles, p90: 0.1 } };
    assert.equal(sanitizeScoreCalibration(quebrado), null);
  });

  it('aceita arquivo válido e recalcula ready pelo nSamples', () => {
    const cal = buildScoreCalibration(sampleScores());
    const ok = sanitizeScoreCalibration(JSON.parse(JSON.stringify(cal)));
    assert.ok(ok);
    assert.equal(ok.ready, true);

    const poucos = sanitizeScoreCalibration({ ...cal, nSamples: 3 });
    assert.ok(poucos);
    assert.equal(poucos.ready, false, 'ready precisa ser recalculado, não confiado do arquivo');
  });

  it('marginPercentiles corrompido só desliga o corte relativo', () => {
    const cal = buildScoreCalibration(sampleScores(), MIN_SCORE_SAMPLES, sampleMargins());
    const quebrado = sanitizeScoreCalibration({
      ...cal,
      marginPercentiles: { ...cal.marginPercentiles, p90: -99 },
    });
    assert.ok(quebrado, 'calibração absoluta deve sobreviver');
    assert.equal(quebrado.ready, true);
    assert.equal(quebrado.marginPercentiles, undefined);
  });

  it('arquivo antigo sem marginPercentiles segue válido', () => {
    const cal = buildScoreCalibration(sampleScores());
    const ok = sanitizeScoreCalibration(JSON.parse(JSON.stringify(cal)));
    assert.ok(ok);
    assert.equal(ok.ready, true);
    assert.equal(ok.marginPercentiles, undefined);
  });
});
