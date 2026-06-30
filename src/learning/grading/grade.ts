import type { Session } from 'neo4j-driver';
import { applyCalibration, computeEcho } from './echo.ts';
import { computeReformulation } from './reformulation.ts';
import { computeDrillIn } from './drillIn.ts';
import type { EchoCalibration, Grade, GradeSignals, QueryLogEntry } from '../types.ts';

// drill > echo: drill-in é uso inequívoco, echo é proxy de relevância tópica
const W = { drill: 0.45, echo: 0.35, reform: 0.2 } as const;

export interface CombineInput {
  signals: GradeSignals;
  joinMethod: 'session' | 'timeWindow';
  ambiguous: boolean;
  assistantTextChars: number;
  nHits: number;
  queryTokens: number;
}

/** Combinação pura (testável sem grafo): utility confidence-weighted. */
export function combineSignals(input: CombineInput): { utility: number; confidence: number } {
  const { signals } = input;

  // falha inequívoca: busca sem resultados
  if (signals.zeroHit) return { utility: 0, confidence: 1 };

  // evidência positiva-apenas: ausência de drill-in/reformulação não penaliza
  const present: Array<{ w: number; value: number }> = [];
  if (signals.echoCalibrated !== null) present.push({ w: W.echo, value: signals.echoCalibrated });
  if (signals.drillIn === true) present.push({ w: W.drill, value: 1 });
  if (signals.reformulated === true) present.push({ w: W.reform, value: 0 });

  if (present.length === 0) {
    // sem nenhum sinal: neutro com confidence quase nula (não move agregados)
    return { utility: 0.5, confidence: 0.05 };
  }

  const wSum = present.reduce((acc, p) => acc + p.w, 0);
  const utility = present.reduce((acc, p) => acc + p.w * p.value, 0) / wSum;

  let confidence = input.joinMethod === 'session' ? 0.9 : 0.6;
  if (input.ambiguous) confidence -= 0.3;
  if (input.assistantTextChars > 0 && input.assistantTextChars < 200) confidence -= 0.2;
  if (input.nHits === 1) confidence -= 0.1;
  if (input.queryTokens < 4) confidence -= 0.1;
  if (signals.echoCalibrated === null && signals.echoRaw !== null) confidence -= 0.1; // echo coletado mas ainda não calibrado
  if (present.length >= 2) confidence += 0.1; // sinais múltiplos concordando

  return { utility, confidence: Math.min(1, Math.max(0.05, confidence)) };
}

/** Grada uma entrada search_memory do query-log usando grafo + embedder local. */
export async function gradeEntry(
  s: Session,
  entry: QueryLogEntry,
  laterEntries: QueryLogEntry[],
  calibration: EchoCalibration | null,
): Promise<Grade> {
  const zeroHit = entry.nResults === 0;

  const echo = zeroHit
    ? { echoRaw: null, perHit: {}, joinMethod: (entry.sessionId ? 'session' : 'timeWindow') as const, ambiguous: false, assistantTextChars: 0 }
    : await computeEcho(s, entry);
  const reform = await computeReformulation(entry, laterEntries);
  const drill = computeDrillIn(entry, laterEntries);

  const signals: GradeSignals = {
    echoRaw: echo.echoRaw,
    echoCalibrated: applyCalibration(echo.echoRaw, calibration),
    reformulated: reform.reformulated,
    drillIn: drill.drillIn,
    zeroHit,
  };

  const { utility, confidence } = combineSignals({
    signals,
    joinMethod: echo.joinMethod,
    ambiguous: echo.ambiguous,
    assistantTextChars: echo.assistantTextChars,
    nHits: entry.hits.length,
    queryTokens: entry.query ? entry.query.trim().split(/\s+/).length : 0,
  });

  // crédito por hit: drill-in dá crédito total ao hit específico;
  // os demais herdam o echo calibrado do próprio chunk
  const drillSet = new Set(drill.creditedHitIds);
  const hitCredits = entry.hits.map((h) => ({
    id: h.id,
    credit: drillSet.has(h.id)
      ? 1
      : (applyCalibration(echo.perHit[h.id] ?? null, calibration) ?? 0),
  }));

  return {
    v: 1,
    ts: new Date().toISOString(),
    queryTs: entry.ts,
    utility,
    confidence,
    signals,
    joinMethod: echo.joinMethod,
    hitCredits,
  };
}
