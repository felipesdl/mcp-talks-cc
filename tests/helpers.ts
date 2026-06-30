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
    env: process.env as Record<string, string>,
  });
  const client = new Client(
    { name: 'mcp-talks-cc-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}
