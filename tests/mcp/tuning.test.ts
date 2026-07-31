import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CACHE_DIR precisa apontar pro tmp ANTES do import (config lê env no load)
const dir = await mkdtemp(join(tmpdir(), 'mcp-tuning-test-'));
process.env.CACHE_DIR = dir;

const { getTuning, resetTuningCache, sanitizeTuning, tuningEquals, DEFAULT_TUNING } = await import(
  '../../src/mcp/tuning.ts'
);

const tuningFile = join(dir, 'tuning.json');

describe('sanitizeTuning', () => {
  it('garbage total -> defaults', () => {
    assert.deepEqual(sanitizeTuning(null), DEFAULT_TUNING);
    assert.deepEqual(sanitizeTuning('x'), DEFAULT_TUNING);
    assert.deepEqual(sanitizeTuning(42), DEFAULT_TUNING);
  });

  it('campo a campo: válidos passam, inválidos caem no default', () => {
    const t = sanitizeTuning({ projectBoost: 1.3, perSourceKind: { plan: 1.1, bad: 'x' }, k: 'nope' });
    assert.equal(t.projectBoost, 1.3);
    assert.deepEqual(t.perSourceKind, { plan: 1.1 });
    assert.equal(t.k, DEFAULT_TUNING.k);
  });

  it('clampa fora dos bounds', () => {
    const t = sanitizeTuning({ projectBoost: 9, perSourceKind: { plan: 0.1 }, perProject: { '/p': 5 }, k: 999 });
    assert.equal(t.projectBoost, 1.5);
    assert.equal(t.perSourceKind.plan, 0.85);
    assert.equal(t.perProject['/p'], 1.2);
    assert.equal(t.k, 50);
  });
});

describe('tuningEquals', () => {
  const base = sanitizeTuning({
    projectBoost: 1.15,
    perSourceKind: { conversation: 0.917 },
    perProject: { '/a': 0.9, '/b': 0.959 },
    k: 8,
  });

  it('ignora updatedAt (candidate recém-gerado == tuning aplicado)', () => {
    assert.ok(tuningEquals({ ...base, updatedAt: '2026-01-01T00:00:00Z' }, { ...base, updatedAt: '2026-07-31T00:00:00Z' }));
  });

  it('ignora ordem das chaves dos records', () => {
    const flipped = { ...base, perProject: { '/b': 0.959, '/a': 0.9 } };
    assert.ok(tuningEquals(base, flipped));
  });

  it('detecta mudança de valor, de chave nova e de chave removida', () => {
    assert.ok(!tuningEquals(base, { ...base, projectBoost: 1.2 }));
    assert.ok(!tuningEquals(base, { ...base, k: 12 }));
    assert.ok(!tuningEquals(base, { ...base, perProject: { ...base.perProject, '/c': 1.0 } }));
    assert.ok(!tuningEquals(base, { ...base, perProject: { '/a': 0.9 } }));
    assert.ok(!tuningEquals(base, { ...base, perSourceKind: {} }));
  });
});

describe('getTuning', () => {
  before(() => resetTuningCache());

  it('arquivo ausente -> DEFAULT_TUNING (== comportamento sem loop)', async () => {
    await rm(tuningFile, { force: true });
    resetTuningCache();
    assert.deepEqual(getTuning(), DEFAULT_TUNING);
  });

  it('arquivo válido -> valores aplicados', async () => {
    await writeFile(
      tuningFile,
      JSON.stringify({ v: 1, updatedAt: '2026-06-10T00:00:00Z', projectBoost: 1.2, perSourceKind: { plan: 1.15 }, perProject: {}, k: 12 }),
    );
    resetTuningCache();
    const t = getTuning();
    assert.equal(t.projectBoost, 1.2);
    assert.equal(t.perSourceKind.plan, 1.15);
    assert.equal(t.k, 12);
  });

  it('arquivo corrupto -> defaults, sem lançar', async () => {
    await writeFile(tuningFile, '{ broken json');
    resetTuningCache();
    assert.deepEqual(getTuning(), DEFAULT_TUNING);
  });

  it('cache: segunda chamada não re-stata dentro da janela', async () => {
    await writeFile(
      tuningFile,
      JSON.stringify({ v: 1, updatedAt: '2026-06-10T00:00:00Z', projectBoost: 1.4, perSourceKind: {}, perProject: {}, k: 8 }),
    );
    resetTuningCache();
    assert.equal(getTuning().projectBoost, 1.4);
    await writeFile(tuningFile, '{ broken json');
    // dentro do RECHECK_MS o valor cacheado permanece
    assert.equal(getTuning().projectBoost, 1.4);
  });
});
