import { parseArgs } from 'node:util';
import { readdir, stat, rm, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { isUnchanged } from '../ingest/checkpoint.ts';
import { gcDecision, isTaskFolderId, taskNodeKey } from '../ingest/taskFolders.ts';
import type { PrState } from '../ingest/taskFolders.ts';

/**
 * Apaga pasta de task que já cumpriu o papel: todos os PRs mergeados, ou parada
 * há TASKS_IDLE_DAYS dias. Só depois de todo `.md` dela estar no grafo
 * (checkpoint do ingest igual ao arquivo atual), então a memória fica.
 *
 * Dry-run por padrão. Nunca segue symlink, nunca sai de TASKS_HOME.
 */

const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
const apply = values.apply as boolean;
const DAY = 86_400_000;

async function walk(dir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push({ path: p, mtimeMs: (await stat(p)).mtimeMs });
  }
  return out;
}

async function main(): Promise<void> {
  const root = config.paths.tasksHome;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const folders = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && isTaskFolderId(e.name));
  if (folders.length === 0) {
    console.log('[tasks-gc] nenhuma pasta');
    return;
  }
  const logFile = join(config.paths.cacheDir, 'tasks-gc.log');
  await mkdir(config.paths.cacheDir, { recursive: true });

  await withSession(async (s) => {
    for (const e of folders) {
      const dir = join(root, e.name);
      const files = await walk(dir);
      const md = files.filter((f) => f.path.endsWith('.md'));
      const ingested = (await Promise.all(md.map((f) => isUnchanged(f.path)))).every(Boolean);
      const last = Math.max((await stat(dir)).mtimeMs, ...files.map((f) => f.mtimeMs));
      const idleDays = Math.floor((Date.now() - last) / DAY);
      const { key } = taskNodeKey(e.name);
      const r = await s.run(
        `MATCH (pr:PullRequest)-[:FOR_TASK]->(:Task { key: $key }) RETURN collect(pr.state) AS states`,
        { key },
      );
      const prStates = (r.records[0]?.get('states') as PrState[]) ?? [];
      const d = gcDecision({ ingested, prStates, idleDays, idleLimit: config.taskFolders.idleDays });
      console.log(
        `[tasks-gc] ${e.name}: ${d.action} (${d.reason}) prs=${prStates.join('/') || '-'} parado=${idleDays}d md=${md.length}`,
      );
      if (!apply || d.action !== 'delete') continue;
      await rm(dir, { recursive: true, force: true });
      await s.run(
        `MATCH (f:TaskFolder { path: $path }) SET f.present = false, f.deletedAt = toString(datetime()), f.deletedReason = $reason`,
        { path: dir, reason: d.reason },
      );
      await appendFile(logFile, `${new Date().toISOString()} ${e.name} ${d.reason} md=${md.length}\n`);
    }
  });
}

try {
  await main();
} catch (e) {
  console.error('[tasks-gc] falhou:', e);
} finally {
  await closeDriver();
}
