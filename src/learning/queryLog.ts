import { appendFile, mkdir, rename, readFile, stat } from 'node:fs/promises';
import { learningPaths } from './paths.ts';
import { queryLogEntrySchema, type QueryLogEntry } from './types.ts';

const MAX_BYTES = 16 * 1024 * 1024;

let _rotating = false;

async function rotateIfNeeded(): Promise<void> {
  if (_rotating) return;
  const st = await stat(learningPaths.queryLog).catch(() => null);
  if (!st || st.size < MAX_BYTES) return;
  _rotating = true;
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    await rename(learningPaths.queryLog, `${learningPaths.queryLog.replace(/\.jsonl$/, '')}.${stamp}.jsonl`);
  } finally {
    _rotating = false;
  }
}

/**
 * Kill switch da instrumentação. Existe por causa da suite: cada `npm test`
 * dispara ~7 buscas sintéticas ('neo4j MCP', 'plano'), e elas entravam no mesmo
 * query-log que alimenta a calibração de score e as grades. Medido depois de um
 * reset de estado: 96 das 138 amostras de vec eram de teste (69%), o que
 * deslocou a mediana de 0.883 pra 0.8235. Calibração tem que refletir busca de
 * verdade, senão o gate de confidence sai calibrado contra tráfego fabricado.
 */
const DISABLED = process.env.MCP_TALKS_DISABLE_QUERY_LOG === '1';

/**
 * Append best-effort no query-log. Nunca lança — instrumentação não pode
 * quebrar o hot path da busca. Chamar com `void logQuery(...)`.
 */
export async function logQuery(entry: QueryLogEntry): Promise<void> {
  if (DISABLED) return;
  try {
    await mkdir(learningPaths.cacheDir, { recursive: true });
    await rotateIfNeeded();
    await appendFile(learningPaths.queryLog, JSON.stringify(entry) + '\n');
  } catch {
    // silencioso: log perdido < busca quebrada
  }
}

/** Lê o query-log a partir de uma linha (checkpoint do tuner). Pula linhas inválidas. */
export async function readQueryLog(fromLine = 0): Promise<{ entries: QueryLogEntry[]; totalLines: number }> {
  let raw: string;
  try {
    raw = await readFile(learningPaths.queryLog, 'utf8');
  } catch {
    return { entries: [], totalLines: 0 };
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const entries: QueryLogEntry[] = [];
  for (const line of lines.slice(fromLine)) {
    try {
      const parsed = queryLogEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data as QueryLogEntry);
    } catch {
      // linha corrompida (crash no meio do append) — ignora
    }
  }
  return { entries, totalLines: lines.length };
}
