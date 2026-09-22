import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFulltextQuery } from '../../src/mcp/tools/searchMemory.ts';

/**
 * Regressão do caso EDC-3197 (2026-09-22).
 *
 * A busca por `EDC-3197` não devolvia nenhum chunk da sessão que implementou a
 * própria EDC-3197, apesar de os 270 chunks dela estarem indexados e com
 * embedding. Três causas somadas, cobertas aqui e em mmr/searchMemory:
 *
 *  1. o escape antigo transformava `EDC-3197` em `EDC` OR `3197`, casando o
 *     pool inteiro (500 chunks) em vez dos 15 reais;
 *  2. a fusão `0.7*vec + 0.3*bm25` PUNIA quem casava lexicalmente, porque as
 *     duas escalas não são comensuráveis;
 *  3. o pool de candidatos era só vetorial, então hit exclusivo do BM25 era
 *     calculado e descartado.
 */
describe('buildFulltextQuery (precisão do token literal)', () => {
  it('vira frase exata, que é o que impede o analyzer de quebrar no hífen', () => {
    assert.equal(buildFulltextQuery('EDC-3197'), '"EDC-3197"');
  });

  it('extrai o token literal de dentro da prosa e descarta o resto', () => {
    assert.equal(
      buildFulltextQuery('o que a gente decidiu na EDC-3197 sobre a fila'),
      '"EDC-3197"',
    );
  });

  it('junta múltiplos literais com OR, cada um como frase', () => {
    const q = buildFulltextQuery('EDC-3197 mexeu no useEffect de searchMemory.ts');
    assert.ok(q !== null);
    for (const t of ['"EDC-3197"', '"useEffect"', '"searchMemory.ts"']) {
      assert.ok(q.includes(t), `faltou ${t} em ${q}`);
    }
    assert.ok(q.includes(' OR '));
  });

  it('não repete token duplicado', () => {
    const q = buildFulltextQuery('EDC-3197 e de novo EDC-3197');
    assert.equal(q, '"EDC-3197"');
  });

  it('prosa pura não gera query lexical nenhuma', () => {
    assert.equal(buildFulltextQuery('como foi que decidimos tratar aquilo'), null);
  });

  it('escapa aspas e barra invertida pra não quebrar a sintaxe Lucene', () => {
    const q = buildFulltextQuery('arquivo a"b.ts');
    assert.ok(q !== null);
    assert.ok(!/(^|[^\\])"/.test(q.slice(1, -1)), `aspas não escapada em ${q}`);
  });
});
