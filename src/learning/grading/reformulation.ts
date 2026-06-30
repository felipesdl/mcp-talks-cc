import { embed } from '../../embeddings/localEmbedder.ts';
import { dot } from './echo.ts';
import type { QueryLogEntry } from '../types.ts';

const REFORM_WINDOW_MS = 4 * 60 * 1000;
const QUERY_SIM_THRESHOLD = 0.8;

export interface ReformulationResult {
  reformulated: boolean | null; // null = sem busca posterior na janela (sem evidência)
}

/**
 * Sinal de reformulação: nova search_memory semanticamente parecida logo depois
 * → o retrieval anterior falhou. nResults==0 seguido de re-busca = negativo forte
 * (decidido sem embedding).
 */
export async function computeReformulation(
  entry: QueryLogEntry,
  laterEntries: QueryLogEntry[],
): Promise<ReformulationResult> {
  if (!entry.query) return { reformulated: null };
  const t = new Date(entry.ts).getTime();
  const followups = laterEntries.filter((e) => {
    if (e.tool !== 'search_memory' || !e.query || e.query === entry.query) return false;
    const dt = new Date(e.ts).getTime() - t;
    if (dt <= 0 || dt > REFORM_WINDOW_MS) return false;
    // mesma "conversa": mesmo projeto quando ambos declaram
    return !entry.project || !e.project || e.project === entry.project;
  });
  if (followups.length === 0) return { reformulated: null };

  if (entry.nResults === 0) return { reformulated: true };

  const [base, ...rest] = await embed([
    entry.query.trim(),
    ...followups.map((f) => f.query!.trim()),
  ]);
  const similar = rest.some((vec) => dot(base!, vec) >= QUERY_SIM_THRESHOLD);
  return { reformulated: similar ? true : null };
}
