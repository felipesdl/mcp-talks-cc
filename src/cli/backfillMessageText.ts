/**
 * Backfill de Message.text.
 *
 * Reparo pra quando Message.text ficar vazio no grafo (foi o caso enquanto
 * writeMessages() não gravava o campo). Sem texto, get_session_transcript
 * devolve transcript vazio e o sinal de echo do self-tune fica impossível de
 * calcular: não há resposta do assistant pra comparar com os chunks.
 *
 * Este script re-parseia os JSONL em disco e SÓ atualiza o texto: não embeda,
 * não toca em Chunk, não mexe no checkpoint do ingest. Ordens de magnitude mais
 * barato que um `ingest --force`, que re-embedaria o grafo inteiro.
 *
 * Sessão cujo JSONL o Claude Code já podou (>30d) não tem como ser recuperada.
 */
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import { parseSessionFile } from '../ingest/sources/conversations.ts';
import { withSession, closeDriver } from '../neo4j/driver.ts';

const { values } = parseArgs({
  options: { limit: { type: 'string' }, 'only-empty': { type: 'boolean', default: true } },
});
const limit = values.limit ? parseInt(values.limit, 10) : undefined;
const onlyEmpty = values['only-empty'] !== false;

const BATCH = 500;

async function listFiles(): Promise<string[]> {
  const projectsDir = join(config.paths.claudeHome, 'projects');
  const out: string[] = [];
  const dirs = await readdir(projectsDir).catch(() => [] as string[]);
  for (const d of dirs) {
    const dp = join(projectsDir, d);
    const st = await stat(dp).catch(() => null);
    if (!st?.isDirectory()) continue;
    const entries = (await readdir(dp, { recursive: true })) as string[];
    for (const f of entries) if (f.endsWith('.jsonl')) out.push(join(dp, f));
  }
  return out.sort();
}

async function run(): Promise<void> {
  const files = await listFiles();
  const target = limit ? files.slice(0, limit) : files;
  console.error(`[backfill] ${target.length} arquivos (only-empty=${onlyEmpty})`);

  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (let i = 0; i < target.length; i++) {
    const fp = target[i]!;
    const parsed = await parseSessionFile(fp, false);
    if (!parsed) {
      skipped++;
      continue;
    }
    const rows = parsed.messages
      .filter((m) => m.text.trim().length > 0)
      .map((m) => ({ uuid: m.uuid, text: m.text }));
    if (rows.length === 0) {
      skipped++;
      continue;
    }

    let fileUpdated = 0;
    let fileMissing = 0;
    await withSession(async (s) => {
      for (let j = 0; j < rows.length; j += BATCH) {
        const batch = rows.slice(j, j + BATCH);
        const r = await s.run(
          `UNWIND $rows AS r
           MATCH (m:Message { uuid: r.uuid })
           WHERE NOT $onlyEmpty OR m.text IS NULL OR trim(m.text) = ''
           SET m.text = r.text
           RETURN count(m) AS n`,
          { rows: batch, onlyEmpty },
        );
        const n = Number(r.records[0]?.get('n') ?? 0);
        fileUpdated += n;
        fileMissing += batch.length - n;
      }
    });

    updated += fileUpdated;
    missing += fileMissing;
    if (fileUpdated > 0) {
      console.error(
        `[backfill] ${i + 1}/${target.length} ${basename(fp)} — ${fileUpdated} msg atualizadas` +
          (fileMissing > 0 ? ` (${fileMissing} sem nó ou já com texto)` : ''),
      );
    }
  }

  console.error(
    `[backfill] done: ${updated} mensagens atualizadas, ${missing} sem nó/já preenchidas, ${skipped} arquivos sem texto`,
  );
}

try {
  await run();
} catch (e) {
  console.error('[backfill] failed:', e);
  process.exitCode = 1;
} finally {
  await closeDriver();
}
