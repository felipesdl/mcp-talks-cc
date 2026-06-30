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
      await s.run(
        `UNWIND $rows AS r
         MERGE (sess:Session { id: r.id })
         SET sess.projectPath = r.projectPath,
             sess.startedAt = r.startedAt,
             sess.endedAt = r.endedAt,
             sess.messageCount = r.messageCount,
             sess.gitBranch = r.gitBranch,
             sess.version = r.version
         WITH sess, r
         MATCH (p:Project { path: r.projectPath })
         MERGE (p)-[:HAS_SESSION]->(sess)`,
        { rows: batch },
      );
    }
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
             m.parentUuid = r.parentUuid
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
             tc.timestamp = r.timestamp
         WITH tc, r
         MATCH (m:Message { uuid: r.messageUuid })
         MERGE (m)-[:INVOKED]->(tc)`,
        { rows: batch },
      );
    }
  });
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
               c.embedding = r.embedding
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
         MATCH (p:Project { path: r.projectPath })
         MERGE (p)-[:HAS_TASK_MEMORY]->(d)`,
        { rows: batch },
      );
    }
  });
}
