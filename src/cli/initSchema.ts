import { initSchema } from '../neo4j/schema.ts';
import { closeDriver } from '../neo4j/driver.ts';

try {
  await initSchema();
  console.error('Schema OK');
} catch (e) {
  console.error('Schema init failed:', e);
  process.exitCode = 1;
} finally {
  await closeDriver();
}
