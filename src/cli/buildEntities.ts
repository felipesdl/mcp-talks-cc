import { parseArgs } from 'node:util';
import type { Session } from 'neo4j-driver';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import {
  taskKeyFromBranch,
  taskKeyFromSlug,
  taskKeysFromText,
  normalizeFilePath,
  filePathFromSnippet,
  FILE_TOOLS,
  WRITE_TOOLS,
} from '../ingest/entities.ts';
import { taskNodeKey } from '../ingest/taskFolders.ts';
import {
  AGENT_TOOLS,
  BUILTIN_COMMANDS,
  agentFromSnippet,
  classifyToolError,
  skillFromSnippet,
  slashFromText,
  POSITION_PAIRING_CYPHER,
} from '../ingest/toolSignals.ts';
import { detectCorrections } from '../ingest/corrections.ts';
import type { SessionEvent } from '../ingest/corrections.ts';

/**
 * Constrói o grafo de entidades a partir do que já está indexado.
 *
 * Antes disto o Neo4j era um depósito de texto com índice vetorial: o único
 * vínculo de sentido era SIMILAR_TO, que diz "esses parágrafos se parecem" e
 * nunca "isto continua aquilo". Aqui entram Task e File, que é o que responde
 * continuidade e trabalho relacionado.
 *
 * Nenhum passo apaga nada. Todos são idempotentes (MERGE + SET de valor
 * absoluto, nunca incremento, que quebraria no segundo run).
 */

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    step: { type: 'string', default: 'all' },
    page: { type: 'string', default: '5000' },
  },
});
const apply = values.apply as boolean;
const only = values.step as string;
const PAGE = parseInt(values.page as string, 10);

const steps = only.split(',').map((x) => x.trim());
const run = (name: string): boolean => only === 'all' || steps.includes(name);
const log = (...a: unknown[]): void => console.log(...a);

async function guardConstraints(s: Session): Promise<void> {
  const r = await s.run(`SHOW CONSTRAINTS YIELD name RETURN collect(name) AS names`);
  const names: string[] = r.records[0]!.get('names');
  const missing = ['task_key', 'file_key'].filter((n) => !names.includes(n));
  if (missing.length > 0) {
    console.error(`constraints faltando: ${missing.join(', ')} — rode 'npm run db:init' antes`);
    process.exit(1);
  }
}

