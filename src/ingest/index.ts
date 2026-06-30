import { parseArgs } from 'node:util';
import { closeDriver } from '../neo4j/driver.ts';
import { save as saveCheckpoint } from './checkpoint.ts';
import { ingestConversations } from './sources/conversations.ts';

type Source = 'conversations' | 'plans' | 'todos' | 'tasks' | 'all';

const { values } = parseArgs({
  options: {
    source: { type: 'string', default: 'conversations' },
    limit: { type: 'string' },
    force: { type: 'boolean', default: false },
    'include-tool-outputs': { type: 'boolean', default: false },
  },
});

const source = values.source as Source;
const limit = values.limit ? parseInt(values.limit, 10) : undefined;
const force = !!values.force;
const includeToolOutputs = !!values['include-tool-outputs'];

async function run(): Promise<void> {
  console.error(
    `[ingest] source=${source} limit=${limit ?? '-'} force=${force} includeToolOutputs=${includeToolOutputs}`,
  );

  if (source === 'conversations' || source === 'all') {
    const r = await ingestConversations({ limit, force, includeToolOutputs });
    console.error(`[ingest] conversations:`, r);
  }

  if (source === 'plans' || source === 'all') {
    const m = await import('./sources/plans.ts').catch(() => null);
    if (m?.ingestPlans) {
      const r = await m.ingestPlans({ force });
      console.error(`[ingest] plans:`, r);
    } else {
      console.error('[ingest] plans source not implemented yet');
    }
  }

  if (source === 'todos' || source === 'all') {
    const m = await import('./sources/todos.ts').catch(() => null);
    if (m?.ingestTodos) {
      const r = await m.ingestTodos({ force });
      console.error(`[ingest] todos:`, r);
    } else {
      console.error('[ingest] todos source not implemented yet');
    }
  }

  if (source === 'tasks' || source === 'all') {
    const m = await import('./sources/taskMemory.ts').catch(() => null);
    if (m?.ingestTaskMemory) {
      const r = await m.ingestTaskMemory({ force });
      console.error(`[ingest] tasks:`, r);
    } else {
      console.error('[ingest] task memory source not implemented yet');
    }
  }
}

try {
  await run();
  await saveCheckpoint();
  console.error('[ingest] done');
} catch (e) {
  console.error('[ingest] failed:', e);
  process.exitCode = 1;
} finally {
  await closeDriver();
}
