import { withSession } from '../neo4j/driver.ts';
import type {
  ProjectRecord,
  SessionRecord,
  MessageRecord,
  ToolCallRecord,
  ChunkRecord,
  PlanRecord,
  TodoRecord,
  TaskMemoryDocRecord,
  TaskFolderRecord,
  ResearchDocRecord,
  PullRequestRecord,
  RepoDocRecord,
} from './types.ts';

const BATCH = 500;

function batches<T>(arr: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function writeProjects(rows: ProjectRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    for (const batch of batches(rows)) {
      await s.run(
        `UNWIND $rows AS r
         MERGE (p:Project { path: r.path })
         SET p.name = r.name, p.lastIndexed = datetime()`,
        { rows: batch },
      );
    }
  });
}

export async function writeSessions(rows: SessionRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    for (const batch of batches(rows)) {
      // Arquivo de subagente tem o MESMO sessionId do pai e é ingerido depois
      // dele (ordem lexical). Com SET puro, o último arquivo vencia: início,
      // fim e branch da sessão viravam os do subagente. Agora o intervalo é
      // min/max, e branch/worktree do arquivo principal têm precedência.
      await s.run(
        `UNWIND $rows AS r
         MERGE (sess:Session { id: r.id })
         SET sess.projectPath = CASE WHEN r.sidechain AND sess.projectPath IS NOT NULL
                                     THEN sess.projectPath ELSE r.projectPath END,
             sess.startedAt = CASE WHEN sess.startedAt IS NULL OR (r.startedAt IS NOT NULL AND r.startedAt < sess.startedAt)
                                   THEN r.startedAt ELSE sess.startedAt END,
             sess.endedAt = CASE WHEN sess.endedAt IS NULL OR (r.endedAt IS NOT NULL AND r.endedAt > sess.endedAt)
                                 THEN r.endedAt ELSE sess.endedAt END,
             sess.gitBranch = CASE WHEN r.sidechain THEN coalesce(sess.gitBranch, r.gitBranch)
                                   ELSE coalesce(r.gitBranch, sess.gitBranch) END,
             sess.worktree = CASE WHEN r.sidechain THEN coalesce(sess.worktree, r.worktree) ELSE r.worktree END,
             sess.worktreeName = CASE WHEN r.sidechain THEN coalesce(sess.worktreeName, r.worktreeName)
                                      ELSE r.worktreeName END,
             sess.version = coalesce(r.version, sess.version)
         WITH sess
         MATCH (p:Project { path: sess.projectPath })
         MERGE (p)-[:HAS_SESSION]->(sess)`,
        { rows: batch },
      );
    }
  });
}

/**
 * messageCount contado no grafo, depois de gravar as mensagens. A sessão junta
 * o arquivo principal e os de subagente, então o tamanho de um arquivo só
 * nunca é o total.
 */
export async function refreshSessionCounts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withSession(async (s) => {
    await s.run(
      `UNWIND $ids AS id
       MATCH (sess:Session { id: id })
       OPTIONAL MATCH (sess)-[:HAS_MESSAGE]->(m:Message)
       WITH sess, count(m) AS n
       SET sess.messageCount = n`,
      { ids },
    );
  });
}

export async function writeMessages(rows: MessageRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    for (const batch of batches(rows)) {
      await s.run(
        `UNWIND $rows AS r
         MERGE (m:Message { uuid: r.uuid })
         SET m.sessionId = r.sessionId,
             m.role = r.role,
             m.timestamp = r.timestamp,
             m.parentUuid = r.parentUuid,
             // m.text é obrigatório: sem ele get_session_transcript devolve
             // transcript vazio e o sinal de echo do self-tune fica impossível
             // de calcular (não há resposta do assistant pra comparar).
             m.text = r.text,
             m.slash = r.slash,
             m.sidechain = r.sidechain
         WITH m, r
         MATCH (sess:Session { id: r.sessionId })
         MERGE (sess)-[:HAS_MESSAGE]->(m)`,
        { rows: batch },
      );
    }
    // Link replies in a second pass (parentUuid -> Message)
    for (const batch of batches(rows.filter((r) => r.parentUuid))) {
      await s.run(
        `UNWIND $rows AS r
         MATCH (child:Message { uuid: r.uuid })
         MATCH (parent:Message { uuid: r.parentUuid })
         MERGE (child)-[:REPLIES_TO]->(parent)`,
        { rows: batch },
      );
    }
  });
}

