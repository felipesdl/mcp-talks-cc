// Recusa tuning.candidate.json (gate humano do loop, lado negativo).
// Sem isso o loop só tinha "aplicar": o self-tune regenera o candidate a cada
// sessão e o primer cobra accept indefinidamente, então uma proposta ruim vira
// pressão permanente pra aplicar. Registra a recusa por CONTEÚDO — proposta nova
// e diferente volta a cobrar accept normalmente.
import { rm } from 'node:fs/promises';
import { learningPaths } from '../learning/paths.ts';
import { readJson, writeAtomic } from '../learning/fsUtil.ts';
import { buildPrimer } from '../learning/primer.ts';
import { sanitizeTuning } from '../mcp/tuning.ts';
import type { Profile, TuningRejection } from '../learning/types.ts';

const candidate = await readJson<unknown>(learningPaths.tuningCandidate);
if (!candidate) {
  console.error(
    `[self-tune:reject] sem candidate em ${learningPaths.tuningCandidate}, nada a recusar.`,
  );
  process.exit(1);
}

// sanitizeTuning em vez de tuningSchema: candidate fora dos bounds também tem que
// ser recusável, e a comparação lá no self-tune roda sobre a forma sanitizada.
const tuning = sanitizeTuning(candidate);
const profile = await readJson<Profile>(learningPaths.profile);

const rejection: TuningRejection = {
  v: 1,
  rejectedAt: new Date().toISOString(),
  nGrades: profile?.lastEval.queriesGraded ?? null,
  tuning,
};
await writeAtomic(learningPaths.tuningRejected, JSON.stringify(rejection, null, 2) + '\n');
console.log(`[self-tune:reject] recusa registrada em ${learningPaths.tuningRejected}`);
console.log(JSON.stringify(tuning, null, 2));

await rm(learningPaths.tuningCandidate, { force: true });

// primer.json foi escrito pelo run que propôs, com o aviso "TUNING PENDENTE"
// embutido. Regrava sem o aviso, senão a próxima sessão cobra uma proposta já
// recusada (mesma razão do accept).
if (profile) {
  const primer = buildPrimer(profile, null);
  if (primer) {
    await writeAtomic(learningPaths.primer, primer);
    console.log(`[self-tune:reject] primer regravado sem aviso de pendência: ${learningPaths.primer}`);
  }
}

console.log(
  '[self-tune:reject] tuning aplicado não muda. Proposta diferente volta a cobrar accept; ' +
    'um accept futuro limpa este registro.',
);
