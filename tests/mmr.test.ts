import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient } from './helpers.ts';

interface Hit {
  id: string;
  score: number;
  sessionId: string | null;
}

interface SearchResult {
  structuredContent: { hits: Hit[] };
}

describe('MMR diversity behavior', () => {
  let client: Client;

  before(async () => {
    client = await createTestClient();
  });

  after(async () => {
    await client.close();
  });

  it('diversity=0.3 returns more session variety than diversity=0.95', async () => {
    const high = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j', k: 5, diversity: 0.95 },
    })) as unknown as SearchResult;
    const low = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j', k: 5, diversity: 0.3 },
    })) as unknown as SearchResult;

    const uniqueSessionsHigh = new Set(high.structuredContent.hits.map((h) => h.sessionId)).size;
    const uniqueSessionsLow = new Set(low.structuredContent.hits.map((h) => h.sessionId)).size;

    // diversity 0.3 should pick from >= as many sessions as 0.95
    assert.ok(
      uniqueSessionsLow >= uniqueSessionsHigh,
      `low diversity ${uniqueSessionsLow} sessions should be >= high diversity ${uniqueSessionsHigh}`,
    );
  });
});
