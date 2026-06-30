import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { config } from '../config.ts';
import { EmbeddingError } from '../domain/errors.ts';

let _extractor: FeatureExtractionPipeline | null = null;
let _loading: Promise<FeatureExtractionPipeline> | null = null;

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (_extractor) return _extractor;
  // Memoize the in-flight load so a background preload and the first tool call
  // share one pipeline instead of each loading their own ~1.5GB model.
  if (_loading) return _loading;
  _loading = (async () => {
    const t0 = Date.now();
    console.error(`[embed] loading model ${config.embed.model} ...`);
    try {
      _extractor = await pipeline('feature-extraction', config.embed.model, {
        dtype: 'q8',
      });
    } catch (e) {
      _loading = null;
      throw new EmbeddingError(`Failed to load embedding model ${config.embed.model}`, e);
    }
    console.error(`[embed] model ready in ${Date.now() - t0}ms`);
    return _extractor;
  })();
  return _loading;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ex = await getEmbedder();
  let arr: number[][];
  try {
    const out = await ex(texts, { pooling: 'mean', normalize: true });
    arr = out.tolist() as number[][];
  } catch (e) {
    throw new EmbeddingError(`Embedding inference failed (batch size=${texts.length})`, e);
  }
  if (arr[0]?.length !== config.embed.dim) {
    throw new EmbeddingError(
      `Embedding dim mismatch: got ${arr[0]?.length}, expected ${config.embed.dim}. ` +
        `Update EMBED_DIM in .env or change EMBED_MODEL.`,
    );
  }
  return arr;
}

export async function embedBatched(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += config.embed.batchSize) {
    const slice = texts.slice(i, i + config.embed.batchSize);
    const vecs = await embed(slice);
    out.push(...vecs);
  }
  return out;
}
