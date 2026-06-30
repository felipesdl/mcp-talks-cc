import { parseArgs } from 'node:util';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { embed } from '../embeddings/localEmbedder.ts';

const { values } = parseArgs({
  options: {
    query: { type: 'string' },
    k: { type: 'string', default: '5' },
  },
});

const query = values.query;
if (!query) {
  console.error('Usage: npm run -- --query="..." [--k=5]');
  process.exit(1);
}
const k = parseInt(values.k!, 10);

try {
  const [qvec] = await embed([query]);
  await withSession(async (s) => {
    const r = await s.run(
      `CALL db.index.vector.queryNodes('chunks_embedding', $k, $vec)
       YIELD node, score
       RETURN score,
              node.sourceKind AS source,
              node.sessionId AS sessionId,
              node.projectPath AS project,
              substring(node.text, 0, 200) AS snippet
       ORDER BY score DESC`,
      { k, vec: qvec },
    );
    console.log(`Query: "${query}"\n`);
    for (const rec of r.records) {
      console.log(`[${rec.get('score').toFixed(3)}] ${rec.get('source')} :: ${rec.get('project')}`);
      console.log(`  session: ${rec.get('sessionId')}`);
      console.log(`  ${rec.get('snippet').replace(/\n/g, ' ')}`);
      console.log();
    }
  });
} finally {
  await closeDriver();
}
