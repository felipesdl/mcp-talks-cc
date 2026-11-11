import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { config } from '../config.ts';
import { taskKeyFromBranch } from '../ingest/entities.ts';
import { isTaskFolderId, parseTaskMeta, taskNodeKey } from '../ingest/taskFolders.ts';
import type { TaskMeta } from '../ingest/taskFolders.ts';

/**
 * Pasta de trabalho da task atual, a partir do git do cwd. Não toca no Neo4j:
 * roda de qualquer repo/worktree, inclusive sem o docker de pé.
 *
 *   task-folder path          caminho da pasta desta branch/worktree (exit 1 se não tiver)
 *   task-folder init [ID]     cria (ou completa) a pasta; ID padrão: key da branch, senão nome do worktree
 *   task-folder link KEY      a task apareceu: renomeia a pasta provisória pra KEY e guarda o id antigo como alias
 */

const BASE_BRANCHES = new Set(['main', 'master', 'develop', 'HEAD']);

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

interface Here {
  branch: string | null;
  repo: string | null;
  worktree: string | null;
}

function here(): Here {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir']);
  const top = git(['rev-parse', '--show-toplevel']);
  return {
    branch: branch && !BASE_BRANCHES.has(branch) ? branch : null,
    repo: common ? basename(dirname(common)) : null,
    worktree: top && common && gitDir && common !== gitDir ? basename(top) : null,
  };
}

async function readMeta(dir: string): Promise<TaskMeta> {
  const raw = await readFile(join(dir, 'meta.json'), 'utf8').catch(() => null);
  return parseTaskMeta(raw, basename(dir));
}

async function writeMeta(dir: string, m: TaskMeta): Promise<void> {
  const out = {
    id: basename(dir),
    aliases: m.aliases,
    repos: m.repos,
    branches: m.branches,
    worktrees: m.worktrees,
    createdAt: m.createdAt ?? new Date().toISOString(),
  };
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(out, null, 2)}\n`);
}

const union = (a: string[], b: Array<string | null>): string[] =>
  [...new Set([...a, ...b.filter((x): x is string => !!x)])];

function withHere(m: TaskMeta, h: Here): TaskMeta {
  return {
    ...m,
    repos: union(m.repos, [h.repo]),
    branches: union(m.branches, [h.branch]),
    worktrees: union(m.worktrees, [h.worktree]),
  };
}

/**
 * Pasta desta branch/worktree. Key da branch > branch declarada > worktree.
 * `exclude` serve ao link: acha a pasta provisória mesmo quando a da key já existe.
 */
async function find(h: Here, exclude?: string): Promise<string | null> {
  const root = config.paths.tasksHome;
  const entries = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter(
    (e) => e.isDirectory() && isTaskFolderId(e.name) && join(root, e.name) !== exclude,
  );
  const key = taskKeyFromBranch(h.branch);
  if (key && entries.some((e) => e.name === key)) return join(root, key);
  let byWorktree: string | null = null;
  for (const e of entries) {
    const dir = join(root, e.name);
    const m = await readMeta(dir);
    if (h.branch && m.branches.includes(h.branch)) return dir;
    if (h.worktree && (e.name === h.worktree || m.worktrees.includes(h.worktree) || m.aliases.includes(h.worktree))) {
      byWorktree = dir;
    }
  }
  return byWorktree;
}

async function init(h: Here, explicit?: string): Promise<string> {
  const found = explicit ? null : await find(h);
  const id = explicit ?? taskKeyFromBranch(h.branch) ?? h.worktree ?? `wip-${new Date().toISOString().slice(0, 10)}`;
  if (!isTaskFolderId(id)) throw new Error(`id inválido para pasta: ${id}`);
  const dir = found ?? join(config.paths.tasksHome, id);
  await mkdir(dir, { recursive: true });
  await writeMeta(dir, withHere(await readMeta(dir), h));
  return dir;
}

async function link(h: Here, rawKey: string): Promise<string> {
  const { key, provisional } = taskNodeKey(rawKey);
  if (provisional) throw new Error(`não parece key do Jira: ${rawKey}`);
  const target = join(config.paths.tasksHome, key);
  const current = await find(h, target);
  if (!current) return init(h, key);

  const cur = await readMeta(current);
  const oldId = basename(current);
  const targetExists = !!(await stat(target).catch(() => null));
  if (!targetExists) {
    await rename(current, target);
  } else {
    // Já existe pasta da task (aberta de outro repo): junta, sem sobrescrever.
    for (const f of await readdir(current)) {
      if (f === 'meta.json') continue;
      const dest = (await stat(join(target, f)).catch(() => null)) ? join(target, `${oldId}-${f}`) : join(target, f);
      await rename(join(current, f), dest);
    }
    await rm(current, { recursive: true, force: true });
  }
  const tgt = await readMeta(target);
  const merged: TaskMeta = {
    id: key,
    aliases: union(tgt.aliases, [...cur.aliases, oldId]).filter((a) => a !== key),
    repos: union(tgt.repos, cur.repos),
    branches: union(tgt.branches, cur.branches),
    worktrees: union(tgt.worktrees, cur.worktrees),
    createdAt: tgt.createdAt ?? cur.createdAt,
  };
  await writeMeta(target, withHere(merged, h));
  return target;
}

const [cmd, arg] = process.argv.slice(2);
const h = here();
try {
  if (cmd === 'path') {
    const dir = await find(h);
    if (!dir) {
      console.error('sem pasta pra esta branch/worktree (task-folder init cria)');
      process.exit(1);
    }
    console.log(dir);
  } else if (cmd === 'init') {
    console.log(await init(h, arg));
  } else if (cmd === 'link') {
    if (!arg) throw new Error('uso: task-folder link KEY');
    console.log(await link(h, arg));
  } else {
    console.error('uso: task-folder path | init [ID] | link KEY');
    process.exit(2);
  }
} catch (e) {
  console.error(`task-folder: ${(e as Error).message}`);
  process.exit(1);
}
