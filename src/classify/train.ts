import { createHash } from 'node:crypto';
import type { Session } from 'neo4j-driver';
import { config } from '../config.ts';
import { buildLabels } from './labeler.ts';

/**
 * Regressão logística sobre o embedding QUE JÁ ESTÁ GRAVADO no Chunk.
 *
 * Nada é reembedado: o vetor de 1024 dimensões vem do grafo como está. Isso é o
 * que faz a fase inteira custar minutos em vez das 3,2h medidas para reembedar
 * os 49 mil chunks de conversa.
 *
 * Por que um classificador treinado e não distância a protótipos: medido em
 * 22/09/2026, protótipo por proximidade deu margem mediana de 0,018, nível de
 * ruído. O bge-m3 comprime cosseno em 0,82-0,91 e codifica ASSUNTO, então dois
 * textos sobre Docker caem perto um do outro seja um decisão ou anúncio. A
 * regressão aprende a direção discriminante e o deslocamento, que é justamente
 * o que a distância não consegue achar nessa nuvem.
 */

/** Fração de sessões reservadas para o conjunto retido. */
const HOLDOUT_FRACTION = 0.2;
const EPOCHS = Number(process.env.VALUE_EPOCHS ?? 400);
const LEARNING_RATE = Number(process.env.VALUE_LR ?? 3);
/** L2 sobre 1024 dimensões e ~25 mil exemplos. */
const L2 = Number(process.env.VALUE_L2 ?? 0);

export interface ValueModel {
  v: 1;
  model: string;
  dim: number;
  labelerVersion: string;
  /**
   * Média do corpus, subtraída antes de pontuar. O bge-m3 é anisotrópico: todos
   * os vetores compartilham uma direção comum grande, que domina o gradiente e
   * deixa o problema mal condicionado (medido: com LR 0,5 a loss quase não se
   * move; com LR 8 ela sobe). Centrar remove essa direção comum e é o que torna
   * a fronteira aprendível. Ingest e backfill precisam usar ESTA média.
   */
  mu: number[];
  /** Pesos e viés da fronteira. score = sigmoid(w·x + b) = P(entrega). */
  w: number[];
  b: number;
  trainedAt: string;
  metrics: Metrics;
}

export interface Metrics {
  /** P(entrega) de cada exemplo do retido, com o rótulo, para escolher o corte. */
  holdoutScores?: { p: number; y: 0 | 1 }[];
  nTrain: number;
  nHoldout: number;
  baseRate: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
}

