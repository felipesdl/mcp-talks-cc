import { parseArgs } from 'node:util';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { config } from '../config.ts';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { normalizeProjectPath } from '../ingest/entities.ts';

/**
 * Conserta o que o ingest antigo gravou errado (uma vez; idempotente):
 *
 * 1. Sessão com subagente: o arquivo do subagente sobrescrevia início, fim,
 *    contagem e branch da sessão pai. Intervalo e contagem saem das mensagens;
 *    a branch sai do `.jsonl` principal quando ele ainda existe.
 * 2. Worktree virava Project próprio (`wip-*`). A sessão passa pro repo de
 *    origem (com o worktree guardado em `worktree`/`worktreeName`), os chunks
 *    acompanham e o Project fantasma sai quando fica sem sessão.
 *
 * Antes de aplicar, grava um snapshot dos campos alterados em CACHE_DIR.
 */

const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
const apply = values.apply as boolean;

async function headerOf(file: string): Promise<{ sessionId: string | null; branch: string | null }> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let sessionId: string | null = null;
  let branch: string | null = null;
  let n = 0;
  for await (const line of rl) {
    if (++n > 400) break;
    try {
      const ev = JSON.parse(line) as { sessionId?: string; gitBranch?: string };
      sessionId ??= ev.sessionId ?? null;
      branch ??= ev.gitBranch || null;
      if (sessionId && branch) break;
    } catch {
      // linha quebrada
    }
  }
  rl.close();
  return { sessionId, branch };
}

/** Só os `.jsonl` principais (`projects/<dir>/<sessão>.jsonl`), nunca os de subagente. */
async function mainFiles(): Promise<string[]> {
  const root = join(config.paths.claudeHome, 'projects');
  const out: string[] = [];
  for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    for (const f of await readdir(join(root, d.name)).catch(() => [])) {
      if (f.endsWith('.jsonl')) out.push(join(root, d.name, f));
    }
  }
  return out;
}

await withSession(async (s) => {
  const snap = await s.run(`MATCH (se:Session)
    RETURN se.id AS id, se.projectPath AS projectPath, se.startedAt AS startedAt, se.endedAt AS endedAt,
           se.messageCount AS messageCount, se.gitBranch AS gitBranch`);
  const sessions = snap.records.map((r) => r.toObject() as Record<string, unknown>);
  console.log(`${sessions.length} sessões`);

  // 1a. branch do arquivo principal
  const branches: Array<{ id: string; branch: string }> = [];
  for (const f of await mainFiles()) {
    const h = await headerOf(f);
    if (h.sessionId && h.branch && h.sessionId === basename(f, '.jsonl')) branches.push({ id: h.sessionId, branch: h.branch });
  }
  const before = new Map(sessions.map((x) => [x.id as string, x]));
  const branchFix = branches.filter((b) => before.get(b.id) && before.get(b.id)!.gitBranch !== b.branch);
  console.log(`branch: ${branchFix.length} sessões com branch diferente do arquivo principal`);

  // 2. worktree -> repo
  const moves = sessions
    .map((x) => ({ id: x.id as string, cwd: x.projectPath as string | null }))
    .filter((x) => x.cwd)
    .map((x) => ({ ...x, loc: normalizeProjectPath(x.cwd!, config.paths.codeHome, existsSync) }))
    .filter((x) => x.loc.worktree && x.loc.repoPath !== x.cwd)
    .map((x) => ({ id: x.id, from: x.cwd!, repo: x.loc.repoPath, name: basename(x.loc.repoPath), worktree: x.loc.worktree, worktreeName: x.loc.worktreeName }));
  console.log(`worktree: ${moves.length} sessões em ${new Set(moves.map((m) => m.from)).size} projetos de worktree`);
  for (const [repo, n] of Object.entries(
    moves.reduce<Record<string, number>>((a, m) => ((a[m.name] = (a[m.name] ?? 0) + 1), a), {}),
  )) {
    console.log(`  -> ${repo}: ${n}`);
  }

  const cnt = await s.run(`MATCH (se:Session) OPTIONAL MATCH (se)-[:HAS_MESSAGE]->(m:Message)
    WITH se, count(m) AS n WHERE se.messageCount IS NULL OR se.messageCount <> n RETURN count(se) AS bad`);
  console.log(`contagem: ${cnt.records[0]!.get('bad')} sessões com messageCount diferente das mensagens`);

  if (!apply) {
    console.log('\n(dry-run: --apply grava)');
    return;
  }

  await mkdir(config.paths.cacheDir, { recursive: true });
  const backup = join(config.paths.cacheDir, `backup-sessions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(backup, JSON.stringify({ sessions }, null, 1));
  console.log(`snapshot: ${backup}`);

  // 1b. intervalo e contagem pelas mensagens
  await s.run(`MATCH (se:Session) OPTIONAL MATCH (se)-[:HAS_MESSAGE]->(m:Message)
    WITH se, count(m) AS n,
         min(CASE WHEN m.timestamp <> '' THEN m.timestamp END) AS a,
         max(CASE WHEN m.timestamp <> '' THEN m.timestamp END) AS b
    SET se.messageCount = n, se.startedAt = coalesce(a, se.startedAt), se.endedAt = coalesce(b, se.endedAt)`);
  await s.run(`UNWIND $rows AS r MATCH (se:Session { id: r.id }) SET se.gitBranch = r.branch`, { rows: branchFix });

  for (let i = 0; i < moves.length; i += 50) {
    await s.run(
      `UNWIND $rows AS r
       MATCH (se:Session { id: r.id })
       MERGE (p:Project { path: r.repo }) ON CREATE SET p.name = r.name
       SET se.projectPath = r.repo, se.worktree = r.worktree, se.worktreeName = r.worktreeName
       MERGE (p)-[:HAS_SESSION]->(se)
       WITH se, r
       OPTIONAL MATCH (ghost:Project { path: r.from })-[old:HAS_SESSION]->(se)
       DELETE old
       WITH se, r
       OPTIONAL MATCH (se)-[:HAS_MESSAGE]->(:Message)-[:HAS_CHUNK]->(c:Chunk)
       SET c.projectPath = r.repo`,
      { rows: moves.slice(i, i + 50) },
    );
  }
  // Decision herda o projeto da sessão de origem (nó e chunk)
  const froms = [...new Map(moves.map((m) => [m.from, { from: m.from, repo: m.repo, name: m.name }])).values()];
  await s.run(
    `UNWIND $rows AS r
     MATCH (d:Decision { projectPath: r.from })
     SET d.projectPath = r.repo, d.repo = r.name
     WITH d, r
     MATCH (d)-[:HAS_CHUNK]->(c:Chunk) SET c.projectPath = r.repo`,
    { rows: froms },
  );
  const ghosts = await s.run(
    `UNWIND $paths AS p MATCH (g:Project { path: p }) WHERE NOT (g)-[:HAS_SESSION]->() DETACH DELETE g RETURN count(*) AS n`,
    { paths: [...new Set(moves.map((m) => m.from))] },
  );
  console.log(`aplicado. projetos fantasma removidos: ${ghosts.records[0]?.get('n') ?? 0}`);
});
await closeDriver();
