import { availableParallelism } from 'node:os';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { config } from '../config.ts';
import { EmbeddingError } from '../domain/errors.ts';

/**
 * Sem limite o onnx usa todos os cores, e o ingest do hook (que roda sozinho a
 * cada SessionStart) travava a máquina, pior com pouca RAM caindo em swap. O
 * bge-m3 escala mal depois de ~4 threads (medido num M-series de 10 cores: 4
 * threads empata com 10), então em background metade dos cores custa ~nada.
 * Processo interativo (MCP server, npm run manual) segue no default do onnx.
 * EMBED_THREADS no .env vence os dois.
 */
function intraOpThreads(): number | undefined {
  if (config.embed.threads > 0) return config.embed.threads;
  if (process.env.MCP_TALKS_BG === '1') return Math.max(1, Math.floor(availableParallelism() / 2));
  return undefined;
}

let _extractor: FeatureExtractionPipeline | null = null;
let _loading: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Descarga por ociosidade. Cada sessão do Claude Code tem o próprio MCP server,
 * e o que carregou o modelo uma vez segurava ~0,5-1,3GB até a sessão fechar,
 * mesmo parada há dias. Só o server liga isto (ver server.ts); o ingest não,
 * porque embeda o tempo todo. O próximo embed() recarrega sozinho.
 */
let _idleMs = 0;
let _idleTimer: NodeJS.Timeout | undefined;
let _inflight = 0;

export function setEmbedderIdleUnload(ms: number): void {
  _idleMs = ms > 0 ? ms : 0;
  armIdle();
}

function armIdle(): void {
  clearTimeout(_idleTimer);
  if (!_idleMs || !_extractor) return;
  _idleTimer = setTimeout(unloadIfIdle, _idleMs);
  _idleTimer.unref();
}

function unloadIfIdle(): void {
  // embed em voo rearma no finally ao terminar
  if (_inflight > 0 || !_extractor) return;
  const ex = _extractor;
  _extractor = null;
  _loading = null;
  console.error(`[embed] idle ${Math.round(_idleMs / 60_000)}min, descarregando modelo`);
  void ex
    .dispose()
    .catch((e) => console.error('[embed] dispose falhou:', e))
    .finally(forceGc);
}

/**
 * Sem isto o dispose quase não devolve nada: o grosso do modelo vive atrás de
 * wrappers JS, e um server parado não aloca, então o V8 nunca roda o GC maior.
 * Medido no macOS (vmmap): alocado no malloc 1,5GB -> 23MB com GC. O footprint
 * pode seguir alto: as páginas livres ficam no allocator, que as reusa no
 * próximo load e as devolve sob pressão de memória.
 */
function forceGc(): void {
  let gc: () => void;
  try {
    setFlagsFromString('--expose-gc');
    gc = runInNewContext('gc') as () => void;
  } catch {
    return; // sem GC manual, o V8 coleta quando quiser
  }
  gc();
  // 2ª passada: os finalizers dos tensores nativos só rodam depois da 1ª
  setTimeout(gc, 1000).unref();
}

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (_extractor) return _extractor;
  // Memoize the in-flight load so an opt-in preload and the first tool call
  // share one pipeline instead of each loading their own ~1.5GB model.
  if (_loading) return _loading;
  _loading = (async () => {
    const t0 = Date.now();
    console.error(`[embed] loading model ${config.embed.model} (threads=${intraOpThreads() ?? 'auto'}) ...`);
    try {
      const threads = intraOpThreads();
      _extractor = await pipeline('feature-extraction', config.embed.model, {
        dtype: 'q8',
        ...(threads ? { session_options: { intraOpNumThreads: threads } } : {}),
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
  let arr: number[][];
  _inflight++;
  try {
    const ex = await getEmbedder();
    try {
      const out = await ex(texts, { pooling: 'mean', normalize: true });
      arr = out.tolist() as number[][];
    } catch (e) {
      throw new EmbeddingError(`Embedding inference failed (batch size=${texts.length})`, e);
    }
  } finally {
    _inflight--;
    armIdle();
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
