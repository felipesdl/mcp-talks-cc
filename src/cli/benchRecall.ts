import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Bench de recall com gabarito (~/.cache/mcp-talks-cc/recall-eval.jsonl).
 *
 * É o juiz de qualquer mudança de ranking. O bench de task (bench:task-recall)
 * só prova o plumbing de `EDC-XXXX` → sessão, que é quase tautológico; este
 * mede prosa, que é onde o bge-m3 comprimido falha.
 *
 * Cada caso roda "no momento" da query original (until = ts, sessão chamadora
 * excluída), senão a conversa onde a busca nasceu vira o hit nº 1.
 *
 * Também deriva o gate de citação a partir do gabarito: FORTE = menor
 * confidence com precision >= 0.8, PISO = menor com precision >= 0.5. Antes o
 * gate era p75/p25 do top hit, uma cota: 25% das queries saíam "forte" por
 * construção, relevante ou não. O gate só é publicado (bench-gate.json) num
 * run com a config em uso, nunca num A/B.
 *
 *   npm run bench:recall -- [--label=x] [--tuning=/path/tuning.json]
 *                           [--exclude-kinds=decision] [--k=8] [--verbose]
 */

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

process.env.MCP_TALKS_DISABLE_QUERY_LOG = '1';

// import dinâmico: config de busca lê env no load do módulo
const { runRecallBench, readEvalCases } = await import('../learning/recallBench.ts');
const { setTuningOverride, sanitizeTuning } = await import('../mcp/tuning.ts');
const { closeDriver } = await import('../neo4j/driver.ts');
const { learningPaths } = await import('../learning/paths.ts');

const tuningFile = arg('tuning');
if (tuningFile) setTuningOverride(sanitizeTuning(JSON.parse(readFileSync(tuningFile, 'utf8'))));
const K = Number(arg('k') ?? 8);
const EXCLUDE = (arg('exclude-kinds') ?? '').split(',').filter(Boolean);
const ALL_KINDS = ['conversation', 'plan', 'task_memory', 'decision'] as const;
const SCOPE = EXCLUDE.length ? ALL_KINDS.filter((k) => !EXCLUDE.includes(k)) : undefined;
const MAX_PER_SESSION = process.env.MCP_TALKS_MAX_PER_SESSION;

const cases = readEvalCases();
if (!cases) {
  console.error(`sem gabarito em ${learningPaths.recallEval}. Gere candidatos com npm run eval:candidates.`);
  process.exit(1);
}

const r = await runRecallBench(cases, { k: K, ...(SCOPE ? { scope: [...SCOPE] } : {}) });
const pct = (a: number): string => `${(a * 100).toFixed(1)}%`;

console.log(`### bench:recall (${r.nCases} casos, ${r.none} sem resposta, k=${K})`);
for (const [kind, v] of Object.entries(r.perKind).sort()) {
  console.log(`  ${kind.padEnd(9)} n=${v.n}  r@3=${pct(v.r3 / v.n)}  r@${K}=${pct(v.r8 / v.n)}  MRR=${(v.rr / v.n).toFixed(3)}`);
}
console.log(`  TOTAL     n=${r.n}  r@3=${pct(r.recallAt3)}  r@${K}=${pct(r.recallAtK)}  MRR=${r.mrr.toFixed(3)}`);
console.log(`  ruído (vec <= mediana do pool): ${pct(r.noise)} dos hits`);
console.log(`  tokens/busca: brief ~${r.tokensBrief} | full ~${r.tokensFull}`);
console.log(`  latência média: ${r.latencyMs}ms`);
console.log(
  r.calibrated
    ? `  gate derivado: FORTE >= ${r.gate.strong?.toFixed(2) ?? 'inatingível'} (precision 0.8) | PISO >= ${r.gate.floor?.toFixed(2) ?? 'inatingível'} (precision 0.5)`
    : '  gate: calibração de score não pronta, confidence null',
);
if (r.misses.length) console.log(`  falhas: ${r.misses.join(', ')}`);
if (process.argv.includes('--verbose')) {
  for (const c of r.perCase) console.log(`  ${c.id} ${c.rank === null ? 'MISS' : `rank ${c.rank}`}`);
}

let sha = '-';
try {
  sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  // fora de repo git
}
const { perCase: _perCase, ...summary } = r;
appendFileSync(
  learningPaths.benchRecall,
  JSON.stringify({
    v: 1,
    ranAt: new Date().toISOString(),
    label: arg('label') ?? null,
    sha,
    tuning: tuningFile ?? null,
    excludeKinds: EXCLUDE,
    maxPerSession: MAX_PER_SESSION ?? 'default',
    k: K,
    ...summary,
  }) + '\n',
);
const isAB = !!tuningFile || EXCLUDE.length > 0 || MAX_PER_SESSION !== undefined || K !== 8;
if (!isAB && r.calibrated && r.gate.strong !== null && r.gate.floor !== null) {
  writeFileSync(
    learningPaths.benchGate,
    JSON.stringify(
      { v: 1, at: new Date().toISOString(), strong: r.gate.strong, floor: r.gate.floor, nHits: r.nHits, nCases: r.nCases },
      null,
      2,
    ),
  );
  console.log(`  gate publicado em ${learningPaths.benchGate}`);
}
await closeDriver();
