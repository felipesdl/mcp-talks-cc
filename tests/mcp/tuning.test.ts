import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CACHE_DIR precisa apontar pro tmp ANTES do import (config lê env no load)
const dir = await mkdtemp(join(tmpdir(), 'mcp-tuning-test-'));
process.env.CACHE_DIR = dir;

const { getTuning, resetTuningCache, sanitizeTuning, DEFAULT_TUNING } = await import(
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
