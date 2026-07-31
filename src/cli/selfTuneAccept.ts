// Promove tuning.candidate.json -> tuning.json (gate humano do loop).
// Valida bounds via zod, snapshota o tuning atual p/ rollback, write atômico.
import { copyFile, rm } from 'node:fs/promises';
import { learningPaths } from '../learning/paths.ts';
import { readJson, writeAtomic } from '../learning/fsUtil.ts';
import { buildPrimer } from '../learning/primer.ts';
import { tuningSchema, type Profile } from '../learning/types.ts';

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

// Candidate promovido deixa de ser pendência: sem esse rm o primer da próxima
// sessão continua cobrando accept, e o self-tune trata o arquivo como proposta viva.
await rm(learningPaths.tuningCandidate, { force: true });

// primer.json foi escrito pelo run que propôs, com o aviso "TUNING PENDENTE"
// embutido. Regrava sem o aviso, senão a próxima sessão cobra um accept já feito.
const profile = await readJson<Profile>(learningPaths.profile);
if (profile) {
  const primer = buildPrimer(profile, null);
  if (primer) {
    await writeAtomic(learningPaths.primer, primer);
    console.log(`[self-tune:accept] primer regravado sem aviso de pendência: ${learningPaths.primer}`);
  }
}

console.log('[self-tune:accept] search_memory pega o novo tuning em até 1min (cache de mtime).');
