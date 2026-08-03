import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function createTestClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      '--env-file=.env',
      '--experimental-strip-types',
      'src/mcp/server.ts',
    ],
    // busca sintética da suite não pode entrar no query-log real: é dali que
    // saem a calibração de score e as grades do self-tune.
    env: { ...process.env, MCP_TALKS_DISABLE_QUERY_LOG: '1' } as Record<string, string>,
  });
  const client = new Client(
    { name: 'mcp-talks-cc-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}
