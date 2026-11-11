import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { chunkText } from '../ingest/chunker.ts';
import { redact } from '../ingest/redact.ts';
import { embedChunks } from '../ingest/embedChunks.ts';
import { writePullRequests, writeChunks, deleteChunksOf } from '../ingest/writer.ts';
import { prMatchesTask, replacementPairs } from '../ingest/taskFolders.ts';
import type { PrState } from '../ingest/taskFolders.ts';
import type { PullRequestRecord, ChunkRecord } from '../ingest/types.ts';

/**
 * PRs das tasks ativas, via `gh api graphql`. Cada PR vira um nó ligado à task
 * (título com a key ou branch declarada na pasta da task), com estado, branch e
 * a descrição como chunk. PR fechado seguido de outro no mesmo repo ganha
 * REPLACES; sessão na branch do PR ganha WORKED_ON_PR.
 *
 * Só consulta task com sessão recente, PR aberto ou pasta viva, e para de
 * consultar task com tudo mergeado e sem atividade nova. Sem `GH_PR_OWNER` ou
 * sem `gh`, sai sem fazer nada (fail-open, roda no hook).
 */

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    task: { type: 'string' },
  },
});
const apply = values.apply as boolean;
const run = promisify(execFile);
const GH_TIMEOUT_MS = 25_000;
const SEARCHES_PER_REQUEST = 8;

interface Target {
  task: string;
  titleKey: string | null;
  branches: string[];
}

interface GqlPr {
  number: number;
  title: string;
  url: string;
  state: PrState;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string | null;
  body: string | null;
  repository: { name: string };
}

async function targets(): Promise<Target[]> {
  const since = new Date(Date.now() - config.github.activeDays * 86_400_000).toISOString();
  return withSession(async (s) => {
    if (values.task) {
      return [{ task: values.task, titleKey: values.task, branches: [] }];
    }
    const r = await s.run(
      `MATCH (t:Task)
       WHERE coalesce(t.provisional, false) = false OR EXISTS { (:TaskFolder { present: true })-[:FOR_TASK]->(t) }
       OPTIONAL MATCH (pr:PullRequest)-[:FOR_TASK]->(t)
       WITH t, collect(pr.state) AS states
       OPTIONAL MATCH (f:TaskFolder { present: true })-[:FOR_TASK]->(t)
       WITH t, states, collect(f.branches) AS fb
       WHERE coalesce(t.lastSeenAt, '') >= $since OR 'OPEN' IN states OR size(fb) > 0
       WITH t, states, reduce(acc = [], b IN fb | acc + b) AS branches
       WHERE NOT (size(states) > 0 AND all(x IN states WHERE x = 'MERGED')
                  AND t.prsFinalAt IS NOT NULL AND coalesce(t.lastSeenAt, '') <= t.prsFinalAt)
       RETURN t.key AS key, coalesce(t.provisional, false) AS provisional, branches
       ORDER BY coalesce(t.lastSeenAt, '') DESC
       LIMIT toInteger($max)`,
      { since, max: config.github.maxTasksPerRun },
    );
    return r.records.map((x) => ({
      task: x.get('key') as string,
      titleKey: (x.get('provisional') as boolean) ? null : (x.get('key') as string),
      branches: [...new Set((x.get('branches') as string[]) ?? [])],
    }));
  });
}

const PR_FIELDS = `... on PullRequest { number title url state createdAt mergedAt closedAt headRefName body repository { name } }`;

