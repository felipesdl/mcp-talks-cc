import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasLiteralTokens, TERM_TOKEN_RE } from '../../src/mcp/tools/searchMemory.ts';

// Regressão: com regex frouxo (qualquer palavra de 5+ letras) o BM25 liga em
// toda query em prosa e infla o score de todo hit topo.
describe('hasLiteralTokens (gate do BM25)', () => {
  const prosa = [
    'como foi que decidimos tratar o cache de busca',
    'qual era a abordagem pra migrar aquela tela antiga',
    'resumo das decisoes sobre memoria e contexto',
    'porque a gente parou de usar aquele padrao',
  ];
  for (const q of prosa) {
    it(`prosa não liga hybrid: "${q}"`, () => {
      assert.equal(hasLiteralTokens(q), false);
    });
  }

  const literais = [
    'EDC-2410 status',
    'onde fica src/mcp/tools/searchMemory.ts',
    'o useEffect que dispara duas vezes',
    'campo created_at na migration',
    'constante MAX_GRADES_PER_RUN',
    'subir pro neo4j 5.26',
    'como configurar o MCP local',
  ];
  for (const q of literais) {
    it(`token literal liga hybrid: "${q}"`, () => {
      assert.equal(hasLiteralTokens(q), true);
    });
  }

  it('é estável entre chamadas (lastIndex resetado)', () => {
    const q = 'EDC-1234';
    assert.equal(hasLiteralTokens(q), true);
    assert.equal(hasLiteralTokens(q), true);
    assert.equal(hasLiteralTokens(q), true);
  });
});

describe('TERM_TOKEN_RE (vocabulário do profile)', () => {
  it('extrai palavra comum, que o gate do BM25 ignora', () => {
    const q = 'contrato de motorista no painel';
    TERM_TOKEN_RE.lastIndex = 0;
    const toks = [...q.matchAll(TERM_TOKEN_RE)].map((m) => m[0]);
    assert.deepEqual(toks, ['contrato', 'motorista', 'painel']);
    assert.equal(hasLiteralTokens(q), false);
  });
});
