import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient } from './helpers.ts';

interface Hit {
  id: string;
  score: number;
  sessionId: string | null;
}

interface SearchResult {
  structuredContent: { hits: Hit[] };
}

/**
 * `diversity` é o lambda do MMR: `lambda * relevância - (1 - lambda) * maxSim`.
 * Lambda baixo pesa o termo de diversidade; lambda alto vira quase só relevância.
 *
 * A versão anterior media UMA query (`neo4j`) e exigia a desigualdade nela. Isso
 * não é propriedade do MMR: com k=5 sobre um acervo que cresce, o top-5 por
 * relevância pura pode cair naturalmente em mais sessões do que a seleção
 * diversificada. Medido em 2026-09-22 sobre as 8 queries abaixo, o agregado deu
 * 29 contra 22, com 7 de 8 satisfazendo individualmente e `migration laravel`
 * invertendo (4 vs 5). O próprio `neo4j` empatou em 2 vs 2 depois de o acervo ir
 * de 52.092 para 52.115 chunks, tendo falhado como 2 vs 3 poucas horas antes.
 *
 * Por isso a asserção é sobre o agregado, que é onde o efeito é real e estável.
 */
const QUERIES = [
  'neo4j',
  'contrato de frete',
  'feature flag no painel',
  'busca vetorial e embedding',
  'teste de pátio',
  'extensão de contrato',
  'migration laravel',
  'revisão de PR',
];

describe('MMR diversity behavior', () => {
  let client: Client;

  before(async () => {
    client = await createTestClient();
  });

  after(async () => {
    await client.close();
  });

  it('lambda baixo espalha por mais sessões que lambda alto, no agregado', async () => {
    const uniqueSessions = async (query: string, diversity: number): Promise<number> => {
      const r = (await client.callTool({
        name: 'search_memory',
        arguments: { query, k: 5, diversity },
      })) as unknown as SearchResult;
      return new Set(r.structuredContent.hits.map((h) => h.sessionId)).size;
    };

    let diverse = 0;
    let relevant = 0;
    const perQuery: string[] = [];

    for (const q of QUERIES) {
      const d = await uniqueSessions(q, 0.3);
      const r = await uniqueSessions(q, 0.95);
      diverse += d;
      relevant += r;
      perQuery.push(`  ${d} vs ${r}  ${q}`);
    }

    assert.ok(
      diverse > relevant,
      `diversidade deveria espalhar mais no agregado: ${diverse} vs ${relevant}\n${perQuery.join('\n')}`,
    );
  });
});
