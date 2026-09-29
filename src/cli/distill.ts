import { withSession, closeDriver } from '../neo4j/driver.ts';
import {
  buildSessionInput,
  callClaude,
  markDistilled,
  pendingSessions,
  writeDecisions,
} from '../distill/distill.ts';

/**
 * Distila sessões fechadas em nós Decision (ver src/distill/distill.ts).
 *
 *   npm run distill -- [--limit=10] [--recent-days=7] [--oldest-first] [--session=<id>] [--dry-run]
 *
 * --recent-days limita a sessões com atividade nos últimos N dias: é o modo do
 * hook pro que é novo. --oldest-first anda o backlog da mais antiga pra mais
 * nova: o hook usa isso em lote pequeno, então o que é recente (e está em uso)
 * não muda enquanto o histórico velho vai sendo destilado.
 *
 * Incremental por construção: a sessão ganha `distillVersion` depois de
 * processada, com ou sem item. Erro de chamada também marca (com
 * `distillError`), senão uma sessão problemática seria re-tentada em todo
 * SessionStart pra sempre. Pra re-tentar, subir DISTILL_VERSION.
 */

const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const LIMIT = Number(arg('limit') ?? 10);
const ONLY = arg('session');
const DRY = process.argv.includes('--dry-run');
const RECENT = arg('recent-days') ? Number(arg('recent-days')) : null;
const OLDEST_FIRST = process.argv.includes('--oldest-first');

if (process.env.MCP_TALKS_IN_DISTILL === '1') process.exit(0);

let total = 0;
let failed = 0;
await withSession(async (s) => {
  const ids = ONLY ? [ONLY] : await pendingSessions(s, LIMIT, RECENT, OLDEST_FIRST);
  console.error(`[distill] ${ids.length} sessões${DRY ? ' (dry-run)' : ''}`);
  for (const id of ids) {
    const input = await buildSessionInput(s, id);
    if (!input) {
      if (!DRY) await markDistilled(s, id, 0);
      continue;
    }
    const t0 = Date.now();
    try {
      const items = await callClaude(input);
      if (DRY) {
        console.log(`\n# ${id} ${input.projectPath ?? ''} ${input.tasks.join(',')} (${input.text.length} chars, ${Date.now() - t0}ms)`);
        for (const i of items) console.log(`- [${i.kind}/${i.scope}/${i.confidence}] ${i.text}${i.files.length ? ` {${i.files.join(', ')}}` : ''}`);
        continue;
      }
      const n = await writeDecisions(s, input, items);
      total += n;
      console.error(`[distill] ${id.slice(0, 8)} +${n} (${items.length} extraídos, ${Date.now() - t0}ms)`);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[distill] ${id.slice(0, 8)} falhou: ${msg}`);
      if (!DRY) await markDistilled(s, id, 0, msg.slice(0, 200));
    }
  }
});
console.error(`[distill] done: +${total} decisions, ${failed} falhas`);
await closeDriver();
