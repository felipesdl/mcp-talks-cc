import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CACHE_DIR precisa estar setado ANTES do import (config.ts lê no load), por
// isso o import é dinâmico.
const TMP = mkdtempSync(join(tmpdir(), 'mcp-talks-caller-'));
process.env.CACHE_DIR = TMP;
const { resolveCallerSession, resetCallerSessionCache, cwdSlug, sessionFileFor } =
  await import('../../src/mcp/callerSession.ts');

const CWD = '/Users/alguem/Documents/code/px-painel';

function writeSession(sessionId: string, ageMs = 0): void {
  mkdirSync(join(TMP, 'sessions'), { recursive: true });
  const file = sessionFileFor(CWD);
  writeFileSync(
    file,
    JSON.stringify({ sessionId, project: CWD, updatedEpoch: Math.floor(Date.now() / 1000) }),
  );
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(file, t, t);
  }
}

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('cwdSlug', () => {
  it('bate com o slug do bash (tr -c [:alnum:] -)', () => {
    assert.equal(cwdSlug(CWD), '-Users-alguem-Documents-code-px-painel');
  });
});

describe('resolveCallerSession', () => {
  it('sem arquivo: sessionId null, project = cwd', () => {
    resetCallerSessionCache();
    const r = resolveCallerSession(CWD);
    assert.equal(r.sessionId, null);
    assert.equal(r.project, CWD);
  });

  it('lê o registro escrito pelo hook SessionStart', () => {
    writeSession('sess-abc');
    resetCallerSessionCache();
    const r = resolveCallerSession(CWD);
    assert.equal(r.sessionId, 'sess-abc');
    assert.equal(r.project, CWD);
  });

  it('registro com mais de 24h é descartado (sessão morta)', () => {
    writeSession('sess-velha', 25 * 3600 * 1000);
    resetCallerSessionCache();
    assert.equal(resolveCallerSession(CWD).sessionId, null);
  });

  it('JSON corrompido não lança', () => {
    mkdirSync(join(TMP, 'sessions'), { recursive: true });
    writeFileSync(sessionFileFor(CWD), '{ isso nao e json');
    resetCallerSessionCache();
    assert.equal(resolveCallerSession(CWD).sessionId, null);
  });

  it('CLAUDE_SESSION_ID na env tem prioridade', () => {
    writeSession('sess-do-arquivo');
    resetCallerSessionCache();
    process.env.CLAUDE_SESSION_ID = 'sess-da-env';
    try {
      assert.equal(resolveCallerSession(CWD).sessionId, 'sess-da-env');
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
    }
  });
});
