import { config } from '../config.ts';
import { embedBatched } from '../embeddings/localEmbedder.ts';
import { findReusableChunkIds } from './writer.ts';
import type { ChunkRecord } from './types.ts';

/**
 * Preenche `embedding` só dos chunks que ainda não estão no grafo com o mesmo
 * texto. Arquivo que mudou (sessão que cresceu, plan editado) é re-lido
 * inteiro, e sem isto cada SessionStart re-embedava a sessão toda: ~300 chunks,
 * ~75s de CPU cheia por sessão longa. Reaproveitado fica `null` e o writeChunks
 * mantém o vetor gravado (coalesce). `force` re-embeda tudo (troca de modelo).
 *
 * Devolve quantos chunks passaram pelo modelo.
 */
export async function embedChunks(chunks: ChunkRecord[], force = false): Promise<number> {
  if (chunks.length === 0) return 0;
  const reusable = force
    ? new Set<string>()
    : await findReusableChunkIds(
        chunks.map((c) => ({ id: c.id, text: c.text })),
        config.embed.dim,
      );
  const missing = chunks.filter((c) => !reusable.has(c.id));
  for (const c of chunks) if (reusable.has(c.id)) c.embedding = null;
  if (missing.length === 0) return 0;
  const vecs = await embedBatched(missing.map((c) => c.text));
  for (let j = 0; j < missing.length; j++) missing[j]!.embedding = vecs[j]!;
  return missing.length;
}
