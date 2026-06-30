import type { Session } from 'neo4j-driver';
import { embed } from '../../embeddings/localEmbedder.ts';
import type { EchoCalibration, QueryLogEntry } from '../types.ts';

/** Dot product — embeddings já normalizados (HF normalize: true), então dot == cosine. */
export function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

const ECHO_WINDOW_MS = 30 * 60 * 1000;
const MAX_ASSISTANT_MSGS = 6;

export interface EchoResult {
  echoRaw: number | null; // max cosine assistant×chunk; null se não computável
  perHit: Record<string, number>; // max cosine por chunk retornado
  joinMethod: 'session' | 'timeWindow';
  ambiguous: boolean; // 0 ou 2+ sessões candidatas no time-window join
  assistantTextChars: number;
}

/**
 * Sinal de echo: as respostas do assistant logo após a busca "ecoam" os chunks
 * retornados? Proxy de uso (na verdade mede relevância tópica — por isso a
 * calibração empírica em calibrateEcho/applyCalibration).
 */
export async function computeEcho(
  s: Session,
  entry: QueryLogEntry,
): Promise<EchoResult> {
  const none = (joinMethod: 'session' | 'timeWindow', ambiguous: boolean): EchoResult => ({
    echoRaw: null,
    perHit: {},
    joinMethod,
    ambiguous,
    assistantTextChars: 0,
  });

  if (entry.hits.length === 0) return none(entry.sessionId ? 'session' : 'timeWindow', false);

  // 1) resolve a sessão chamadora
  let sessionId = entry.sessionId;
  let joinMethod: 'session' | 'timeWindow' = 'session';
  if (!sessionId) {
    joinMethod = 'timeWindow';
    const r = await s.run(
      `MATCH (sess:Session)
       WHERE ($project IS NULL OR sess.projectPath = $project)
         AND sess.startedAt IS NOT NULL AND sess.startedAt <= $ts
         AND (sess.endedAt IS NULL OR sess.endedAt >= $ts)
       RETURN sess.id AS id LIMIT 3`,
      { project: entry.project, ts: entry.ts },
    );
    if (r.records.length !== 1) return none('timeWindow', true);
    sessionId = r.records[0]!.get('id') as string;
  }

  // 2) próximas mensagens assistant (timestamps ISO: comparação lexical == cronológica)
  const tsPlus = new Date(new Date(entry.ts).getTime() + ECHO_WINDOW_MS).toISOString();
  const msgRes = await s.run(
    `MATCH (sess:Session { id: $sid })-[:HAS_MESSAGE]->(m:Message)
     WHERE m.role = 'assistant' AND m.timestamp > $ts AND m.timestamp <= $tsPlus
     RETURN m.text AS text ORDER BY m.timestamp ASC LIMIT ${MAX_ASSISTANT_MSGS}`,
    { sid: sessionId, ts: entry.ts, tsPlus },
  );
  const texts = msgRes.records
    .map((rec) => (rec.get('text') as string) ?? '')
    .filter((t) => t.trim().length > 0);
  if (texts.length === 0) return none(joinMethod, false);

  // 3) embeddings dos chunks retornados (não guardamos no log; re-busca por id)
  const hitIds = entry.hits.map((h) => h.id);
  const chunkRes = await s.run(
    `UNWIND $ids AS id MATCH (c:Chunk { id: id }) RETURN c.id AS id, c.embedding AS embedding`,
    { ids: hitIds },
  );
  const chunkVecs = chunkRes.records.map((rec) => ({
    id: rec.get('id') as string,
    vec: rec.get('embedding') as number[],
  }));
  if (chunkVecs.length === 0) return none(joinMethod, false);

  const msgVecs = await embed(texts.map((t) => t.slice(0, 4000)));

  const perHit: Record<string, number> = {};
  let max = -1;
  for (const chunk of chunkVecs) {
    let chunkMax = -1;
    for (const mv of msgVecs) chunkMax = Math.max(chunkMax, dot(mv, chunk.vec));
    perHit[chunk.id] = chunkMax;
    max = Math.max(max, chunkMax);
  }

  return {
    echoRaw: max,
    perHit,
    joinMethod,
    ambiguous: false,
    assistantTextChars: texts.reduce((acc, t) => acc + t.length, 0),
  };
}

/**
 * Normaliza echoRaw p/ [0,1] usando a calibração empírica (floor=p40, ceil=p90
 * da distribuição real). Sem calibração pronta → null (peso 0 na utility).
 */
export function applyCalibration(
  echoRaw: number | null,
  cal: EchoCalibration | null,
): number | null {
  if (echoRaw === null || !cal?.ready || cal.ceil <= cal.floor) return null;
  return Math.min(1, Math.max(0, (echoRaw - cal.floor) / (cal.ceil - cal.floor)));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

/** Recomputa a calibração a partir de TODOS os echoRaw já observados. */
export function calibrateEcho(echoRaws: number[], minSamples: number): EchoCalibration {
  const sorted = [...echoRaws].sort((a, b) => a - b);
  const percentiles: Record<string, number> = {};
  for (const p of [10, 25, 40, 50, 75, 90, 95]) {
    percentiles[`p${p}`] = percentile(sorted, p);
  }
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    nSamples: sorted.length,
    ready: sorted.length >= minSamples,
    floor: percentiles.p40 ?? 0,
    ceil: percentiles.p90 ?? 1,
    percentiles,
  };
}
