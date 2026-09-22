import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { withSession, closeDriver } from '../../src/neo4j/driver.ts';
import { taskTargets, sampleTargets, measureRecall } from '../../src/classify/taskRecall.ts';

// As buscas deste teste NÃO podem entrar no query-log: ele alimenta a CDF de
// vec_score que o self-tune usa pra calibrar `confidence`, e dezenas de buscas
// sintéticas envenenariam a calibração inteira.
process.env.MCP_TALKS_DISABLE_QUERY_LOG = '1';

/**
 * Invariante populacional, não fixture de casos.
 *
 * A população é toda sessão cuja `gitBranch` carrega um código de task, e
 * cresce sozinha conforme o trabalho acontece. O rótulo mora no grafo, não nos
 * arquivos de transcript, então não decai com a poda de 90 dias: 373 das 609
 * sessões já não existem em disco e continuam valendo aqui.
 *
 * Linha de base medida em 22/09/2026 sobre a população inteira (148 tasks):
 *
 *   antes do nó de Task : hitRate@8 81,1%  MRR 0,667  narração@8 20,2%
 *   depois              : hitRate@8 99,3%  MRR 0,976  narração@8  8,3%
 *
 * A única falha restante (US-372) não é defeito: a busca devolve conteúdo da
 * task vindo de três OUTRAS sessões que também trabalharam nela, e o que o
 * invariante cobra é justamente a sessão cuja branch carrega o código. É
 * limitação da métrica, e afrouxá-la para fechar 100% seria fabricar sucesso.
 */
const BASELINE = 0.99;
/** Folga para jitter de MMR e do decay de recência, que mudam com o relógio. */
const TOLERANCE = 0.05;
/** Amostra determinística por passo: reprodutível sem semente. */
const ONE_IN = 9;

describe('invariante de recuperação por task', () => {
  after(async () => {
    await closeDriver();
  });

  it('buscar o código da task devolve a sessão daquela task', async () => {
    const all = await withSession((s) => taskTargets(s));
    assert.ok(all.length > 50, `população pequena demais (${all.length}) — o backfill de entidades rodou?`);

    const sample = sampleTargets(all, ONE_IN);
    const r = await measureRecall(sample);

    assert.ok(
      r.hitRate >= BASELINE - TOLERANCE,
      `hitRate ${(r.hitRate * 100).toFixed(1)}% caiu abaixo de ${((BASELINE - TOLERANCE) * 100).toFixed(0)}% ` +
        `(amostra de ${r.n}); falhas: ${r.misses.join(', ')}`,
    );
  });
});