interface Example {
  vec: Float32Array;
  y: 0 | 1;
  sessionId: string;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * Split por SESSÃO, nunca por chunk.
 *
 * O chunker aplica 150 chars de overlap, então pedaços vizinhos da mesma
 * mensagem são quase duplicados. Dividir por chunk colocaria um pedaço no
 * treino e o vizinho no retido, e a acurácia mediria memorização, não
 * generalização. Hash do sessionId mantém o split estável entre execuções.
 */
function isHoldout(sessionId: string): boolean {
  const h = createHash('sha1').update(sessionId).digest();
  return (h[0]! / 256) < HOLDOUT_FRACTION;
}

async function loadExamples(s: Session): Promise<Example[]> {
  const labels = await buildLabels(s);
  console.error(
    `[train] rótulos: ${labels.entrega.size} entrega, ${labels.provisorio.size} provisório (mensagens)`,
  );

  const res = await s.run(`
    MATCH (m:Message { role: 'assistant' })-[:HAS_CHUNK]->(c:Chunk)
    WHERE c.sourceKind = 'conversation' AND c.embedding IS NOT NULL
    RETURN m.uuid AS uuid, c.embedding AS embedding, c.sessionId AS sessionId
  `);

  const out: Example[] = [];
  for (const rec of res.records) {
    const uuid = rec.get('uuid') as string;
    const y: 0 | 1 = labels.entrega.has(uuid) ? 1 : labels.provisorio.has(uuid) ? 0 : -1 as 0 | 1;
    if ((y as number) === -1) continue;
    out.push({
      vec: Float32Array.from(rec.get('embedding') as number[]),
      y,
      sessionId: (rec.get('sessionId') as string) ?? '',
    });
  }
  return out;
}

function evaluate(w: Float64Array, b: number, set: Example[]): Metrics {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const e of set) {
    let z = b;
    for (let i = 0; i < w.length; i++) z += w[i]! * e.vec[i]!;
    const pred = sigmoid(z) >= 0.5 ? 1 : 0;
    if (pred === 1 && e.y === 1) tp++;
    else if (pred === 1 && e.y === 0) fp++;
    else if (pred === 0 && e.y === 0) tn++;
    else fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return {
    nTrain: 0,
    nHoldout: set.length,
    baseRate: set.length > 0 ? set.filter((e) => e.y === 1).length / set.length : 0,
    accuracy: set.length > 0 ? (tp + tn) / set.length : 0,
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    confusion: { tp, fp, tn, fn },
    holdoutScores: set.map((e) => {
      let z = b;
      for (let i = 0; i < w.length; i++) z += w[i]! * e.vec[i]!;
      return { p: sigmoid(z), y: e.y };
    }),
  };
}

export async function trainValueModel(s: Session): Promise<ValueModel> {
  const all = await loadExamples(s);
  const train = all.filter((e) => !isHoldout(e.sessionId));
  const holdout = all.filter((e) => isHoldout(e.sessionId));
  console.error(
    `[train] exemplos: ${all.length} (treino ${train.length}, retido ${holdout.length})`,
  );
  if (train.length === 0 || holdout.length === 0) {
    throw new Error('conjunto vazio — verifique se o backfill de role rodou');
  }

  const dim = train[0]!.vec.length;

  // Centraliza pela média do TREINO (nunca do retido, senão vaza informação).
  const mu = new Float64Array(dim);
  for (const e of train) for (let i = 0; i < dim; i++) mu[i]! += e.vec[i]!;
  for (let i = 0; i < dim; i++) mu[i]! /= train.length;
  for (const e of all) for (let i = 0; i < dim; i++) e.vec[i] = e.vec[i]! - mu[i]!;

  const w = new Float64Array(dim);
  let b = 0;

  // Classe positiva (entrega) é minoritária; sem peso o modelo aprende a
  // responder sempre "provisório" e acerta a taxa base sem separar nada.
  const pos = train.filter((e) => e.y === 1).length;
  const neg = train.length - pos;
  const wPos = neg / Math.max(pos, 1);

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const gw = new Float64Array(dim);
    let gb = 0;
    let loss = 0;
    for (const e of train) {
      let z = b;
      for (let i = 0; i < dim; i++) z += w[i]! * e.vec[i]!;
      const p = sigmoid(z);
      const weight = e.y === 1 ? wPos : 1;
      const err = (p - e.y) * weight;
      for (let i = 0; i < dim; i++) gw[i]! += err * e.vec[i]!;
      gb += err;
      loss += weight * -(e.y * Math.log(p + 1e-12) + (1 - e.y) * Math.log(1 - p + 1e-12));
    }
    const scale = LEARNING_RATE / train.length;
    for (let i = 0; i < dim; i++) w[i] = w[i]! - scale * gw[i]! - LEARNING_RATE * L2 * w[i]!;
    b -= scale * gb;
    if (epoch % 50 === 0 || epoch === EPOCHS - 1) {
      console.error(`[train] época ${epoch} loss=${(loss / train.length).toFixed(4)}`);
    }
  }

  const metrics = evaluate(w, b, holdout);
  metrics.nTrain = train.length;

  return {
    v: 1,
    model: config.embed.model,
    dim,
    labelerVersion: 'turn-order-v1',
    mu: Array.from(mu),
    w: Array.from(w),
    b,
    trainedAt: new Date().toISOString(),
    metrics,
  };
}

/** Probabilidade de o chunk ser entrega, dado o embedding já gravado. */
export function scoreVector(model: ValueModel, vec: number[]): number {
  let z = model.b;
  for (let i = 0; i < model.w.length; i++) z += model.w[i]! * (vec[i]! - model.mu[i]!);
  return sigmoid(z);
}