export async function writeToolCalls(rows: ToolCallRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    for (const batch of batches(rows)) {
      await s.run(
        `UNWIND $rows AS r
         MERGE (tc:ToolCall { id: r.id })
         SET tc.name = r.name,
             tc.outputSnippet = r.outputSnippet,
             tc.timestamp = r.timestamp,
             tc.toolUseId = r.toolUseId,
             tc.isError = r.isError,
             tc.errorKind = r.errorKind,
             tc.errorSource = CASE WHEN r.isError IS NULL THEN tc.errorSource ELSE 'flag' END,
             tc.skill = r.skill,
             tc.agentType = r.agentType
         WITH tc, r
         MATCH (m:Message { uuid: r.messageUuid })
         MERGE (m)-[:INVOKED]->(tc)`,
        { rows: batch },
      );
    }
    // Resultado -> pedido pelo id do tool_use (dado exato). Segundo passo
    // porque o pedido e o resultado moram em mensagens diferentes.
    for (const batch of batches(rows.filter((r) => r.name === 'tool_result' && r.toolUseId))) {
      await s.run(
        `UNWIND $rows AS r
         MATCH (res:ToolCall { id: r.id })
         MATCH (use:ToolCall { toolUseId: r.toolUseId }) WHERE use.name <> 'tool_result'
         MERGE (res)-[rel:RESULT_OF]->(use) SET rel.pairedBy = 'id'`,
        { rows: batch },
      );
    }
  });
}

/**
 * Ids de chunk que já estão no grafo com o MESMO texto e embedding da dimensão
 * atual. O id só hasheia os 200 primeiros chars, então comparar o texto inteiro
 * é o que garante que o vetor gravado ainda vale (plan editado no fim, etc.).
 */
export async function findReusableChunkIds(
  rows: Array<{ id: string; text: string }>,
  dim: number,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (rows.length === 0) return out;
  await withSession(async (s) => {
    for (const batch of batches(rows)) {
      const res = await s.run(
        `UNWIND $rows AS r
         MATCH (c:Chunk { id: r.id })
         WHERE c.text = r.text AND c.embedding IS NOT NULL AND size(c.embedding) = $dim
         RETURN c.id AS id`,
        { rows: batch, dim },
      );
      for (const rec of res.records) out.add(rec.get('id') as string);
    }
  });
  return out;
}

export async function writeChunks(rows: ChunkRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    // Split by parentLabel to keep Cypher static (avoid dynamic labels)
    const byLabel = new Map<ChunkRecord['parentLabel'], ChunkRecord[]>();
    for (const r of rows) {
      if (!byLabel.has(r.parentLabel)) byLabel.set(r.parentLabel, []);
      byLabel.get(r.parentLabel)!.push(r);
    }
    for (const [label, list] of byLabel) {
      const matchClause =
        label === 'Message'
          ? 'MATCH (parent:Message { uuid: r.parentKey })'
          : label === 'Plan'
            ? 'MATCH (parent:Plan { path: r.parentKey })'
            : label === 'TaskMemoryDoc'
              ? 'MATCH (parent:TaskMemoryDoc { path: r.parentKey })'
              : label === 'ToolCall'
                ? 'MATCH (parent:ToolCall { id: r.parentKey })'
                : label === 'ResearchDoc'
                  ? 'MATCH (parent:ResearchDoc { path: r.parentKey })'
                  : label === 'PullRequest'
                    ? 'MATCH (parent:PullRequest { key: r.parentKey })'
                    : label === 'RepoDoc'
                      ? 'MATCH (parent:RepoDoc { key: r.parentKey })'
                      : label === 'Skill'
                        ? 'MATCH (parent:Skill { name: r.parentKey })'
                        : 'MATCH (parent:Todo { id: r.parentKey })';
      for (const batch of batches(list)) {
        await s.run(
          `UNWIND $rows AS r
           MERGE (c:Chunk { id: r.id })
           SET c.text = r.text,
               c.ordinal = r.ordinal,
               c.sourceKind = r.sourceKind,
               c.projectPath = r.projectPath,
               c.sessionId = r.sessionId,
               c.timestamp = r.timestamp,
               c.role = r.role,
               c.embedding = coalesce(r.embedding, c.embedding)
           WITH c, r
           ${matchClause}
           MERGE (parent)-[:HAS_CHUNK]->(c)`,
          { rows: batch },
        );
      }
    }
  });
}

export async function writePlans(rows: PlanRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    for (const batch of batches(rows)) {
      await s.run(
        `UNWIND $rows AS r
         MERGE (p:Plan { path: r.path })
         SET p.slug = r.slug, p.createdAt = r.createdAt`,
        { rows: batch },
      );
    }
  });
}

