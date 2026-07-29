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

  // Regressão: já aconteceu de writeMessages() não gravar m.text, e o
  // transcript vinha com todas as mensagens vazias (matando também o echo do
  // self-tune). Transcript sem texto é transcript inútil.
  it('devolve mensagens COM texto de uma sessão real', async () => {
    const search = (await client.callTool({
      name: 'search_memory',
      arguments: { query: 'neo4j MCP', k: 10 },
    })) as unknown as { structuredContent: { hits: Array<{ sessionId: string | null }> } };
    const sessionIds = [
      ...new Set(search.structuredContent.hits.map((h) => h.sessionId).filter((s): s is string => !!s)),
    ];
    if (sessionIds.length === 0) return; // grafo vazio: nada a verificar

    let comTexto = 0;
    for (const sid of sessionIds.slice(0, 5)) {
      const r = (await client.callTool({
        name: 'get_session_transcript',
        arguments: { sessionId: sid, limit: 50 },
      })) as unknown as TranscriptResult;
      if (!r.structuredContent.found) continue;
      comTexto += r.structuredContent.messages.filter((m) => m.text.trim().length > 0).length;
    }
    assert.ok(
      comTexto > 0,
      'nenhuma mensagem com texto: Message.text não está sendo gravado (rodar npm run backfill:message-text)',
    );
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
