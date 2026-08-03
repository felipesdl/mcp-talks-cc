import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueryLogEntry } from '../../src/learning/types.ts';

const MOD = '../../src/learning/queryLog.ts';

function entry(query: string): QueryLogEntry {
  return {
    v: 1,
    ts: new Date().toISOString(),
    tool: 'search_memory',
    sessionId: null,
    query,
    k: 3,
    scope: null,
    project: null,
    projectStrict: null,
    diversity: null,
    hybridUsed: false,
    nResults: 1,
    topScore: 0.9,
    scores: [0.9],
    latencyMs: 1,
    hits: [],
    poolVecMedian: 0.88,
  };
}

// `DISABLED` é lido no load do módulo, então cada caso precisa de uma instância
// nova: o sufixo de query string força o ESM a não reusar o cache.
async function loadWith(env: Record<string, string>, tag: string) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const mod = await import(`${MOD}?${tag}`);
  return { mod, restore: () => Object.assign(process.env, saved) };
}

describe('logQuery — kill switch da instrumentação', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-talks-qlog-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('não escreve nada com MCP_TALKS_DISABLE_QUERY_LOG=1', async () => {
    const { mod, restore } = await loadWith(
      { CACHE_DIR: dir, MCP_TALKS_DISABLE_QUERY_LOG: '1' },
      'off',
    );
    try {
      await mod.logQuery(entry('neo4j MCP'));
      const read = await readFile(join(dir, 'query-log.jsonl'), 'utf8').catch(() => null);
      assert.equal(read, null, 'query-log não deveria existir com o log desligado');
    } finally {
      restore();
    }
  });

  it('escreve normalmente sem a variável', async () => {
    const { mod, restore } = await loadWith({ CACHE_DIR: dir }, 'on');
    try {
      await mod.logQuery(entry('busca real'));
      const read = await readFile(join(dir, 'query-log.jsonl'), 'utf8');
      assert.ok(read.includes('busca real'));
      assert.ok(!read.includes('neo4j MCP'), 'a entrada do caso desligado não deveria ter vazado');
    } finally {
      restore();
    }
  });
});
