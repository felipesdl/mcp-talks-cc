import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { POSITION_PAIRING_CYPHER, classifyToolError } from '../ingest/toolSignals.ts';
import { computeWeekly, summarize } from '../learning/workflow.ts';
import type { WeekRow } from '../learning/workflow.ts';

/**
 * Medição das entidades de fluxo (skill, erro, correção) em duas perguntas:
 *
 *   gate      A captura está certa? Compara o que é inferido (pareamento por
 *             posição, erro pelo texto, detector de correção) com o dado exato
 *             ou com o gabarito rotulado. É portão: abaixo do corte, não usa.
 *   gold      Gera a amostra de correções pra rotular (gold-corrections.jsonl).
 *   snapshot  Melhorou o trabalho? Grava a série semanal + resumo em
 *             workflow-metrics.jsonl. `--label=marco-zero` marca a linha de base.
 *   report    Último snapshot contra o marco zero.
 */

const CACHE = config.paths.cacheDir;
const GOLD = join(CACHE, 'gold-corrections.jsonl');
const METRICS = join(CACHE, 'workflow-metrics.jsonl');
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  rest.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const pct = (a: number, b: number): string => (b === 0 ? '-' : `${((100 * a) / b).toFixed(1)}%`);

async function gate(): Promise<void> {
  await withSession(async (s) => {
    // A1. pareamento por posição contra o exato (tool_use_id)
    const exact = await s.run(`MATCH (res:ToolCall)-[r:RESULT_OF { pairedBy: 'id' }]->(use:ToolCall)
      RETURN res.id AS res, use.id AS use`);
    const truth = new Map(exact.records.map((x) => [x.get('res') as string, x.get('use') as string]));
    const pred = await s.run(POSITION_PAIRING_CYPHER, { onlyUnpaired: false });
    let hit = 0;
    let miss = 0;
    for (const r of pred.records) {
      const t = truth.get(r.get('res') as string);
      if (t === undefined) continue;
      if (t === r.get('use')) hit++;
      else miss++;
    }
    const covered = hit + miss;
    const acc = covered ? hit / covered : 0;
    console.log(`[A1] pareamento por posição: ${hit}/${covered} certos (${pct(hit, covered)}), cobre ${pct(covered, truth.size)} dos ${truth.size} pares exatos  ${acc >= 0.98 ? 'PASSA' : 'FALHA (corte 98%)'}`);

    // A2. erro pelo texto contra o flag is_error do transcript
    const rows = await s.run(`MATCH (res:ToolCall { name: 'tool_result' }) WHERE res.errorSource = 'flag' OR (res.isError = false)
      RETURN res.isError AS isError, res.errorKind AS kind, res.outputSnippet AS snip`);
    const byKind = new Map<string, { tp: number; fp: number }>();
    let flagged = 0;
    let found = 0;
    for (const r of rows.records) {
      const isError = r.get('isError') === true;
      if (isError) flagged++;
      const k = classifyToolError(r.get('snip') as string, null);
      if (!k) continue;
      const e = byKind.get(k) ?? { tp: 0, fp: 0 };
      if (isError) {
        e.tp++;
        found++;
      } else e.fp++;
      byKind.set(k, e);
    }
    console.log(`[A2] erro pelo texto: acha ${found}/${flagged} erros reais (recall ${pct(found, flagged)})`);
    for (const [k, e] of byKind) {
      const p = e.tp / (e.tp + e.fp);
      console.log(`     ${k.padEnd(12)} precisão ${pct(e.tp, e.tp + e.fp)} (${e.tp} certos, ${e.fp} falsos)  ${p >= 0.9 ? 'PASSA' : 'FALHA (corte 90%)'}`);
    }
  });

  // A3. detector de correção contra o gabarito. Usa o nível ATUAL do grafo (por
  // uuid), não o gravado na amostra, pra medir o detector vigente.
  const gold = await readFile(GOLD, 'utf8').catch(() => '');
  const labeled = gold
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { uuid: string; level: string | null; label: boolean | null })
    .filter((g) => g.label !== null);
  if (labeled.length === 0) {
    console.log(`[A3] detector de correção: sem gabarito rotulado (npm run metrics:workflow -- gold)`);
    return;
  }
  const current = await withSession(async (s) => {
    const r = await s.run(`UNWIND $ids AS id MATCH (m:Message { uuid: id }) RETURN m.uuid AS uuid, m.correction AS level`, {
      ids: labeled.map((g) => g.uuid),
    });
    return new Map(r.records.map((x) => [x.get('uuid') as string, (x.get('level') as string | null) ?? null]));
  });
  const levelOf = (g: { uuid: string }): string | null => current.get(g.uuid) ?? null;
  for (const lvl of ['strong', 'weak']) {
    const sel = labeled.filter((g) => levelOf(g) === lvl);
    const ok = sel.filter((g) => g.label === true).length;
    const p = sel.length ? ok / sel.length : 0;
    console.log(`[A3] correção ${lvl}: precisão ${pct(ok, sel.length)} (${ok}/${sel.length})${lvl === 'strong' ? (p >= 0.7 ? '  PASSA' : '  FALHA (corte 70%)') : ''}`);
  }
  const truths = labeled.filter((g) => g.label === true);
  const caught = truths.filter((g) => levelOf(g) !== null).length;
  console.log(`[A3] recall no gabarito: ${caught}/${truths.length} correções rotuladas foram marcadas (${pct(caught, truths.length)})`);
}

