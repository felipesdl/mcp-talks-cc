import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient } from '../helpers.ts';

interface TranscriptResult {
  structuredContent: {
    found: boolean;
    sessionId: string;
    messages: Array<{ role: string; text: string }>;
    hint?: string;
  };
}

describe('get_session_transcript tool', () => {
  let client: Client;

  before(async () => {
    client = await createTestClient();
  });

  after(async () => {
    await client.close();
  });

  it('returns found=false for unknown sessionId', async () => {
    const r = (await client.callTool({
      name: 'get_session_transcript',
      arguments: { sessionId: '00000000-0000-0000-0000-000000000000', limit: 10 },
    })) as unknown as TranscriptResult;
    assert.equal(r.structuredContent.found, false);
    assert.ok(r.structuredContent.hint);
  });

  it('rejects non-uuid sessionId (Zod or isError)', async () => {
    let rejected = false;
    let isError = false;
    try {
      const r = (await client.callTool({
        name: 'get_session_transcript',
        arguments: { sessionId: 'not-a-uuid', limit: 10 },
      })) as unknown as { isError?: boolean; structuredContent?: { isError?: boolean } };
      isError = !!(r.isError || r.structuredContent?.isError);
    } catch {
      rejected = true;
    }
    assert.ok(rejected || isError, 'non-uuid should fail validation');
  });
});
