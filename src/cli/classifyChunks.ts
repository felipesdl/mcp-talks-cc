import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { scoreVector, type ValueModel } from '../classify/train.ts';

/**
 * Aplica o modelo de valor aos Chunks já indexados.
 *
 * Grava a PROBABILIDADE (`valueScore`), nunca um booleano. O corte de quando
 * rebaixar é aplicado na busca, a partir de uma constante: assim recalibrar é
 * editar um número e reiniciar, em vez de varrer 52 mil chunks de novo.
 *
 * Não reembeda nada — lê o `c.embedding` que já está no grafo. Não apaga nada,
 * então as arestas SIMILAR_TO ficam intactas. Não escreve `c.text` nem
 * `c.embedding`, então nem o índice fulltext nem o vetorial reindexam.
 */

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    page: { type: 'string', default: '2000' },
    force: { type: 'boolean', default: false },
  },
});

const PAGE = parseInt(values.page as string, 10);
const apply = values.apply as boolean;
const force = values.force as boolean;

const modelPath = join(config.paths.cacheDir, 'value-model.json');
if (!existsSync(modelPath)) {
  console.error(`modelo não encontrado em ${modelPath} — rode 'npm run train:value -- --apply' antes`);
  process.exit(1);
}
const model = JSON.parse(readFileSync(modelPath, 'utf8')) as ValueModel;
const version = `${model.labelerVersion}:${model.trainedAt}`;
console.error(`[classify] modelo ${model.labelerVersion} treinado em ${model.trainedAt}`);

// Só conversa: Plan e TaskMemoryDoc são documentos, não têm o problema de
// narração de processo, e ficam com valueScore nulo (multiplicador neutro).
const predicate = force
  ? `c.sourceKind = 'conversation' AND c.embedding IS NOT NULL`
  : `c.sourceKind = 'conversation' AND c.embedding IS NOT NULL AND (c.valueVersion IS NULL OR c.valueVersion <> $version)`;

await withSession(async (s) => {
  const total = await s.run(
    `MATCH (c:Chunk) WHERE ${predicate} RETURN count(c) AS n`,
    { version },
  );
  const pending = Number(total.records[0]!.get('n'));
  console.log(`chunks a classificar: ${pending}`);
  if (pending === 0) return;

  // Paginação por cursor de id: estável sob escrita concorrente, ao contrário
  // de SKIP/LIMIT, que re-escaneia e pode pular linha quando o conjunto muda.
  let cursor = '';
  let done = 0;
  const hist = { entrega: 0, provisorio: 0 };
  const buckets = [0, 0, 0, 0, 0];
  const t0 = Date.now();

  for (;;) {
    const page = await s.run(
      `MATCH (c:Chunk) WHERE ${predicate} AND c.id > $cursor
       RETURN c.id AS id, c.embedding AS e
       ORDER BY c.id LIMIT toInteger($page)`,
      { cursor, page: PAGE, version },
    );
    if (page.records.length === 0) break;

    const rows = page.records.map((r) => {
      const p = scoreVector(model, r.get('e') as number[]);
      if (p >= 0.5) hist.entrega++; else hist.provisorio++;
      buckets[Math.min(4, Math.floor(p * 5))]!++;
      return { id: r.get('id') as string, score: p };
    });
    cursor = rows[rows.length - 1]!.id;
    done += rows.length;

    if (apply) {
      await s.run(
        `UNWIND $rows AS r
         MATCH (c:Chunk { id: r.id })
         SET c.valueScore = r.score, c.valueVersion = $version`,
        { rows, version },
      );
    }
    process.stderr.write(`\r[classify] ${done}/${pending}`);
    if (!apply && done >= pending) break;
  }
  process.stderr.write('\n');

  console.log(`\nprevisto entrega: ${hist.entrega}  provisório: ${hist.provisorio}`);
  console.log('distribuição de P(entrega):');
  const faixas = ['0,0-0,2', '0,2-0,4', '0,4-0,6', '0,6-0,8', '0,8-1,0'];
  buckets.forEach((n, i) => console.log(`  ${faixas[i]}  ${String(n).padStart(6)}  ${((n / done) * 100).toFixed(1)}%`));
  console.log(`\n${apply ? 'gravado' : 'DRY-RUN, nada gravado'} em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
});

await closeDriver();
