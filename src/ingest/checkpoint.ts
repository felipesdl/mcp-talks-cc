import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { config } from '../config.ts';

const FILE = join(config.paths.cacheDir, 'checkpoint.json');

type Entry = { mtimeMs: number; sha256: string; ingestedAt: string };
type CheckpointMap = Record<string, Entry>;

let _state: CheckpointMap | null = null;

async function load(): Promise<CheckpointMap> {
  if (_state) return _state;
  try {
    const raw = await readFile(FILE, 'utf8');
    _state = JSON.parse(raw);
  } catch {
    _state = {};
  }
  return _state!;
}

export async function save(): Promise<void> {
  if (!_state) return;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(_state, null, 2));
}

export type Fingerprint = { mtimeMs: number; sha256: string };

async function hashFile(path: string): Promise<Fingerprint> {
  const [st, content] = await Promise.all([stat(path), readFile(path)]);
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { mtimeMs: st.mtimeMs, sha256 };
}

/** Returns true if file is unchanged since last ingest. */
export async function isUnchanged(path: string): Promise<boolean> {
  const state = await load();
  const prev = state[path];
  if (!prev) return false;
  const st = await stat(path).catch(() => null);
  if (!st) return false;
  if (st.mtimeMs === prev.mtimeMs) return true;
  // mtime differs — confirm via hash
  const { sha256 } = await hashFile(path);
  return sha256 === prev.sha256;
}

/**
 * Snapshot do arquivo pra gravar no checkpoint. Tirar ANTES de ler o conteúdo:
 * se o arquivo crescer (sessão viva) ou sumir durante parse+embed, o checkpoint
 * fica com a versão antiga e o próximo run re-ingere, em vez de marcar como
 * visto um conteúdo que nunca entrou no grafo.
 */
export function fingerprint(path: string): Promise<Fingerprint> {
  return hashFile(path);
}

export async function markIngested(path: string, print?: Fingerprint): Promise<void> {
  const state = await load();
  const { mtimeMs, sha256 } = print ?? (await hashFile(path));
  state[path] = { mtimeMs, sha256, ingestedAt: new Date().toISOString() };
}
