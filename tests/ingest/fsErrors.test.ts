import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { countReadError, isVanished } from '../../src/ingest/fsErrors.ts';
import { parseSessionFile } from '../../src/ingest/sources/conversations.ts';

// Caso real: transcript listado no glob e apagado pelo cleanup do Claude Code
// antes da leitura derrubava o run inteiro no arquivo 223/370.
describe('arquivo que sumiu entre o glob e a leitura', () => {
  const missing = join(tmpdir(), `mcp-talks-missing-${process.pid}.jsonl`);

  it('parseSessionFile rejeita com ENOENT capturável (não é erro assíncrono solto)', async () => {
    await assert.rejects(parseSessionFile(missing, false), (err) => isVanished(err));
  });

  it('ENOENT conta como vanished, sem virar failed', () => {
    const c = { vanished: 0, failed: 0 };
    countReadError('t', 'x', Object.assign(new Error('x'), { code: 'ENOENT' }), c);
    assert.deepEqual(c, { vanished: 1, failed: 0 });
  });

  it('outro erro de I/O conta como failed', () => {
    const c = { vanished: 0, failed: 0 };
    const orig = console.error;
    console.error = () => {};
    try {
      countReadError('t', 'x', Object.assign(new Error('x'), { code: 'EACCES' }), c);
    } finally {
      console.error = orig;
    }
    assert.deepEqual(c, { vanished: 0, failed: 1 });
  });

  it('erro sem code (ex.: driver) não é tratado como vanished', () => {
    assert.equal(isVanished(new Error('Neo4j connection refused')), false);
    assert.equal(isVanished(null), false);
  });
});
