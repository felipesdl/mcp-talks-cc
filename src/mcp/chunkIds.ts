import type { Session } from 'neo4j-driver';

/**
 * Resolve ids de chunk (inteiros ou o prefixo curto da saída brief) pro id
 * completo. `STARTS WITH` usa o índice RANGE `chunk_id`.
 *
 * Prefixo menor que 8 hex é recusado: com ~55k chunks, 8 hex já tem colisão
 * desprezível, e abaixo disso um id truncado errado casaria chunk aleatório.
 * Prefixo ambíguo (2+ chunks) também é descartado, pelo mesmo motivo.
 */
export async function resolveChunkIds(s: Session, ids: string[]): Promise<string[]> {
  const wanted = [...new Set(ids.map((i) => i.trim().toLowerCase()).filter((i) => i.length >= 8))];
  if (wanted.length === 0) return [];
  const r = await s.run(
    `UNWIND $ids AS p
     MATCH (c:Chunk) WHERE c.id STARTS WITH p
     WITH p, collect(c.id)[..2] AS found
     WHERE size(found) = 1
     RETURN p, found[0] AS id`,
    { ids: wanted },
  );
  const byPrefix = new Map(r.records.map((rec) => [rec.get('p') as string, rec.get('id') as string]));
  return wanted.map((p) => byPrefix.get(p)).filter((v): v is string => v !== undefined);
}
