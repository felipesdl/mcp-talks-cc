import type { Session } from 'neo4j-driver';

/**
 * Rótulo de valor derivado da POSIÇÃO NO TURNO, sem modelo e sem custo.
 *
 * A ideia: o assistente fala várias vezes seguidas enquanto trabalha, e só a
 * última fala antes de o humano responder é a entrega. As anteriores são
 * anúncio ("vou verificar X", "subindo o Neo4j enquanto escrevo").
 *
 * O discriminador que torna isso possível é que resultado de ferramenta chega
 * como mensagem de papel `user` COM aresta INVOKED, enquanto fala humana de
 * verdade é `user` SEM INVOKED. Sem essa distinção, todo resultado de
 * ferramenta pareceria um turno humano e o rótulo viraria ruído.
 *
 * Duas abordagens foram medidas e reprovadas antes desta (22/09/2026):
 *  - protótipos sobre o embedding: margem mediana 0,018, nível de ruído, porque
 *    o bge-m3 codifica ASSUNTO e não tipo de afirmação;
 *  - caminhar a cadeia `REPLIES_TO`: só 4,9% dos turnos humanos alcançam uma
 *    fala do assistente, porque as mensagens intermediárias foram filtradas no
 *    ingest e a corrente perde o elo.
 *
 * Esta usa apenas `timestamp` + `sessionId`, que existem em toda mensagem, e
 * cobre 75% dos turnos humanos em 554ms sobre o acervo inteiro.
 */

/** Quantas falas do assistente olhar para trás a partir de um turno humano. */
const LOOKBACK = 12;

export type ValueLabel = 'entrega' | 'provisorio';

export interface LabelSet {
  /** uuid da Message do assistente que fechou um turno humano. */
  entrega: Set<string>;
  /** uuid da Message do assistente que tem chunk mas não fechou turno. */
  provisorio: Set<string>;
}

/**
 * Uuids das mensagens do assistente que fecham turno.
 *
 * O `collect` monta a sequência temporal da sessão uma vez; o `range` para trás
 * acha a fala com chunk mais próxima antes de cada turno humano. Feito em
 * Cypher e não no cliente para não trafegar 159 mil mensagens.
 */
async function deliveryUuids(s: Session): Promise<Set<string>> {
  const res = await s.run(`
    MATCH (se:Session)-[:HAS_MESSAGE]->(m:Message)
    WHERE m.timestamp IS NOT NULL
    WITH se, m ORDER BY se.id, m.timestamp
    WITH se, collect({
      u:  m.uuid,
      r:  m.role,
      inv: EXISTS { MATCH (m)-[:INVOKED]->() },
      ch:  EXISTS { MATCH (m)-[:HAS_CHUNK]->() }
    }) AS seq
    UNWIND range(0, size(seq) - 1) AS i
    WITH seq, i, seq[i] AS cur
    WHERE cur.r = 'user' AND cur.inv = false
    WITH [j IN range(i - 1, CASE WHEN i - $lookback < 0 THEN 0 ELSE i - $lookback END, -1)
            WHERE seq[j].r = 'assistant' AND seq[j].ch = true | seq[j].u] AS antes
    WHERE size(antes) > 0
    RETURN DISTINCT head(antes) AS uuid
  `, { lookback: LOOKBACK });
  return new Set(res.records.map((r) => r.get('uuid') as string));
}

/**
 * Conjunto de rótulos sobre as mensagens do assistente que têm chunk.
 *
 * Fala do usuário fica DE FORA de propósito: pedido e restrição são curtos e
 * imperativos, sintaticamente iguais a anúncio, e são 18,5 mil chunks. Tratá-los
 * pelo mesmo modelo rebaixaria mais de um terço do acervo por acidente.
 */
export async function buildLabels(s: Session): Promise<LabelSet> {
  const entrega = await deliveryUuids(s);

  const all = await s.run(`
    MATCH (m:Message { role: 'assistant' })-[:HAS_CHUNK]->(:Chunk)
    RETURN DISTINCT m.uuid AS uuid
  `);

  const provisorio = new Set<string>();
  for (const rec of all.records) {
    const uuid = rec.get('uuid') as string;
    if (!entrega.has(uuid)) provisorio.add(uuid);
  }
  return { entrega, provisorio };
}
