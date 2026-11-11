import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.ts';
import { chunkText } from '../chunker.ts';
import { redact } from '../redact.ts';
import { embedChunks } from '../embedChunks.ts';
import { withSession } from '../../neo4j/driver.ts';
import { writeRepoDocs, writeChunks, deleteChunksOf } from '../writer.ts';
import type { RepoDocRecord, ChunkRecord } from '../types.ts';

/**
 * Markdown versionado na branch padrão de cada repo em CODE_HOME: docs, specs,
 * CLAUDE.md e README que o time escreve e atualiza. Lido do `origin/<padrão>`
 * (não da pasta local), então entra só o que foi commitado, sem arquivo solto
 * nem mudança local pela metade. Incremental pelo sha do blob.
 */

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const STATE_FILE = join(config.paths.cacheDir, 'repo-docs.json');

const DENY_SEGMENTS = ['node_modules/', 'vendor/', 'dist/', 'build/', '.next/', 'coverage/'];

/** Caminho que entra: `.md`, fora de dependência/build, sem CHANGELOG, fora da lista de exclusão. */
export function isRepoDocPath(path: string, exclude: readonly string[]): boolean {
  if (!/\.md$/i.test(path)) return false;
  if (DENY_SEGMENTS.some((d) => path.startsWith(d) || path.includes(`/${d}`))) return false;
  if (/^changelog/i.test(basename(path))) return false;
  return !exclude.some((e) => path.startsWith(e));
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/** Repo "de verdade": `.git` é diretório. Worktree tem `.git` arquivo e fica de fora. */
async function listRepos(): Promise<string[]> {
  const root = config.paths.codeHome;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = join(root, e.name);
    const g = await stat(join(p, '.git')).catch(() => null);
    if (g?.isDirectory()) out.push(p);
  }
  return out;
}

async function defaultRef(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim();
  } catch {
    for (const r of ['origin/main', 'origin/master']) {
      try {
        await git(repo, ['rev-parse', '--verify', '-q', r]);
        return r;
      } catch {
        // tenta o próximo
      }
    }
    return null;
  }
}

type State = Record<string, string>;

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as State;
  } catch {
    return {};
  }
}

export async function ingestRepoDocs(opts: { force?: boolean; noFetch?: boolean } = {}): Promise<{
  repos: number;
  docs: number;
  removed: number;
  chunks: number;
  failed: number;
}> {
  if (!config.repoDocs.enabled) return { repos: 0, docs: 0, removed: 0, chunks: 0, failed: 0 };
  const state = opts.force ? {} : await loadState();
  const seen = new Set<string>();
  const docs: RepoDocRecord[] = [];
  const chunks: ChunkRecord[] = [];
  let failed = 0;
  const repos = await listRepos();
  // Só repo listado com sucesso pode ter doc removido: ls-tree que falhou (timeout,
  // maxBuffer) ou ref sumida não é sinal de que os docs saíram.
  const listed = new Set<string>();

  for (const repoPath of repos) {
    const repo = basename(repoPath);
    if (!opts.noFetch) {
      // fail-open: sem rede, usa as refs que já tem
      await git(repoPath, ['fetch', 'origin', '-q']).catch(() => {
        console.error(`[repo-docs] ${repo}: fetch falhou, usando refs locais`);
      });
    }
    const ref = await defaultRef(repoPath);
    if (!ref) continue;
    let listing: string;
    try {
      listing = await git(repoPath, ['ls-tree', '-r', '-l', ref]);
    } catch {
      failed++;
      continue;
    }
    listed.add(repo);
    for (const line of listing.split('\n')) {
      // <mode> blob <sha> <size>\t<path>
      const m = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(line);
      if (!m) continue;
      const [, sha, size, path] = m;
      if (!isRepoDocPath(path!, config.repoDocs.exclude) || Number(size) > config.repoDocs.maxBytes) continue;
      const key = `${repo}:${path}`;
      seen.add(key);
      if (state[key] === sha) continue;
      try {
        const content = await git(repoPath, ['cat-file', '-p', sha!]);
        const log = (await git(repoPath, ['log', '-1', '--format=%an%x09%cI', ref, '--', path!])).trim();
        const [author, updatedAt] = log ? log.split('\t') : [null, null];
        docs.push({ key, repo, repoPath, path: path!, sha: sha!, author: author ?? null, updatedAt: updatedAt ?? null });
        const pieces = chunkText(redact(content));
        pieces.forEach((piece, i) => {
          chunks.push({
            id: createHash('sha1').update(`repodoc:${key}::${sha}::${i}`).digest('hex'),
            parentKey: key,
            parentLabel: 'RepoDoc',
            sourceKind: 'repo_doc',
            ordinal: i,
            // O caminho entra no texto: é o que diz do que o doc trata quando
            // o trecho sozinho não diz (e é o que o BM25 casa).
            text: i === 0 ? `${path}\n${piece}` : piece,
            embedding: [],
            role: null,
            projectPath: repoPath,
            sessionId: null,
            timestamp: updatedAt ?? null,
          });
        });
        state[key] = sha!;
      } catch {
        failed++;
      }
    }
  }

  // Doc que saiu da branch padrão: some da busca, o nó fica marcado.
  const removed = Object.keys(state).filter((k) => !seen.has(k) && listed.has(k.split(':')[0]!));

  if (docs.length > 0) await writeRepoDocs(docs);
  if (chunks.length > 0) await embedChunks(chunks, opts.force);
  await deleteChunksOf('RepoDoc', 'key', [...docs.map((d) => d.key), ...removed], chunks.map((c) => c.id));
  if (chunks.length > 0) await writeChunks(chunks);
  if (removed.length > 0) {
    await withSession((s) =>
      s.run(`UNWIND $keys AS k MATCH (d:RepoDoc { key: k }) SET d.removed = true`, { keys: removed }),
    );
    for (const k of removed) delete state[k];
  }

  await mkdir(config.paths.cacheDir, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  return { repos: repos.length, docs: docs.length, removed: removed.length, chunks: chunks.length, failed };
}
