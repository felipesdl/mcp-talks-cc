// Apaga Chunks de conversa que o filtro de qualidade rejeita.
//
// Necessário porque `Chunk.id` é derivado do conteúdo
// (sha1(parentKey::ordinal::texto)) e `writeChunks` só faz MERGE: chunk que já
// entrou no grafo nunca sai sozinho, nem com `ingest --force`. Sem este passo,
// ligar o filtro no ingest só protege arquivo novo.
//
// Dry-run é o default. Só apaga com --apply.
import { parseArgs } from 'node:util';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { lowValueReason, stripWrappers, type LowValueReason } from '../ingest/quality.ts';

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    page: { type: 'string', default: '5000' },
    samples: { type: 'string', default: '5' },
  },
});

const APPLY = values.apply === true;
const PAGE = parseInt(values.page!, 10);
const SAMPLES_PER_REASON = parseInt(values.samples!, 10);
const DELETE_BATCH = 1000;

const counts: Record<LowValueReason, number> = { empty: 0, filler: 0, short: 0 };
const samples: Record<LowValueReason, string[]> = { empty: [], filler: [], short: [] };
const doomed: string[] = [];
let scanned = 0;

try {
  await withSession(async (s) => {
    // Paginação por id (index chunk_id é RANGE, então ORDER BY id é barato).
    let cursor = '';
    for (;;) {
      const res = await s.run(
        `MATCH (c:Chunk { sourceKind: 'conversation' })
         WHERE c.id > $cursor
         RETURN c.id AS id, c.text AS text
         ORDER BY c.id
         LIMIT toInteger($page)`,
        { cursor, page: PAGE },
      );
      if (res.records.length === 0) break;

      for (const rec of res.records) {
        const id = rec.get('id') as string;
        const text = (rec.get('text') as string) ?? '';
        cursor = id;
        scanned++;

        const reason = lowValueReason(stripWrappers(text));
        if (!reason) continue;
        counts[reason]++;
        doomed.push(id);
        if (samples[reason].length < SAMPLES_PER_REASON) {
          samples[reason].push(text.slice(0, 120).replace(/\n/g, ' '));
        }
      }
    }

    const total = doomed.length;
    console.log(`\n[prune] varridos ${scanned} chunks conversation`);
    console.log(
      `[prune] rejeitados ${total} (${scanned > 0 ? ((100 * total) / scanned).toFixed(1) : '0'}%) — empty=${counts.empty} filler=${counts.filler} short=${counts.short}`,
    );
    for (const reason of ['empty', 'filler', 'short'] as const) {
      if (samples[reason].length === 0) continue;
      console.log(`\n  amostra ${reason}:`);
      for (const t of samples[reason]) console.log(`    · ${t}`);
    }

    if (!APPLY) {
      console.log(
        `\n[prune] DRY-RUN, nada apagado. Confira a amostra e rode com --apply pra executar.`,
      );
      return;
    }

    console.log(`\n[prune] apagando ${total} chunks...`);
    let deleted = 0;
    for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
      const batch = doomed.slice(i, i + DELETE_BATCH);
      // DETACH: derruba HAS_CHUNK e as arestas SIMILAR_TO precomputadas.
      const r = await s.run(
        `UNWIND $ids AS id
         MATCH (c:Chunk { id: id })
         DETACH DELETE c
         RETURN count(*) AS n`,
        { ids: batch },
      );
      deleted += Number(r.records[0]?.get('n') ?? 0);
      console.log(`[prune] ${deleted}/${total}`);
    }
    console.log(
      `\n[prune] done: ${deleted} apagados. SIMILAR_TO foi derrubada junto — rode: npm run rebuild:similar`,
    );
  });
} finally {
  await closeDriver();
}
