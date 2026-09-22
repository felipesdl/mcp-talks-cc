import { withSession } from './driver.ts';
import { config } from '../config.ts';

const CONSTRAINTS = [
  'CREATE CONSTRAINT project_path IF NOT EXISTS FOR (p:Project) REQUIRE p.path IS UNIQUE',
  'CREATE CONSTRAINT session_id IF NOT EXISTS FOR (s:Session) REQUIRE s.id IS UNIQUE',
  'CREATE CONSTRAINT message_uuid IF NOT EXISTS FOR (m:Message) REQUIRE m.uuid IS UNIQUE',
  'CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (c:Chunk) REQUIRE c.id IS UNIQUE',
  'CREATE CONSTRAINT plan_path IF NOT EXISTS FOR (p:Plan) REQUIRE p.path IS UNIQUE',
  'CREATE CONSTRAINT todo_id IF NOT EXISTS FOR (t:Todo) REQUIRE t.id IS UNIQUE',
  'CREATE CONSTRAINT taskdoc_path IF NOT EXISTS FOR (t:TaskMemoryDoc) REQUIRE t.path IS UNIQUE',
  'CREATE CONSTRAINT toolcall_id IF NOT EXISTS FOR (tc:ToolCall) REQUIRE tc.id IS UNIQUE',
  // Pré-requisito do backfill de entidades: sem unicidade, cada MERGE (t:Task)
  // / MERGE (f:File) vira varredura de label por linha, e o passo vai de
  // minutos para horas.
  'CREATE CONSTRAINT task_key IF NOT EXISTS FOR (t:Task) REQUIRE t.key IS UNIQUE',
  'CREATE CONSTRAINT file_key IF NOT EXISTS FOR (f:File) REQUIRE f.key IS UNIQUE',
];

const INDEXES = [
  'CREATE INDEX message_session IF NOT EXISTS FOR (m:Message) ON (m.sessionId)',
  'CREATE INDEX message_timestamp IF NOT EXISTS FOR (m:Message) ON (m.timestamp)',
  'CREATE INDEX session_project IF NOT EXISTS FOR (s:Session) ON (s.projectPath)',
  'CREATE INDEX chunk_source IF NOT EXISTS FOR (c:Chunk) ON (c.sourceKind)',
  'CREATE INDEX file_repo IF NOT EXISTS FOR (f:File) ON (f.repo)',
  'CREATE INDEX task_prefix IF NOT EXISTS FOR (t:Task) ON (t.prefix)',
];

const FULLTEXT = [
  `CREATE FULLTEXT INDEX chunks_text IF NOT EXISTS
   FOR (c:Chunk) ON EACH [c.text]`,
];

function vectorIndexStmt(dim: number): string {
  return `CREATE VECTOR INDEX chunks_embedding IF NOT EXISTS
FOR (c:Chunk) ON (c.embedding)
OPTIONS { indexConfig: {
  \`vector.dimensions\`: ${dim},
  \`vector.similarity_function\`: 'cosine'
} }`;
}

export async function initSchema(): Promise<void> {
  await withSession(async (s) => {
    for (const q of CONSTRAINTS) {
      await s.run(q);
      console.error(`✓ constraint: ${q.match(/CONSTRAINT (\w+)/)?.[1]}`);
    }
    for (const q of INDEXES) {
      await s.run(q);
      console.error(`✓ index: ${q.match(/INDEX (\w+)/)?.[1]}`);
    }
    for (const q of FULLTEXT) {
      await s.run(q);
      console.error(`✓ fulltext index: ${q.match(/INDEX (\w+)/)?.[1]}`);
    }
    await s.run(vectorIndexStmt(config.embed.dim));
    console.error(`✓ vector index: chunks_embedding (${config.embed.dim}d, cosine)`);
  });
}
