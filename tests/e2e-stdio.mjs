import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const proc = spawn(
  'node',
  ['--env-file=.env', '--experimental-strip-types', 'src/mcp/server.ts'],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);

const rl = createInterface({ input: proc.stdout });
let nextId = 1;
const pending = new Map();

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function call(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const init = await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'e2e-test', version: '0.0.1' },
});
console.log('init:', init.result?.serverInfo);

proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = await call('tools/list', {});
console.log('tools:', tools.result?.tools.map((t) => t.name));

// 1. Hybrid w/ literal token
const hybrid = await call('tools/call', {
  name: 'search_memory',
  arguments: { query: 'ABC-123', k: 3 },
});
console.log('\n=== hybrid ABC-123 ===');
const hits1 = hybrid.result?.structuredContent?.hits ?? [];
for (const h of hits1) {
  console.log(
    `score=${h.score.toFixed(3)} vec=${h.vec_score.toFixed(3)} bm25=${h.bm25_score?.toFixed(3) ?? '-'} session=${h.sessionId?.slice(0, 8)}`,
  );
  console.log('  ', h.snippet.slice(0, 120));
}

// 2. MMR diversity comparison
const lowDiv = await call('tools/call', {
  name: 'search_memory',
  arguments: { query: 'react', k: 5, diversity: 0.3 },
});
const highDiv = await call('tools/call', {
  name: 'search_memory',
  arguments: { query: 'react', k: 5, diversity: 0.95 },
});
const lowSessions = new Set(lowDiv.result.structuredContent.hits.map((h) => h.sessionId)).size;
const highSessions = new Set(highDiv.result.structuredContent.hits.map((h) => h.sessionId)).size;
console.log(`\n=== MMR diversity ===`);
console.log(`diversity=0.3 → ${lowSessions} unique sessions`);
console.log(`diversity=0.95 → ${highSessions} unique sessions`);

// 3. find_similar_chunks traversal
if (hits1[0]?.id) {
  const similar = await call('tools/call', {
    name: 'find_similar_chunks',
    arguments: { chunkId: hits1[0].id, k: 3 },
  });
  console.log(`\n=== find_similar_chunks (seed=${hits1[0].id.slice(0, 8)}) ===`);
  for (const h of similar.result?.structuredContent?.hits ?? []) {
    console.log(
      `score=${h.score.toFixed(3)} source=${h.source} session=${h.sessionId?.slice(0, 8) ?? '-'}`,
    );
  }
}

// 4. memory://schema
const schema = await call('resources/read', { uri: 'memory://schema' });
console.log(`\n=== schema doc (${schema.result?.contents?.[0]?.text?.length} chars) ===`);
console.log(schema.result?.contents?.[0]?.text?.split('\n').slice(0, 5).join('\n'));

proc.kill();