async function search(queries: string[]): Promise<GqlPr[][]> {
  const parts = queries.map(
    (q, i) => `q${i}: search(query: ${JSON.stringify(q)}, type: ISSUE, first: 20) { nodes { ${PR_FIELDS} } }`,
  );
  const { stdout } = await run('gh', ['api', 'graphql', '-f', `query=query { ${parts.join(' ')} }`], {
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const data = (JSON.parse(stdout) as { data: Record<string, { nodes: GqlPr[] }> }).data;
  return queries.map((_, i) => (data[`q${i}`]?.nodes ?? []).filter((n) => n && n.number));
}

async function main(): Promise<void> {
  const owner = config.github.prOwner;
  if (!owner) {
    console.log('[sync-prs] GH_PR_OWNER vazio, nada a fazer');
    return;
  }
  const list = await targets();
  console.log(`[sync-prs] ${list.length} tasks a consultar`);
  if (list.length === 0) return;

  // Uma busca por key no título + uma por branch declarada na pasta.
  const queries: Array<{ q: string; task: string; kind: 'title' | 'branch'; branch?: string }> = [];
  for (const t of list) {
    if (t.titleKey) queries.push({ q: `org:${owner} is:pr "${t.titleKey}" in:title`, task: t.task, kind: 'title' });
    for (const b of t.branches) queries.push({ q: `org:${owner} is:pr head:${b}`, task: t.task, kind: 'branch', branch: b });
  }

  const found = new Map<string, { pr: GqlPr; task: string }>();
  for (let i = 0; i < queries.length; i += SEARCHES_PER_REQUEST) {
    const slice = queries.slice(i, i + SEARCHES_PER_REQUEST);
    let results: GqlPr[][];
    try {
      results = await search(slice.map((x) => x.q));
    } catch (e) {
      console.error(`[sync-prs] gh falhou (segue sem PRs desta rodada): ${(e as Error).message.split('\n')[0]}`);
      return;
    }
    slice.forEach((q, j) => {
      for (const pr of results[j] ?? []) {
        const ok =
          q.kind === 'branch' ? pr.headRefName === q.branch : prMatchesTask(pr.title, pr.headRefName, q.task);
        if (ok) found.set(`${pr.repository.name}#${pr.number}`, { pr, task: q.task });
      }
    });
  }

  const rows: PullRequestRecord[] = [...found.entries()].map(([key, { pr, task }]) => ({
    key,
    repo: pr.repository.name,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    branch: pr.headRefName,
    task,
    bodySha: createHash('sha1').update(pr.body ?? '').digest('hex'),
  }));
  console.log(
    `[sync-prs] ${rows.length} PRs: ${rows.map((r) => `${r.task} ${r.key} ${r.state.toLowerCase()}`).join(', ') || '-'}`,
  );
  if (!apply || rows.length === 0) return;

  // Descrição só re-embeda quando mudou.
  const prevSha = await withSession(async (s) => {
    const r = await s.run(`UNWIND $keys AS k MATCH (pr:PullRequest { key: k }) RETURN pr.key AS k, pr.bodySha AS sha`, {
      keys: rows.map((r2) => r2.key),
    });
    return new Map(r.records.map((x) => [x.get('k') as string, x.get('sha') as string | null]));
  });
  await writePullRequests(rows);

  const changed = rows.filter((r) => prevSha.get(r.key) !== r.bodySha);
  const chunks: ChunkRecord[] = [];
  for (const r of changed) {
    const body = found.get(r.key)!.pr.body ?? '';
    const repoPath = join(config.paths.codeHome, r.repo);
    chunkText(redact(`${r.title}\n\n${body}`)).forEach((piece, i) => {
      chunks.push({
        id: createHash('sha1').update(`pr:${r.key}::${r.bodySha}::${i}`).digest('hex'),
        parentKey: r.key,
        parentLabel: 'PullRequest',
        sourceKind: 'pr',
        ordinal: i,
        text: piece,
        embedding: [],
        role: null,
        projectPath: existsSync(repoPath) ? repoPath : null,
        sessionId: null,
        timestamp: r.mergedAt ?? r.createdAt,
      });
    });
  }
  if (chunks.length > 0) await embedChunks(chunks);
  await deleteChunksOf('PullRequest', 'key', changed.map((r) => r.key), chunks.map((c) => c.id));
  if (chunks.length > 0) await writeChunks(chunks);

  await withSession(async (s) => {
    const tasks = [...new Set(rows.map((r) => r.task))];
    // REPLACES recalculado do zero por task (estado de PR muda: fechado pode reabrir)
    const all = await s.run(
      `UNWIND $tasks AS k MATCH (pr:PullRequest)-[:FOR_TASK]->(:Task { key: k })
       RETURN pr.key AS key, pr.repo AS repo, pr.state AS state, pr.createdAt AS createdAt`,
      { tasks },
    );
    const prs = all.records.map((x) => ({
      key: x.get('key') as string,
      repo: x.get('repo') as string,
      state: x.get('state') as PrState,
      createdAt: x.get('createdAt') as string,
    }));
    await s.run(`UNWIND $keys AS k MATCH (pr:PullRequest { key: k })-[r:REPLACES]->() DELETE r`, {
      keys: prs.map((p) => p.key),
    });
    await s.run(
      `UNWIND $pairs AS p MATCH (n:PullRequest { key: p.newer }) MATCH (o:PullRequest { key: p.older })
       MERGE (n)-[:REPLACES]->(o)`,
      { pairs: replacementPairs(prs) },
    );
    // Sessão que trabalhou na branch do PR, no mesmo repo.
    await s.run(
      `UNWIND $keys AS k MATCH (pr:PullRequest { key: k }) WHERE pr.branch IS NOT NULL
       MATCH (se:Session { gitBranch: pr.branch })<-[:HAS_SESSION]-(p:Project { name: pr.repo })
       MERGE (se)-[:WORKED_ON_PR]->(pr)`,
      { keys: rows.map((r) => r.key) },
    );
    // Task com tudo mergeado: para de ser consultada até ter sessão nova.
    await s.run(
      `UNWIND $tasks AS k MATCH (t:Task { key: k })<-[:FOR_TASK]-(pr:PullRequest)
       WITH t, collect(pr.state) AS states
       SET t.prsFinalAt = CASE WHEN all(x IN states WHERE x = 'MERGED') THEN toString(datetime()) ELSE null END`,
      { tasks },
    );
  });
  console.log(`[sync-prs] gravado (${changed.length} descrições re-embedadas)`);
}

try {
  await main();
} catch (e) {
  console.error('[sync-prs] falhou:', e);
} finally {
  await closeDriver();
}