/** Amostra pra rotular: N marcadas (metade fortes) + N sorteadas não marcadas. */
async function goldSample(): Promise<void> {
  const n = Number(flag('n') ?? 30);
  if (rest.includes('--append')) return goldAppend(n);
  await withSession(async (s) => {
    const marked = await s.run(
      `MATCH (m:Message) WHERE m.correction IS NOT NULL
       RETURN m.uuid AS uuid, m.correction AS level, m.correctionSignals AS signals, m.correctionText AS text, rand() AS r
       ORDER BY m.correction, r`,
    );
    const strong = marked.records.filter((r) => r.get('level') === 'strong').slice(0, Math.ceil(n / 2));
    const weak = marked.records.filter((r) => r.get('level') === 'weak').slice(0, Math.floor(n / 2));
    const neg = await s.run(
      `MATCH (m:Message { role: 'user' }) WHERE m.correction IS NULL AND size(m.text) > 15
         AND coalesce(m.sidechain, false) = false AND NOT m.text STARTS WITH 'Base directory'
         AND NOT m.text STARTS WITH '<' AND NOT m.text STARTS WITH 'This session' AND NOT m.text STARTS WITH '['
         AND NOT m.text STARTS WITH 'Another Claude' AND NOT m.text STARTS WITH 'Caveat'
       WITH m, rand() AS r ORDER BY r LIMIT toInteger($n)
       RETURN m.uuid AS uuid, null AS level, [] AS signals, left(m.text, 600) AS text`,
      { n },
    );
    const items = [...strong, ...weak, ...neg.records]
      .map((r) => ({
        uuid: r.get('uuid'),
        level: r.get('level'),
        signals: r.get('signals'),
        text: String(r.get('text') ?? '').replace(/\s+/g, ' ').slice(0, 400),
        label: null as boolean | null,
      }))
      .sort(() => Math.random() - 0.5);
    await mkdir(CACHE, { recursive: true });
    await writeFile(GOLD, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
    items.forEach((it, i) => console.log(`${i + 1}. ${it.text}`));
    console.log(`\n${items.length} itens em ${GOLD} (ordem embaralhada, sem dizer qual o detector marcou)`);
  });
}

/**
 * Lote de validação: N mensagens que o detector ATUAL marca e que ainda não
 * estão no gabarito (metade fortes), acrescentadas sem rótulo. Serve pra medir
 * fora da amostra depois de ajustar o detector com o gabarito.
 */
async function goldAppend(n: number): Promise<void> {
  const prev = (await readFile(GOLD, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { uuid: string });
  const seen = prev.map((p) => p.uuid);
  await withSession(async (s) => {
    const r = await s.run(
      `MATCH (m:Message) WHERE m.correction IS NOT NULL AND NOT m.uuid IN $seen
       RETURN m.uuid AS uuid, m.correction AS level, m.correctionSignals AS signals, m.correctionText AS text, rand() AS r
       ORDER BY r`,
      { seen },
    );
    const strong = r.records.filter((x) => x.get('level') === 'strong').slice(0, Math.ceil((n * 3) / 4));
    const weak = r.records.filter((x) => x.get('level') === 'weak').slice(0, n - strong.length);
    const items = [...strong, ...weak]
      .map((x) => ({
        uuid: x.get('uuid'),
        level: x.get('level'),
        signals: x.get('signals'),
        text: String(x.get('text') ?? '').replace(/\s+/g, ' ').slice(0, 400),
        label: null as boolean | null,
        batch: 'validacao',
      }))
      .sort(() => Math.random() - 0.5);
    await appendFile(GOLD, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
    items.forEach((it, i) => console.log(`${i + 1}. ${it.text}`));
    console.log(`\n${items.length} itens acrescentados (sem rótulo) em ${GOLD}`);
  });
}

/** Aplica rótulos aos itens ainda sem rótulo, na ordem: --not=3,7 são os que NÃO são correção. */
async function goldLabel(): Promise<void> {
  const notCorrection = new Set((flag('not') ?? '').split(',').filter(Boolean).map(Number));
  const lines = (await readFile(GOLD, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  let k = 0;
  const out = lines.map((it) => (it.label === null ? { ...it, label: !notCorrection.has(++k) } : it));
  await writeFile(GOLD, out.map((i) => JSON.stringify(i)).join('\n') + '\n');
  console.log(`${k} rotulados agora (${notCorrection.size} não são correção), ${out.length} no gabarito`);
}

async function snapshot(): Promise<void> {
  const weeks: WeekRow[] = await withSession((s) => computeWeekly(s));
  const summary = summarize(weeks);
  const entry = { v: 1, at: new Date().toISOString(), label: flag('label') ?? null, summary, weeks };
  await mkdir(CACHE, { recursive: true });
  await appendFile(METRICS, JSON.stringify(entry) + '\n');
  console.log(JSON.stringify({ label: entry.label, summary }, null, 1));
}

async function report(): Promise<void> {
  const lines = (await readFile(METRICS, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (lines.length === 0) {
    console.log('sem snapshot (npm run metrics:workflow -- snapshot --label=marco-zero)');
    return;
  }
  const zero = lines.find((l: { label: string | null }) => l.label === 'marco-zero') ?? lines[0];
  const last = lines[lines.length - 1];
  console.log(`marco zero: ${zero.at.slice(0, 10)} | último: ${last.at.slice(0, 10)}`);
  for (const k of Object.keys(last.summary)) {
    console.log(`  ${k.padEnd(34)} ${String(zero.summary[k] ?? '-').padStart(8)} -> ${String(last.summary[k] ?? '-').padStart(8)}`);
  }
}

try {
  if (cmd === 'gate') await gate();
  else if (cmd === 'gold') await goldSample();
  else if (cmd === 'label') await goldLabel();
  else if (cmd === 'snapshot') await snapshot();
  else if (cmd === 'report') await report();
  else console.error('uso: metrics:workflow gate | gold [--n=30] [--append] | label --not=3,7 | snapshot [--label=marco-zero] | report');
} finally {
  await closeDriver();
}