export async function writeTodos(rows: TodoRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    for (const batch of batches(rows)) {
      await s.run(
        `UNWIND $rows AS r
         MERGE (t:Todo { id: r.id })
         SET t.content = r.content,
             t.status = r.status,
             t.sessionId = r.sessionId,
             t.filePath = r.filePath
         WITH t, r
         WHERE r.sessionId IS NOT NULL
         OPTIONAL MATCH (sess:Session { id: r.sessionId })
         FOREACH (_ IN CASE WHEN sess IS NULL THEN [] ELSE [1] END |
           MERGE (sess)-[:HAS_TODO]->(t)
         )`,
        { rows: batch },
      );
    }
  });
}

export async function writeTaskMemoryDocs(rows: TaskMemoryDocRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    for (const batch of batches(rows)) {
      await s.run(
        `UNWIND $rows AS r
         MERGE (d:TaskMemoryDoc { path: r.path })
         SET d.taskId = r.taskId,
             d.kind = r.kind,
             d.projectPath = r.projectPath,
             d.lastModified = r.lastModified
         WITH d, r
         OPTIONAL MATCH (p:Project { path: r.projectPath })
         FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END |
           MERGE (p)-[:HAS_TASK_MEMORY]->(d)
         )`,
        { rows: batch },
      );
    }
  });
}

/** `rows` é a lista inteira da pasta central: o que não está nela sumiu do disco (rm à mão, rename sem link). */
export async function writeTaskFolders(rows: TaskFolderRecord[]): Promise<void> {
  await withSession(async (s) => {
    if (rows.length > 0) {
      await s.run(
        `UNWIND $rows AS r
         MERGE (f:TaskFolder { path: r.path })
         SET f.id = r.id, f.aliases = r.aliases, f.repos = r.repos, f.branches = r.branches,
             f.worktrees = r.worktrees, f.lastModified = r.lastModified, f.present = true`,
        { rows },
      );
    }
    await s.run(
      `MATCH (f:TaskFolder { present: true }) WHERE NOT f.path IN $paths
       SET f.present = false, f.missingAt = toString(datetime())`,
      { paths: rows.map((r) => r.path) },
    );
  });
}

export async function writeResearchDocs(rows: ResearchDocRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    await s.run(
      `UNWIND $rows AS r
       MERGE (d:ResearchDoc { path: r.path })
       SET d.title = r.title, d.createdAt = r.createdAt`,
      { rows },
    );
  });
}

export async function writePullRequests(rows: PullRequestRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    await s.run(
      `UNWIND $rows AS r
       MERGE (pr:PullRequest { key: r.key })
       SET pr.repo = r.repo, pr.number = r.number, pr.title = r.title, pr.url = r.url,
           pr.state = r.state, pr.createdAt = r.createdAt, pr.mergedAt = r.mergedAt,
           pr.closedAt = r.closedAt, pr.branch = r.branch, pr.bodySha = r.bodySha,
           pr.syncedAt = toString(datetime())
       WITH pr, r
       MERGE (t:Task { key: r.task }) ON CREATE SET t.prefix = split(r.task, '-')[0]
       MERGE (pr)-[:FOR_TASK]->(t)`,
      { rows },
    );
  });
}

export async function writeRepoDocs(rows: RepoDocRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withSession(async (s) => {
    await s.run(
      `UNWIND $rows AS r
       MERGE (p:Project { path: r.repoPath }) ON CREATE SET p.name = r.repo
       MERGE (d:RepoDoc { key: r.key })
       SET d.repo = r.repo, d.path = r.path, d.sha = r.sha, d.author = r.author,
           d.updatedAt = r.updatedAt, d.removed = false
       MERGE (p)-[:HAS_DOC]->(d)`,
      { rows },
    );
  });
}

/**
 * Apaga os chunks de um documento antes de regravar. Doc que encolhe deixaria
 * chunk velho órfão com texto que não existe mais.
 */
export async function deleteChunksOf(
  label: 'PullRequest' | 'RepoDoc' | 'ResearchDoc' | 'TaskMemoryDoc' | 'Skill',
  keyProp: 'key' | 'path' | 'name',
  keys: string[],
  /** Chunks que vão ser regravados: ficam, pra manter o vetor reaproveitado (embedding null no writeChunks). */
  keepIds: string[] = [],
): Promise<void> {
  if (keys.length === 0) return;
  await withSession(async (s) => {
    await s.run(
      `UNWIND $keys AS k
       MATCH (d:${label} { ${keyProp}: k })-[:HAS_CHUNK]->(c:Chunk)
       WHERE NOT c.id IN $keep
       DETACH DELETE c`,
      { keys, keep: keepIds },
    );
  });
}
