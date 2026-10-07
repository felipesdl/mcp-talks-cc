import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { trainValueModel } from '../classify/train.ts';

const out = join(config.paths.cacheDir, 'value-model.json');
const apply = process.argv.includes('--apply');
// --strict: modo do hook. Grafo pequeno (instalação nova) treina modelo que não
// separa nada, e gravar isso rebaixaria chunk ao acaso. Sem os mínimos, sai 1
// sem gravar e o hook tenta de novo quando o acervo crescer.
const strict = process.argv.includes('--strict');
const STRICT_MIN_HOLDOUT = 500;
const STRICT_MIN_GAIN = 0.05;

const model = await withSession((s) => trainValueModel(s));
const m = model.metrics;

console.log('\n### conjunto retido (sessões que o treino nunca viu)');
console.log(`  exemplos      : ${m.nHoldout}  (treino: ${m.nTrain})`);
console.log(`  taxa base     : ${(m.baseRate * 100).toFixed(1)}%  <- acurácia de quem chuta sempre a classe maior`);
console.log(`  acurácia      : ${(m.accuracy * 100).toFixed(1)}%`);
console.log(`  precisão      : ${(m.precision * 100).toFixed(1)}%`);
console.log(`  recall        : ${(m.recall * 100).toFixed(1)}%`);
console.log(`  F1            : ${(m.f1 * 100).toFixed(1)}%`);
console.log(`  confusão      : tp=${m.confusion.tp} fp=${m.confusion.fp} tn=${m.confusion.tn} fn=${m.confusion.fn}`);

const ganho = m.accuracy - Math.max(m.baseRate, 1 - m.baseRate);
console.log(`\n  ganho sobre chutar a classe maior: ${(ganho * 100).toFixed(1)} pontos`);
if (ganho < 0.05) {
  console.log('  ATENÇÃO: ganho abaixo de 5 pontos. O método não está separando.');
}

const sc = m.holdoutScores ?? [];
if (sc.length > 0) {
  console.log('\n### onde cortar para REBAIXAR (previsto narração = p abaixo do limiar)');
  console.log('  limiar | rebaixados | acerto | dos quais eram entrega de verdade');
  for (const t of [0.10, 0.20, 0.30, 0.40, 0.50]) {
    const sel = sc.filter((x) => x.p < t);
    const errados = sel.filter((x) => x.y === 1).length;
    const acerto = sel.length > 0 ? 1 - errados / sel.length : 0;
    console.log(
      `   ${t.toFixed(2)}  | ${String(sel.length).padStart(5)} (${((sel.length / sc.length) * 100).toFixed(0).padStart(2)}%) | ${(acerto * 100).toFixed(1)}% | ${errados}`,
    );
  }
}

if (strict && (m.nHoldout < STRICT_MIN_HOLDOUT || ganho < STRICT_MIN_GAIN)) {
  console.log(
    `\n(--strict: modelo NÃO gravado; precisa de ${STRICT_MIN_HOLDOUT}+ exemplos retidos e ganho >= ${STRICT_MIN_GAIN * 100} pontos)`,
  );
  await closeDriver();
  process.exit(1);
}

if (apply) {
  writeFileSync(out, JSON.stringify({ ...model, metrics: { ...model.metrics, holdoutScores: undefined } }));
  console.log(`\nmodelo gravado em ${out}`);
} else {
  console.log('\n(dry-run: modelo NÃO gravado; use --apply)');
}

await closeDriver();
