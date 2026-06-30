// Promove tuning.candidate.json -> tuning.json (gate humano do loop).
// Valida bounds via zod, snapshota o tuning atual p/ rollback, write atômico.
import { copyFile } from 'node:fs/promises';
import { learningPaths } from '../learning/paths.ts';
import { readJson, writeAtomic } from '../learning/fsUtil.ts';
import { tuningSchema } from '../learning/types.ts';

const candidate = await readJson<unknown>(learningPaths.tuningCandidate);
if (!candidate) {
  console.error(`[self-tune:accept] sem candidate em ${learningPaths.tuningCandidate}. Rode npm run self-tune primeiro.`);
  process.exit(1);
}

const parsed = tuningSchema.safeParse(candidate);
if (!parsed.success) {
  console.error('[self-tune:accept] candidate inválido (fora dos bounds?):');
  console.error(parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

const current = await readJson<unknown>(learningPaths.tuning);
if (current) {
  await copyFile(learningPaths.tuning, learningPaths.tuningSnapshot);
  console.log(`[self-tune:accept] snapshot do tuning atual em ${learningPaths.tuningSnapshot} (rollback: copiar de volta)`);
}

await writeAtomic(learningPaths.tuning, JSON.stringify(parsed.data, null, 2) + '\n');
console.log(`[self-tune:accept] aplicado: ${learningPaths.tuning}`);
console.log(JSON.stringify(parsed.data, null, 2));
console.log('[self-tune:accept] search_memory pega o novo tuning em até 1min (cache de mtime).');
