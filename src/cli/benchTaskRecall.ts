import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { taskTargets, measureRecall, digest } from '../classify/taskRecall.ts';

// Sem isto, as buscas do bench entram no query-log e envenenam a CDF de
// vec_score que o self-tune usa para calibrar `confidence`.
process.env.MCP_TALKS_DISABLE_QUERY_LOG = '1';

const targets = await withSession((s) => taskTargets(s));
const r = await measureRecall(targets);

console.log('### invariante de recuperação por task (população inteira)');
console.log('  ' + digest(r));

const out = join(config.paths.cacheDir, 'task-recall.json');
writeFileSync(out, JSON.stringify({ v: 1, ranAt: new Date().toISOString(), ...r }, null, 2));
console.log(`\ngravado em ${out}`);

await closeDriver();