/** Passo 1: task a partir da branch. Cobre a sessão inteira de uma vez. */
async function tasksFromBranch(s: Session): Promise<void> {
  const r = await s.run(`MATCH (se:Session) WHERE se.gitBranch IS NOT NULL
    RETURN se.id AS id, se.gitBranch AS branch`);
  const rows = r.records
    .map((x) => {
      const branch = x.get('branch') as string;
      const key = taskKeyFromBranch(branch);
      return key ? { id: x.get('id') as string, key, prefix: key.split('-')[0]!, branch } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  log(`  [tasks-from-branch] ${rows.length} sessões, ${new Set(rows.map((r2) => r2.key)).size} tasks`);
  if (!apply) return;
  await s.run(`UNWIND $rows AS r
    MATCH (se:Session { id: r.id })
    MERGE (t:Task { key: r.key }) ON CREATE SET t.prefix = r.prefix
    MERGE (se)-[rel:ON_TASK]->(t) SET rel.source = 'branch', rel.branch = r.branch
    SET se.taskKey = r.key`, { rows });
}

/** Passo 2: task citada no texto, para referência cruzada entre tasks. */
async function tasksFromText(s: Session): Promise<void> {
  let cursor = '';
  let pairs = 0;
  const keys = new Set<string>();
  for (;;) {
    const page = await s.run(
      `MATCH (c:Chunk) WHERE c.id > $cursor AND c.text CONTAINS '-'
       RETURN c.id AS id, c.text AS text ORDER BY c.id LIMIT toInteger($page)`,
      { cursor, page: PAGE },
    );
    if (page.records.length === 0) break;
    cursor = page.records[page.records.length - 1]!.get('id') as string;

    const rows: { id: string; key: string; prefix: string }[] = [];
    for (const rec of page.records) {
      const id = rec.get('id') as string;
      for (const key of taskKeysFromText(rec.get('text') as string)) {
        rows.push({ id, key, prefix: key.split('-')[0]! });
        keys.add(key);
      }
    }
    pairs += rows.length;
    if (apply && rows.length > 0) {
      await s.run(`UNWIND $rows AS r
        MATCH (c:Chunk { id: r.id })
        MERGE (t:Task { key: r.key }) ON CREATE SET t.prefix = r.prefix
        MERGE (c)-[:MENTIONS_TASK]->(t)`, { rows });
    }
  }
  log(`  [tasks-from-text] ${pairs} arestas, ${keys.size} tasks distintas`);
}

/** Passo 3: arquivo tocado, a partir do input serializado no ToolCall. */
async function filesFromToolCalls(s: Session): Promise<void> {
  const proj = await s.run(`MATCH (p:Project) RETURN collect(p.path) AS paths`);
  const projectPaths: string[] = proj.records[0]!.get('paths');

  let cursor = '';
  // Agrega no cliente: a escrita grava valor ABSOLUTO, então rodar de novo não
  // duplica contagem. Incremento em Cypher quebraria a idempotência.
  const wrote = new Map<string, { sessionId: string; key: string; repo: string; path: string; ext: string; count: number }>();
  const read = new Map<string, typeof wrote extends Map<string, infer V> ? V : never>();

  for (;;) {
    const page = await s.run(
      `MATCH (m:Message)-[:INVOKED]->(tc:ToolCall)
       WHERE tc.id > $cursor AND tc.name IN $tools
       RETURN tc.id AS id, tc.name AS name, tc.outputSnippet AS snip, m.sessionId AS sid
       ORDER BY tc.id LIMIT toInteger($page)`,
      { cursor, page: PAGE, tools: [...FILE_TOOLS] },
    );
    if (page.records.length === 0) break;
    cursor = page.records[page.records.length - 1]!.get('id') as string;

    for (const rec of page.records) {
      const sid = rec.get('sid') as string;
      const abs = filePathFromSnippet(rec.get('snip') as string);
      if (!sid || !abs) continue;
      const ref = normalizeFilePath(abs, projectPaths);
      if (!ref) continue;
      const bucket = WRITE_TOOLS.has(rec.get('name') as string) ? wrote : read;
      const k = `${sid}\u0000${ref.key}`;
      const cur = bucket.get(k);
      if (cur) cur.count++;
      else bucket.set(k, { sessionId: sid, ...ref, count: 1 });
    }
  }

  const files = new Set([...wrote.values(), ...read.values()].map((v) => v.key));
  log(`  [files-from-toolcalls] ${files.size} arquivos, ${wrote.size} WROTE, ${read.size} READ`);
  if (!apply) return;

  for (const [rel, bucket] of [['WROTE', wrote], ['READ', read]] as const) {
    const all = [...bucket.values()];
    for (let i = 0; i < all.length; i += 500) {
      await s.run(`UNWIND $rows AS r
        MATCH (se:Session { id: r.sessionId })
        MERGE (f:File { key: r.key }) ON CREATE SET f.repo = r.repo, f.path = r.path, f.ext = r.ext
        MERGE (se)-[e:${rel}]->(f) SET e.count = r.count`, { rows: all.slice(i, i + 500) });
    }
  }
}

/** Passo 4: agregados derivados. Recalculados do zero, nunca incrementados. */
async function aggregates(s: Session): Promise<void> {
  if (!apply) {
    log('  [aggregates] (dry-run: depende dos passos anteriores terem sido aplicados)');
    return;
  }
  await s.run(`MATCH (t:Task)<-[:ON_TASK]-(se:Session)<-[:HAS_SESSION]-(p:Project)
    WITH t, p, count(DISTINCT se) AS n
    MERGE (t)-[r:IN_PROJECT]->(p) SET r.sessions = n`);
  await s.run(`MATCH (t:Task) OPTIONAL MATCH (t)<-[:ON_TASK]-(se:Session)
    WITH t, count(DISTINCT se) AS n, min(se.startedAt) AS f, max(se.startedAt) AS l
    SET t.sessionCount = n, t.firstSeenAt = f, t.lastSeenAt = l`);
  // IDF: arquivo central do repo continua valendo, só pesa menos. Corte duro
  // perderia `contract/types.ts`, que aparece em 41 sessões e é sinal real.
  await s.run(`MATCH (:Session) WITH count(*) AS total
    MATCH (f:File) OPTIONAL MATCH (f)<-[:WROTE|READ]-(se:Session)
    WITH f, total, count(DISTINCT se) AS n
    SET f.sessionCount = n, f.idf = log(toFloat(total) / (1 + n))`);
  const r = await s.run(`MATCH (t:Task)<-[:ON_TASK]-(se:Session)-[w:WROTE]->(f:File)
    WITH t, f, count(DISTINCT se) AS sessions, sum(w.count) AS writes
    MERGE (t)-[rel:TOUCHES]->(f) SET rel.sessions = sessions, rel.writes = writes
    RETURN count(rel) AS n`);
  log(`  [aggregates] TOUCHES: ${r.records[0]!.get('n')}`);
}

/** Passo 5: planos órfãos. 148 pela evidência do ToolCall, o resto pelo slug. */
async function plans(s: Session): Promise<void> {
  const byTool = await s.run(`MATCH (m:Message)-[:INVOKED]->(tc:ToolCall)
    WHERE tc.name IN ['Write','Edit','MultiEdit'] AND tc.outputSnippet CONTAINS '/.claude/plans/'
    RETURN DISTINCT tc.outputSnippet AS snip, m.sessionId AS sid`);
  const rows: { path: string; sid: string }[] = [];
  for (const r of byTool.records) {
    const p = filePathFromSnippet(r.get('snip') as string);
    const sid = r.get('sid') as string;
    if (p && sid && p.includes('/.claude/plans/')) rows.push({ path: p, sid });
  }
  log(`  [plans] ${rows.length} pares plano→sessão pela evidência do ToolCall`);
  if (!apply) return;

  await s.run(`UNWIND $rows AS r
    MATCH (pl:Plan { path: r.path })
    MATCH (se:Session { id: r.sid })
    MERGE (pl)-[e:PLANNED_IN]->(se) SET e.source = 'toolcall'
    WITH pl, se
    MATCH (p:Project)-[:HAS_SESSION]->(se)
    MERGE (p)-[:HAS_PLAN]->(pl)`, { rows });

  // Fallback pelo slug: cobre o que o ToolCall não alcança (plano escrito em
  // sessão já podada, ou caminho corrompido pelo bug do redact).
  const rest = await s.run(`MATCH (pl:Plan) WHERE NOT (pl)-[:PLANNED_IN]->()
    RETURN pl.path AS path, pl.slug AS slug`);
  const bySlug = rest.records
    .map((r) => {
      const key = taskKeyFromSlug(r.get('slug') as string);
      return key ? { path: r.get('path') as string, key } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  log(`  [plans] ${bySlug.length} planos restantes ligados por código no slug`);
  await s.run(`UNWIND $rows AS r
    MATCH (pl:Plan { path: r.path })
    MERGE (t:Task { key: r.key }) ON CREATE SET t.prefix = split(r.key, '-')[0]
    MERGE (pl)-[:ABOUT_TASK]->(t)`, { rows: bySlug });
}

/**
 * Passo 7: task memory (`<repo>/.claude/tasks/EDC-1234/*.md`) ligada à Task.
 * Sem isto o doc só era alcançável por vetor/BM25: `find_decisions` e o
 * resolvedor de task da busca não o enxergavam. O nome da pasta passa pela
 * mesma normalização da branch, então `EDC-0123` e `EDC-123` caem no mesmo nó.
 */
async function taskMemory(s: Session): Promise<void> {
  const r = await s.run(`MATCH (d:TaskMemoryDoc) RETURN d.path AS path, d.taskId AS taskId`);
  const rows = r.records
    .map((rec) => {
      const key = taskKeyFromSlug(rec.get('taskId') as string);
      return key ? { path: rec.get('path') as string, key } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  log(`  [task-memory] ${rows.length}/${r.records.length} docs ligados a task`);
  if (!apply || rows.length === 0) return;
  await s.run(`UNWIND $rows AS r
    MATCH (d:TaskMemoryDoc { path: r.path })
    MERGE (t:Task { key: r.key }) ON CREATE SET t.prefix = split(r.key, '-')[0]
    MERGE (d)-[:ABOUT_TASK]->(t)`, { rows });
}

/**
 * Relações que apontam PRA uma task e mudam de dono quando o id provisório
 * vira a key do Jira. As que saem da task (IN_PROJECT, TOUCHES, CHILD_OF) são
 * recalculadas pelos agregados, então não precisam migrar.
 */
const INCOMING_TASK_RELS = ['ON_TASK', 'ABOUT_TASK', 'MENTIONS_TASK', 'FOR_TASK'] as const;

/**
 * Passo 8: pastas de task (TASKS_HOME). Cada pasta vira (ou acha) o nó da
 * task, liga docs e sessões pelo meta.json (branch e worktree), e funde o nó
 * provisório de cada alias no da task real. É o que faz as conversas de antes
 * da task existir passarem a contar como dela.
 */
async function taskFolders(s: Session): Promise<void> {
  const r = await s.run(`MATCH (f:TaskFolder) WHERE f.present = true
    RETURN f.path AS path, f.id AS id, f.aliases AS aliases, f.branches AS branches, f.worktrees AS worktrees`);
  const folders = r.records.map((x) => ({
    path: x.get('path') as string,
    id: x.get('id') as string,
    aliases: (x.get('aliases') as string[] | null) ?? [],
    branches: (x.get('branches') as string[] | null) ?? [],
    worktrees: (x.get('worktrees') as string[] | null) ?? [],
  }));
  log(`  [task-folders] ${folders.length} pastas`);
  if (!apply) return;

  for (const f of folders) {
    const { key, provisional } = taskNodeKey(f.id);
    await s.run(
      `MERGE (t:Task { key: $key })
       ON CREATE SET t.prefix = CASE WHEN $provisional THEN 'provisional' ELSE split($key, '-')[0] END
       SET t.provisional = $provisional
       WITH t
       MATCH (f:TaskFolder { path: $path })
       MERGE (f)-[:FOR_TASK]->(t)
       WITH t
       MATCH (d:TaskMemoryDoc) WHERE d.path STARTS WITH $prefix
       MERGE (d)-[:ABOUT_TASK]->(t)`,
      { key, provisional, path: f.path, prefix: `${f.path}/` },
    );

    // Sessões pela branch ou pelo worktree declarados (e pelo worktree que
    // virou alias: o nome provisório normalmente É o nome do worktree).
    const worktrees = [...new Set([...f.worktrees, ...f.aliases, f.id])];
    await s.run(
      `MATCH (se:Session)
       WHERE se.gitBranch IN $branches OR se.worktreeName IN $worktrees
       MATCH (t:Task { key: $key })
       MERGE (se)-[rel:ON_TASK]->(t) ON CREATE SET rel.source = 'task-folder'
       SET se.taskKey = coalesce(se.taskKey, $key)`,
      { branches: f.branches, worktrees, key },
    );

    for (const alias of f.aliases) {
      const a = taskNodeKey(alias).key;
      if (a === key) continue;
      for (const rel of INCOMING_TASK_RELS) {
        await s.run(
          `MATCH (x)-[old:${rel}]->(:Task { key: $alias })
           MATCH (t:Task { key: $key })
           MERGE (x)-[:${rel}]->(t)
           DELETE old`,
          { alias: a, key },
        );
      }
      await s.run(
        `MATCH (se:Session { taskKey: $alias }) SET se.taskKey = $key
         WITH count(*) AS _
         MATCH (old:Task { key: $alias }) DETACH DELETE old`,
        { alias: a, key },
      );
      // Docs gravados quando a pasta ainda tinha o nome provisório: o conteúdo
      // já foi re-ingerido no caminho novo, o antigo duplicaria na busca.
      const dir = f.path.slice(0, f.path.lastIndexOf('/'));
      await s.run(
        `MATCH (d:TaskMemoryDoc) WHERE d.path STARTS WITH $old
         OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
         DETACH DELETE c, d`,
        { old: `${dir}/${alias}/` },
      );
      await s.run(`MATCH (f:TaskFolder { path: $old }) DETACH DELETE f`, { old: `${dir}/${alias}` });
    }
  }
}

/**
 * Passo 9: tipo da sessão. Sem escrita de arquivo e sem PR = pesquisa. Serve
 * pra filtrar ("minhas pesquisas sobre X") sem misturar com implementação.
 */
async function sessionKind(s: Session): Promise<void> {
  if (!apply) {
    log('  [session-kind] (dry-run)');
    return;
  }
  const r = await s.run(`MATCH (se:Session)
    WITH se, EXISTS { (se)-[:WROTE]->(:File) } OR EXISTS { (se)-[:WORKED_ON_PR]->(:PullRequest) } AS impl
    SET se.kind = CASE WHEN impl THEN 'implementation' ELSE 'research' END
    RETURN sum(CASE WHEN impl THEN 0 ELSE 1 END) AS research, count(*) AS total`);
  log(`  [session-kind] ${r.records[0]!.get('research')} de ${r.records[0]!.get('total')} sessões são pesquisa`);
}


/**
 * Passo 10: sinais de tool nos dados que vieram antes do ingest capturar (ou de
 * sessão podada, que não dá pra relê): skill/agente do input serializado,
 * slash do texto, pareamento resultado->pedido por posição e erro pelo texto.
 * O que vier daqui fica marcado (`pairedBy`/`errorSource`) pra não se passar
 * pelo dado exato do transcript.
 */
async function toolSignals(s: Session): Promise<void> {
  const tc = await s.run(`MATCH (tc:ToolCall) WHERE tc.name IN ['Skill','Agent','Task']
      AND tc.skill IS NULL AND tc.agentType IS NULL
    RETURN tc.id AS id, tc.name AS name, tc.outputSnippet AS snip`);
  const sig = tc.records.map((r) => {
    const name = r.get('name') as string;
    const snip = r.get('snip') as string | null;
    return {
      id: r.get('id') as string,
      skill: name === 'Skill' ? skillFromSnippet(snip) : null,
      agentType: AGENT_TOOLS.has(name) ? agentFromSnippet(snip) : null,
    };
  });

  const sl = await s.run(`MATCH (m:Message { role: 'user' }) WHERE m.slash IS NULL AND m.text CONTAINS '<command-name>'
    RETURN m.uuid AS uuid, m.text AS text`);
  const slash = sl.records
    .map((r) => ({ uuid: r.get('uuid') as string, slash: slashFromText(r.get('text') as string) }))
    .filter((x) => x.slash);

  const pr = await s.run(POSITION_PAIRING_CYPHER, { onlyUnpaired: true });
  const pairs = pr.records.map((r) => ({ res: r.get('res') as string, use: r.get('use') as string }));

  const er = await s.run(`MATCH (res:ToolCall { name: 'tool_result' }) WHERE res.isError IS NULL
      AND (res.outputSnippet CONTAINS 'Exit code' OR res.outputSnippet CONTAINS '<tool_use_error>'
        OR res.outputSnippet CONTAINS "doesn't want to" OR res.outputSnippet CONTAINS 'rejected'
        OR res.outputSnippet CONTAINS 'interrupted' OR res.outputSnippet CONTAINS 'hook'
        OR res.outputSnippet CONTAINS 'denied')
    RETURN res.id AS id, res.outputSnippet AS snip`);
  const errs = er.records
    .map((r) => ({ id: r.get('id') as string, kind: classifyToolError(r.get('snip') as string, null) }))
    .filter((x) => x.kind);

  log(`  [tool-signals] ${sig.length} skill/agente, ${slash.length} slash, ${pairs.length} pareados por posição, ${errs.length} erros pelo texto`);
  if (!apply) return;
  await s.run(`UNWIND $rows AS r MATCH (tc:ToolCall { id: r.id }) SET tc.skill = r.skill, tc.agentType = r.agentType`, { rows: sig });
  await s.run(`UNWIND $rows AS r MATCH (m:Message { uuid: r.uuid }) SET m.slash = r.slash`, { rows: slash });
  for (let i = 0; i < pairs.length; i += 2000) {
    await s.run(
      `UNWIND $rows AS r MATCH (res:ToolCall { id: r.res }) MATCH (use:ToolCall { id: r.use })
       MERGE (res)-[rel:RESULT_OF]->(use) ON CREATE SET rel.pairedBy = 'position'`,
      { rows: pairs.slice(i, i + 2000) },
    );
  }
  await s.run(
    `UNWIND $rows AS r MATCH (res:ToolCall { id: r.id })
     SET res.isError = true, res.errorKind = r.kind, res.errorSource = 'text'`,
    { rows: errs },
  );
}

/**
 * Passo 11: skill, slash command e agente por sessão, e agregado por task.
 * Recalculado do zero (apaga e refaz as arestas derivadas): é barato e evita
 * contagem velha quando o backfill corrige um nome.
 */
async function skills(s: Session): Promise<void> {
  if (!apply) {
    const r = await s.run(`MATCH (tc:ToolCall) WHERE tc.skill IS NOT NULL OR tc.agentType IS NOT NULL
      RETURN count(tc.skill) AS skills, count(tc.agentType) AS agents`);
    log(`  [skills] ${r.records[0]!.get('skills')} chamadas de skill, ${r.records[0]!.get('agents')} de agente (dry-run)`);
    return;
  }
  await s.run(`MATCH ()-[r:USED_SKILL|USED_AGENT|USES_SKILL]->() DELETE r`);
  await s.run(`MATCH (se:Session)-[:HAS_MESSAGE]->(:Message)-[:INVOKED]->(tc:ToolCall) WHERE tc.skill IS NOT NULL
    WITH se, tc.skill AS name, count(*) AS n, min(tc.timestamp) AS f, max(tc.timestamp) AS l
    MERGE (k:Skill { name: name }) ON CREATE SET k.kind = 'skill'
    MERGE (se)-[u:USED_SKILL]->(k)
    SET u.toolCount = n, u.slashCount = 0, u.firstAt = f, u.lastAt = l`);
  await s.run(
    `MATCH (se:Session)-[:HAS_MESSAGE]->(m:Message) WHERE m.slash IS NOT NULL
     WITH se, m.slash AS name, count(*) AS n, min(m.timestamp) AS f, max(m.timestamp) AS l
     MERGE (k:Skill { name: name }) ON CREATE SET k.kind = CASE WHEN name IN $builtin THEN 'command' ELSE 'skill' END
     MERGE (se)-[u:USED_SKILL]->(k)
     ON CREATE SET u.toolCount = 0, u.firstAt = f, u.lastAt = l
     SET u.slashCount = n,
         u.firstAt = CASE WHEN f < u.firstAt THEN f ELSE u.firstAt END,
         u.lastAt = CASE WHEN l > u.lastAt THEN l ELSE u.lastAt END`,
    { builtin: [...BUILTIN_COMMANDS] },
  );
  await s.run(`MATCH (se:Session)-[:HAS_MESSAGE]->(:Message)-[:INVOKED]->(tc:ToolCall) WHERE tc.agentType IS NOT NULL
    WITH se, tc.agentType AS name, count(*) AS n, min(tc.timestamp) AS f
    MERGE (a:AgentType { name: name })
    MERGE (se)-[u:USED_AGENT]->(a) SET u.count = n, u.firstAt = f`);
  const r = await s.run(`MATCH (t:Task)<-[:ON_TASK]-(se:Session)-[:USED_SKILL]->(k:Skill { kind: 'skill' })
    WITH t, k, count(DISTINCT se) AS n
    MERGE (t)-[u:USES_SKILL]->(k) SET u.sessions = n
    RETURN count(u) AS n`);
  const c = await s.run(`MATCH (k:Skill) OPTIONAL MATCH (k)<-[u:USED_SKILL]-()
    RETURN count(DISTINCT k) AS skills, count(u) AS uses`);
  log(`  [skills] ${c.records[0]!.get('skills')} skills/comandos, ${c.records[0]!.get('uses')} usos por sessão, ${r.records[0]!.get('n')} task->skill`);
}

/**
 * Passo 12: correções do usuário. Percorre cada sessão em ordem e marca a
 * mensagem de usuário que corrige o passo anterior do assistant (detector em
 * src/ingest/corrections.ts). Recalculado do zero.
 */
async function corrections(s: Session): Promise<void> {
  const ids = (await s.run(`MATCH (se:Session) RETURN se.id AS id`)).records.map((r) => r.get('id') as string);
  const found: Array<{ uuid: string; level: string; signals: string[]; text: string; target: string | null }> = [];
  for (const id of ids) {
    const r = await s.run(
      `MATCH (:Session { id: $id })-[:HAS_MESSAGE]->(m:Message)
       OPTIONAL MATCH (m)-[:INVOKED]->(tc:ToolCall)
       WITH m, tc ORDER BY toInteger(split(tc.id, '::tool::')[1])
       WITH m, collect(CASE WHEN tc IS NULL THEN null ELSE
         { id: tc.id, name: tc.name, errorKind: tc.errorKind, snippet: left(tc.outputSnippet, 500) } END) AS tools
       RETURN m.uuid AS uuid, m.role AS role, m.timestamp AS ts, left(m.text, 1500) AS text, tools,
              coalesce(m.sidechain, false) AS sidechain
       ORDER BY m.timestamp`,
      { id },
    );
    const events: SessionEvent[] = r.records.map((x) => ({
      uuid: x.get('uuid') as string,
      role: x.get('role') as 'user' | 'assistant',
      sidechain: x.get('sidechain') as boolean,
      text: (x.get('text') as string | null) ?? '',
      tools: (x.get('tools') as SessionEvent['tools']).filter(Boolean),
    }));
    found.push(...detectCorrections(events));
  }
  const strong = found.filter((f) => f.level === 'strong').length;
  log(`  [corrections] ${found.length} correções (${strong} fortes, ${found.length - strong} fracas)`);
  if (!apply) return;
  await s.run(`MATCH (m:Message) WHERE m.correction IS NOT NULL
    REMOVE m.correction, m.correctionSignals, m.correctionText
    WITH m MATCH (m)-[r:CORRECTS]->() DELETE r`);
  for (let i = 0; i < found.length; i += 1000) {
    await s.run(
      `UNWIND $rows AS r MATCH (m:Message { uuid: r.uuid })
       SET m.correction = r.level, m.correctionSignals = r.signals, m.correctionText = r.text
       WITH m, r WHERE r.target IS NOT NULL
       OPTIONAL MATCH (tc:ToolCall { id: r.target })
       OPTIONAL MATCH (am:Message { uuid: r.target })
       FOREACH (_ IN CASE WHEN tc IS NULL THEN [] ELSE [1] END | MERGE (m)-[:CORRECTS]->(tc))
       FOREACH (_ IN CASE WHEN tc IS NULL AND am IS NOT NULL THEN [1] ELSE [] END | MERGE (m)-[:CORRECTS]->(am))`,
      { rows: found.slice(i, i + 1000) },
    );
  }
}

/** Passo 6: os 72 Todos são fósseis de 3 sessões que não existem. Relabela. */
async function todos(s: Session): Promise<void> {
  const r = await s.run(`MATCH (t:Todo) WHERE NOT (t)--() RETURN count(t) AS n`);
  log(`  [todos] ${r.records[0]!.get('n')} órfãos → :Orphan`);
  if (!apply) return;
  await s.run(`MATCH (t:Todo) WHERE NOT (t)--() SET t:Orphan`);
}

await withSession(async (s) => {
  await guardConstraints(s);
  log(apply ? '=== APLICANDO ===' : '=== DRY-RUN (use --apply) ===');
  const t0 = Date.now();
  if (run('tasks-from-branch')) await tasksFromBranch(s);
  if (run('tasks-from-text')) await tasksFromText(s);
  if (run('files-from-toolcalls')) await filesFromToolCalls(s);
  if (run('plans')) await plans(s);
  if (run('todos')) await todos(s);
  if (run('task-memory')) await taskMemory(s);
  // Antes dos agregados: funde alias e liga sessão por pasta, e os agregados
  // (IN_PROJECT, TOUCHES, sessionCount) já saem certos pro nó final.
  if (run('task-folders')) await taskFolders(s);
  if (run('aggregates') || run('task-folders')) await aggregates(s);
  if (run('session-kind')) await sessionKind(s);
  if (run('tool-signals')) await toolSignals(s);
  if (run('skills')) await skills(s);
  if (run('corrections')) await corrections(s);
  log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s`);
});
await closeDriver();
