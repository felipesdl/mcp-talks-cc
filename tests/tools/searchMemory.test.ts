import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient } from '../helpers.ts';

interface SearchHit {
  score: number;
  source: string;
  sessionId: string | null;
  project: string | null;
  snippet: string;
}

interface SearchResult {
  structuredContent: { hits: SearchHit[] };
}

describe('search_memory tool', () => {
  let client: Client;

  before(async () => {
    client = await createTestClient();
  });

  after(async () => {
    await client.close();
  });

  it('lists 6 tools', async () => {
    const r = await client.listTools();
    const names = r.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'find_decisions',
      'find_related_plans',
      'find_similar_chunks',
      'get_session_transcript',
      'list_project_activity',
      'search_memory',
    ]);
  });

  it('returns hits for a known query', async () => {
    const r = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 3 },
    })) as unknown as SearchResult;
    assert.ok(Array.isArray(r.structuredContent.hits), 'hits should be array');
    assert.ok(r.structuredContent.hits.length > 0, 'should return at least 1 hit');
    for (const h of r.structuredContent.hits) {
      assert.ok(typeof h.score === 'number');
      assert.ok(h.snippet.length > 0);
    }
  });

  it('respects scope filter', async () => {
    const r = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'plano', k: 5, scope: ['plan'] },
    })) as unknown as SearchResult;
    for (const h of r.structuredContent.hits) {
      assert.equal(h.source, 'plan', 'all hits should have source=plan');
    }
  });

  it('project is soft boost; projectStrict hard-filters', async () => {
    const base = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 5 },
    })) as unknown as SearchResult;
    const anyProject = base.structuredContent.hits.find((h) => h.project)?.project;
    if (!anyProject) return; // dataset sem projectPath — nada a verificar

    const strict = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 5, project: anyProject, projectStrict: true },
    })) as unknown as SearchResult;
    for (const h of strict.structuredContent.hits) {
      assert.equal(h.project, anyProject, 'strict mode must hard-filter by project');
    }

    const soft = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 5, project: anyProject },
    })) as unknown as SearchResult;
    assert.ok(soft.structuredContent.hits.length > 0, 'soft boost must still return hits');
    // soft: scores ficam crus (<= 1.0 sempre, boost não vaza pro score)
    for (const h of soft.structuredContent.hits) {
      assert.ok(h.score <= 1.000001, 'reported score must stay raw (no boost inflation)');
    }
  });

  it('rejects empty query (Zod or isError)', async () => {
    let rejected = false;
    let isError = false;
    try {
      const r = (await client.callTool({
        name: 'search_memory',
        arguments: { query: '', k: 3 },
      })) as unknown as { isError?: boolean; structuredContent?: { isError?: boolean } };
      isError = !!(r.isError || r.structuredContent?.isError);
    } catch {
      rejected = true;
    }
    assert.ok(rejected || isError, 'empty query should fail validation (reject or isError)');
  });
});
