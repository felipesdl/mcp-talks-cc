import { withSession, closeDriver } from '../neo4j/driver.ts';

const BATCH = 500;
const TOP_K = 3;
const MIN_SCORE = 0.75;

interface RowRec {
  id: string;
  vec: number[];
}

async function totalChunks(): Promise<number> {
  return withSession(async (s) => {
    const r = await s.run(`MATCH (c:Chunk) RETURN count(c) AS n`);
    return Number(r.records[0]?.get('n') ?? 0);
  });
}

async function processBatch(skip: number, batch: number): Promise<number> {
  return withSession(async (s) => {
    const rows = await s.run(
      `MATCH (c:Chunk)
       RETURN c.id AS id, c.embedding AS vec
       SKIP toInteger($skip) LIMIT toInteger($batch)`,
      { skip, batch },
    );
    const items: RowRec[] = rows.records
      .map((r) => ({ id: r.get('id') as string, vec: r.get('vec') as number[] }))
      .filter((r) => Array.isArray(r.vec) && r.vec.length > 0);

    let edges = 0;
    for (const { id, vec } of items) {
      const r = await s.run(
        `CALL db.index.vector.queryNodes('chunks_embedding', toInteger($k), $vec)
         YIELD node, score
         WHERE node.id <> $id AND score >= $minScore
         WITH node, score ORDER BY score DESC LIMIT toInteger($topK)
         MATCH (src:Chunk { id: $id })
         MERGE (src)-[r:SIMILAR_TO]->(node)
         SET r.score = score, r.computedAt = datetime()
         RETURN count(r) AS created`,
        { id, vec, k: TOP_K + 1, topK: TOP_K, minScore: MIN_SCORE },
      );
      edges += Number(r.records[0]?.get('created') ?? 0);
    }
    return edges;
  });
}

async function main(): Promise<void> {
  const total = await totalChunks();
  console.error(`[similar] total chunks: ${total} | top-${TOP_K} threshold>=${MIN_SCORE}`);
  let processed = 0;
  let edges = 0;
  const t0 = Date.now();

  while (processed < total) {
    const batchEdges = await processBatch(processed, BATCH);
    edges += batchEdges;
    processed += BATCH;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const pct = Math.min(100, Math.round((processed / total) * 100));
    console.error(
      `[similar] ${Math.min(processed, total)}/${total} (${pct}%) — ${edges} edges, ${elapsed}s`,
    );
  }
  console.error(`[similar] done — ${edges} edges in ${Math.round((Date.now() - t0) / 1000)}s`);
}

try {
  await main();
} catch (e) {
  console.error('[similar] failed:', e);
  process.exitCode = 1;
} finally {
  await closeDriver();
}
