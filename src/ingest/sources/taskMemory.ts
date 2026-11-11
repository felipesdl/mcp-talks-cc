import { readdir, readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.ts';
import { chunkText } from '../chunker.ts';
import { redact } from '../redact.ts';
import { embedChunks } from '../embedChunks.ts';
import { fingerprint, isUnchanged, markIngested } from '../checkpoint.ts';
import type { Fingerprint } from '../checkpoint.ts';
import { countReadError } from '../fsErrors.ts';
import { writeProjects, writeTaskMemoryDocs, writeChunks, writeTaskFolders, deleteChunksOf } from '../writer.ts';
import type {
  ProjectRecord,
  TaskMemoryDocRecord,
  TaskFolderRecord,
  ChunkRecord,
} from '../types.ts';
import { isTaskFolderId, parseTaskMeta } from '../taskFolders.ts';

const TASK_DIR_RE = /^[A-Z]+-\d+$/;

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function listProjects(): Promise<string[]> {
  const root = config.paths.codeHome;
  try {
    const entries = await readdir(root);
    const out: string[] = [];
    for (const e of entries) {
      const p = join(root, e);
      if (await dirExists(join(p, '.claude', 'tasks'))) out.push(p);
    }
    return out;
  } catch {
    return [];
  }
}

/** Pastas em TASKS_HOME. Symlink fica de fora: o gc apaga diretório, nunca segue link. */
async function listTaskFolders(): Promise<{ id: string; dir: string }[]> {
  const root = config.paths.tasksHome;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && isTaskFolderId(e.name))
    .map((e) => ({ id: e.name, dir: join(root, e.name) }));
}

async function listTaskDirs(projectPath: string): Promise<{ taskId: string; dir: string }[]> {
  const tasksRoot = join(projectPath, '.claude', 'tasks');
  try {
    const entries = await readdir(tasksRoot);
    const out: { taskId: string; dir: string }[] = [];
    for (const e of entries) {
      if (!TASK_DIR_RE.test(e)) continue;
      const d = join(tasksRoot, e);
      if (await dirExists(d)) out.push({ taskId: e, dir: d });
    }
    return out;
  } catch {
    return [];
  }
}

export async function ingestTaskMemory(
  opts: { force?: boolean } = {},
): Promise<{
  projects: number;
  folders: number;
  docs: number;
  chunks: number;
  skipped: number;
  vanished: number;
  failed: number;
}> {
  const projects = await listProjects();

  const projectRecords: ProjectRecord[] = projects.map((p) => ({
    path: p,
    name: basename(p),
  }));
  await writeProjects(projectRecords);

  const allDocs: TaskMemoryDocRecord[] = [];
  const allChunks: ChunkRecord[] = [];
  const changedDocs: string[] = [];
  let skipped = 0;
  const readErrors = { vanished: 0, failed: 0 };

  const ingestDir = async (taskId: string, dir: string, projectPath: string | null): Promise<void> => {
    // Recursivo: o gc confere todo `.md` da pasta (subpasta inclusive), então o
    // ingest tem que enxergar os mesmos, senão a pasta nunca conta como ingerida.
    const files = ((await readdir(dir, { recursive: true }).catch(() => [])) as string[]).filter((f) =>
      f.endsWith('.md'),
    );
    for (const f of files) {
      const fp = join(dir, f);
      let st: Stats;
      let content: string;
      let print: Fingerprint;
      try {
        if (!opts.force && (await isUnchanged(fp))) {
          skipped++;
          continue;
        }
        print = await fingerprint(fp);
        st = await stat(fp);
        content = await readFile(fp, 'utf8');
      } catch (err) {
        countReadError('tasks', basename(fp), err, readErrors);
        continue;
      }
      const kind = f.slice(0, -'.md'.length);

      allDocs.push({
        path: fp,
        taskId,
        kind,
        projectPath,
        lastModified: st.mtime.toISOString(),
      });

      const redacted = redact(content);
      const pieces = chunkText(redacted);
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]!;
        const id = createHash('sha1').update(`${fp}::${i}`).digest('hex');
        allChunks.push({
          id,
          parentKey: fp,
          parentLabel: 'TaskMemoryDoc',
          sourceKind: 'task_memory',
          ordinal: i,
          text: piece,
          embedding: [],
          // Documento, não fala de ninguém.
          role: null,
          projectPath,
          sessionId: null,
          timestamp: st.mtime.toISOString(),
        });
      }
      changedDocs.push(fp);
      await markIngested(fp, print);
    }
  };

  for (const projectPath of projects) {
    const tasks = await listTaskDirs(projectPath);
    for (const { taskId, dir } of tasks) await ingestDir(taskId, dir, projectPath);
  }

  // Pasta central de tasks (fora dos repos). O meta.json é relido toda vez:
  // é pequeno e é ele que liga sessão/branch/worktree à task.
  const folders: TaskFolderRecord[] = [];
  for (const { id, dir } of await listTaskFolders()) {
    const raw = await readFile(join(dir, 'meta.json'), 'utf8').catch(() => null);
    const meta = parseTaskMeta(raw, id);
    const st = await stat(dir).catch(() => null);
    folders.push({
      id,
      path: dir,
      aliases: meta.aliases,
      repos: meta.repos,
      branches: meta.branches,
      worktrees: meta.worktrees,
      lastModified: (st?.mtime ?? new Date()).toISOString(),
    });
    const repo = meta.repos[0] ? join(config.paths.codeHome, meta.repos[0]) : null;
    await ingestDir(id, dir, repo && (await dirExists(repo)) ? repo : null);
  }
  await writeTaskFolders(folders);

  if (allDocs.length > 0) await writeTaskMemoryDocs(allDocs);
  if (allChunks.length > 0) await embedChunks(allChunks, opts.force);
  // Doc editado pode ter encolhido: chunk de ordinal alto ficaria órfão. Só
  // apaga o que não vai ser regravado: chunk reaproveitado pelo embed vem com
  // embedding null e depende do vetor que já está no nó.
  await deleteChunksOf('TaskMemoryDoc', 'path', changedDocs, allChunks.map((c) => c.id));
  if (allChunks.length > 0) await writeChunks(allChunks);

  return {
    projects: projects.length,
    folders: folders.length,
    docs: allDocs.length,
    chunks: allChunks.length,
    skipped,
    ...readErrors,
  };
}
