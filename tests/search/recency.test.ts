import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recencyMult, saturateBm25 } from '../../src/mcp/tools/searchMemory.ts';
import { RECENCY_FLOOR, RECENCY_HALFLIFE_DAYS } from '../../src/mcp/tuning.ts';

const NOW = Date.parse('2026-07-28T00:00:00.000Z');
const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();

describe('recencyMult', () => {
  it('chunk de hoje não sofre decay', () => {
    assert.equal(recencyMult(daysAgo(0), NOW), 1);
  });

  it('meia-vida derruba pro esperado (respeitando o floor)', () => {
    const expected = Math.max(RECENCY_FLOOR, 0.5);
    assert.ok(
      Math.abs(recencyMult(daysAgo(RECENCY_HALFLIFE_DAYS), NOW) - expected) < 1e-9,
      'na meia-vida o multiplicador deve ser max(floor, 0.5)',
    );
  });

  it('é monotônico decrescente na idade', () => {
    const a = recencyMult(daysAgo(10), NOW);
    const b = recencyMult(daysAgo(60), NOW);
    const c = recencyMult(daysAgo(400), NOW);
    assert.ok(a >= b && b >= c, `esperado a>=b>=c, veio ${a} ${b} ${c}`);
  });

  it('nunca desce do floor', () => {
    assert.equal(recencyMult(daysAgo(5000), NOW), RECENCY_FLOOR);
  });

  it('timestamp ausente ou inválido é neutro', () => {
    assert.equal(recencyMult(null, NOW), 1);
    assert.equal(recencyMult('nao-e-data', NOW), 1);
  });
});

describe('saturateBm25', () => {
  it('mediana vira ~0.5 e nada chega a 1.0', () => {
    const out = saturateBm25([1, 2, 4, 8, 16]);
    assert.ok(Math.abs(out[2]! - 0.5) < 1e-9, `mediana deveria saturar em 0.5, veio ${out[2]}`);
    for (const v of out) assert.ok(v < 1, `nenhum valor pode chegar a 1.0, veio ${v}`);
  });

  it('preserva a ordem', () => {
    const out = saturateBm25([3, 1, 9, 5]);
    assert.deepEqual(
      [...out].sort((a, b) => a - b),
      [out[1]!, out[0]!, out[3]!, out[2]!],
    );
  });

  it('lista vazia e zeros não explodem', () => {
    assert.deepEqual(saturateBm25([]), []);
    assert.deepEqual(saturateBm25([0, 0]), [0, 0]);
  });
});
