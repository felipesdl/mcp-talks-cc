import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Write atômico: tmp + rename. Leitor nunca vê arquivo meio-escrito. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // linha corrompida — ignora
    }
  }
  return out;
}
