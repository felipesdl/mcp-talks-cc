import { readdir, readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.ts';
import { chunkText } from '../chunker.ts';
import { redact } from '../redact.ts';
import { embedBatched } from '../../embeddings/localEmbedder.ts';
import { fingerprint, isUnchanged, markIngested } from '../checkpoint.ts';
import type { Fingerprint } from '../checkpoint.ts';
import { countReadError } from '../fsErrors.ts';
import { writeProjects, writeTaskMemoryDocs, writeChunks } from '../writer.ts';
import type {
  ProjectRecord,
  TaskMemoryDocRecord,
  ChunkRecord,
} from '../types.ts';

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
  docs: number;
  chunks: number;
  skipped: number;
  vanished: number;
  failed: number;
}> {
  const projects = await listProjects();
  if (projects.length === 0) {
    return { projects: 0, docs: 0, chunks: 0, skipped: 0, vanished: 0, failed: 0 };
  }

  const projectRecords: ProjectRecord[] = projects.map((p) => ({
    path: p,
    name: basename(p),
  }));
  await writeProjects(projectRecords);

  const allDocs: TaskMemoryDocRecord[] = [];
  const allChunks: ChunkRecord[] = [];
  const allTexts: string[] = [];
  let skipped = 0;
  const readErrors = { vanished: 0, failed: 0 };

  for (const projectPath of projects) {
    const tasks = await listTaskDirs(projectPath);
    for (const { taskId, dir } of tasks) {
      const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md'));
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
        const kind = basename(f, '.md');

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
          allTexts.push(piece);
        }
        await markIngested(fp, print);
      }
    }
  }

  if (allDocs.length > 0) await writeTaskMemoryDocs(allDocs);
  if (allChunks.length > 0) {
    const vecs = await embedBatched(allTexts);
    for (let j = 0; j < allChunks.length; j++) allChunks[j]!.embedding = vecs[j]!;
    await writeChunks(allChunks);
  }

  return {
    projects: projects.length,
    docs: allDocs.length,
    chunks: allChunks.length,
    skipped,
    ...readErrors,
  };
}
