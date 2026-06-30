import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { config } from '../../config.ts';
import { isUnchanged, markIngested } from '../checkpoint.ts';
import { writeTodos } from '../writer.ts';
import type { TodoRecord } from '../types.ts';

interface RawTodo {
  id?: string;
  content?: string;
  status?: string;
  activeForm?: string;
}

const SESSION_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function sessionIdFromFilename(fname: string): string | null {
  const m = SESSION_ID_RE.exec(fname);
  return m ? m[1]! : null;
}

export async function ingestTodos(opts: { force?: boolean } = {}): Promise<{
  files: number;
  todos: number;
  skipped: number;
}> {
  const dir = join(config.paths.claudeHome, 'todos');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    console.error(`[todos] no dir at ${dir}`);
    return { files: 0, todos: 0, skipped: 0 };
  }

  const files = entries.filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  const all: TodoRecord[] = [];
  let skipped = 0;

  for (const fp of files) {
    if (!opts.force && (await isUnchanged(fp))) {
      skipped++;
      continue;
    }
    try {
      const raw = JSON.parse(await readFile(fp, 'utf8')) as RawTodo[];
      if (!Array.isArray(raw)) continue;
      const sid = sessionIdFromFilename(basename(fp));
      for (let i = 0; i < raw.length; i++) {
        const t = raw[i]!;
        const content = (t.content ?? '').trim();
        if (!content) continue;
        all.push({
          id: t.id ? `${basename(fp)}::${t.id}` : `${basename(fp)}::${i}`,
          content,
          status: t.status ?? 'unknown',
          sessionId: sid,
          filePath: fp,
        });
      }
      await markIngested(fp);
    } catch {
      // skip malformed
    }
  }

  if (all.length > 0) await writeTodos(all);
  return { files: files.length - skipped, todos: all.length, skipped };
}
