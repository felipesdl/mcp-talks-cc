import type { QueryLogEntry } from '../types.ts';

const DRILL_WINDOW_MS = 10 * 60 * 1000;

export interface DrillInResult {
  drillIn: boolean | null; // null = nenhum drill-in observado (ausência ≠ negativo)
  creditedHitIds: string[];
}

/**
 * Sinal de drill-in (o mais inequívoco): depois da busca, o caller abriu o
 * transcript de uma sessão dos hits, ou expandiu um chunk retornado.
 */
export function computeDrillIn(
  entry: QueryLogEntry,
  laterEntries: QueryLogEntry[],
): DrillInResult {
  if (entry.hits.length === 0) return { drillIn: null, creditedHitIds: [] };
  const t = new Date(entry.ts).getTime();
  const hitIds = new Set(entry.hits.map((h) => h.id));
  const hitSessions = new Set(entry.hits.map((h) => h.sessionId).filter(Boolean));

  const credited = new Set<string>();
  for (const e of laterEntries) {
    const dt = new Date(e.ts).getTime() - t;
    if (dt <= 0 || dt > DRILL_WINDOW_MS) continue;
    if (e.tool === 'get_session_transcript' && e.refSessionId && hitSessions.has(e.refSessionId)) {
      for (const h of entry.hits) if (h.sessionId === e.refSessionId) credited.add(h.id);
    }
    if (e.tool === 'find_similar_chunks' && e.refChunkId && hitIds.has(e.refChunkId)) {
      credited.add(e.refChunkId);
    }
  }
  return credited.size > 0
    ? { drillIn: true, creditedHitIds: [...credited] }
    : { drillIn: null, creditedHitIds: [] };
}
