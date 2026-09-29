import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { searchMemory } from '../mcp/tools/searchMemory.ts';
import { readQueryLog } from '../learning/queryLog.ts';
import { stripWrappers } from '../ingest/quality.ts';
import { taskKeysFromText } from '../ingest/entities.ts';

/**
 * Gera CANDIDATOS pro eval set de recall (~/.cache/mcp-talks-cc/recall-eval.jsonl, fora do repo:
 * é feito das suas queries e sessões reais).
 *
 * Não gera gabarito: gabarito é julgamento. Pra cada query real do query-log
 * lista as sessões que poderiam responder, com título (1ª fala humana), tasks e
 * data, pra alguém marcar quais respondem de fato.
 *
 * Os candidatos vêm de DUAS fontes pra não herdar o viés do ranker atual:
 * o top-20 diversificado do próprio search_memory e as sessões ligadas por
 * estrutura (task nomeada na query). Uma sessão certa que o ranker nunca traz
 * só entra no gabarito se alguma fonte independente apontar pra ela.
 *
 * Cada busca roda "no momento" da query original: `until` = ts da query e a
 * sessão chamadora excluída. Sem isso a própria conversa onde a busca nasceu,
 * que já contém a resposta, vira o candidato nº 1.
 */

process.env.MCP_TALKS_DISABLE_QUERY_LOG = '1';

interface Candidate {
  sessionId: string;
  title: string;
  tasks: string[];
  project: string | null;
  startedAt: string | null;
  bestRank: number | null;
  viaTask: boolean;
  gist: string;
}

const { entries } = await readQueryLog(0);
const seen = new Set<string>();
const queries = entries.filter((e) => {
  if (e.tool !== 'search_memory' || !e.query) return false;
  const key = e.query.trim().toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const out: unknown[] = [];
for (const e of queries) {
  const excl = e.sessionId ? [e.sessionId] : [];
  const { hits } = await searchMemory({
    query: e.query!,
    k: 20,
    diversity: 0.3,
    until: e.ts,
    excludeSessions: excl,
    ...(e.project ? { project: e.project } : {}),
  });

  const bySession = new Map<string, { rank: number; gist: string }>();
  hits.forEach((h, i) => {
    if (!h.sessionId || bySession.has(h.sessionId)) return;
    bySession.set(h.sessionId, { rank: i + 1, gist: stripWrappers(h.snippet).slice(0, 200) });
  });

  const keys = taskKeysFromText(e.query!);
  const candidates = await withSession(async (s) => {
    const viaTask = new Set<string>();
    if (keys.length > 0) {
      const r = await s.run(
        `MATCH (t:Task)<-[:ON_TASK]-(se:Session)
         WHERE t.key IN $keys AND NOT se.id IN $excl AND se.startedAt <= $until
         RETURN collect(DISTINCT se.id) AS ids`,
        { keys, excl, until: e.ts },
      );
      for (const id of (r.records[0]?.get('ids') as string[]) ?? []) viaTask.add(id);
    }
    const ids = [...new Set([...bySession.keys(), ...viaTask])];
    const meta = await s.run(
      `UNWIND $ids AS id
       MATCH (se:Session { id: id })
       OPTIONAL MATCH (se)-[:ON_TASK]->(t:Task)
       WITH se, collect(DISTINCT t.key) AS tasks
       OPTIONAL MATCH (se)-[:HAS_MESSAGE]->(m:Message { role: 'user' })
       WHERE NOT EXISTS { MATCH (m)-[:INVOKED]->() } AND m.text IS NOT NULL
       WITH se, tasks, m ORDER BY m.timestamp
       WITH se, tasks, collect(m.text)[..6] AS firsts
       RETURN se.id AS id, se.projectPath AS project, se.startedAt AS startedAt, tasks, firsts`,
      { ids },
    );
    return meta.records.map((rec): Candidate => {
      const id = rec.get('id') as string;
      const firsts = (rec.get('firsts') as string[]).map(stripWrappers).filter((t) => t.length > 0);
      return {
        sessionId: id,
        title: (firsts[0] ?? '').slice(0, 220),
        tasks: rec.get('tasks') as string[],
        project: rec.get('project'),
        startedAt: rec.get('startedAt'),
        bestRank: bySession.get(id)?.rank ?? null,
        viaTask: viaTask.has(id),
        gist: bySession.get(id)?.gist ?? '',
      };
    });
  });

  candidates.sort((a, b) => (a.bestRank ?? 99) - (b.bestRank ?? 99));
  out.push({
    query: e.query,
    ts: e.ts,
    callerSession: e.sessionId,
    callerProject: e.callerProject ?? null,
    project: e.project,
    candidates,
  });
  console.error(`[eval] ${out.length}/${queries.length} ${e.query!.slice(0, 60)} → ${candidates.length} candidatas`);
}

const file = join(config.paths.cacheDir, 'eval-candidates.json'); // gabarito final: recall-eval.jsonl no mesmo dir, fora do repo
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`gravado em ${file} (${out.length} queries)`);
await closeDriver();
