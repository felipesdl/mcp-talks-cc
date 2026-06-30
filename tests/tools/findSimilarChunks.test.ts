import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient } from '../helpers.ts';

interface Hit {
  id: string;
  score: number;
  source: string;
  sessionId: string | null;
}

interface SearchResult {
  structuredContent: { hits: Hit[] };
}

describe('find_similar_chunks tool', () => {
  let client: Client;
  let seedChunkId: string;

  before(async () => {
    client = await createTestClient();
    const r = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j mcp', k: 3 },
    })) as unknown as SearchResult;
    const first = r.structuredContent.hits[0];
    if (!first) throw new Error('no seed chunk');
    seedChunkId = first.id;
  });

  after(async () => {
    await client.close();
  });

  it('lists find_similar_chunks in tools/list', async () => {
    const t = await client.listTools();
    assert.ok(
      t.tools.some((x) => x.name === 'find_similar_chunks'),
      'find_similar_chunks should be registered',
    );
  });

  it('returns neighbors above threshold', async () => {
    const r = (await client.callTool({
      name: 'find_similar_chunks',
      arguments: { chunkId: seedChunkId, k: 5, minScore: 0.75 },
    })) as unknown as SearchResult;
    assert.ok(Array.isArray(r.structuredContent.hits));
    for (const h of r.structuredContent.hits) {
      assert.ok(h.score >= 0.75, `score ${h.score} must be >= threshold`);
      assert.notEqual(h.id, seedChunkId, 'should not return self');
    }
  });

  it('returns empty array for unknown chunkId', async () => {
    const r = (await client.callTool({
      name: 'find_similar_chunks',
      arguments: { chunkId: 'nonexistent-chunk-id-xyz', k: 5 },
    })) as unknown as SearchResult;
    assert.deepEqual(r.structuredContent.hits, []);
  });
});
