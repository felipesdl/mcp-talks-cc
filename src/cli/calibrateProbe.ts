import { writeFileSync } from 'node:fs';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { searchMemory } from '../mcp/tools/searchMemory.ts';
import { stripWrappers } from '../ingest/quality.ts';
import { readQueryLog } from '../learning/queryLog.ts';
import { learningPaths } from '../learning/paths.ts';
import { mergedScoreCalibration, type ProbeSamples } from '../learning/scoreSamples.ts';

/**
 * Probe pra calibração de score.
 *
 * A CDF só vale se as queries do probe tiverem a mesma forma das reais. Medido
 * em 2026-09-29: usando falas humanas inteiras como query, o p50 de vec saiu
 * 0.912 contra 0.884 do tráfego real, porque pergunta colada se repete quase
 * idêntica entre sessões (prompt de subagente, pedido repetido) e o cosseno
 * dispara. Com 2000 amostras dessas contra 471 reais, toda confidence real
 * afundaria.
 *
 * Então, em ordem:
 *  1. REPLAY das queries reais distintas do query-log contra o corpus atual,
 *     sem a sessão chamadora (senão a conversa onde a busca nasceu ecoa). É a
 *     distribuição certa por definição.
 *  2. Só quando há menos de MIN_REPLAY queries reais (instalação nova):
 *     sintético curto, 8 primeiras palavras de falas humanas, que é o formato
 *     de busca que o modelo escreve. Hit com vec >= NEAR_DUP é descartado:
 *     é a mesma fala colada em outra sessão, não similaridade.
 *
 *   npm run calibrate:probe -- [--n=250]
 */

process.env.MCP_TALKS_DISABLE_QUERY_LOG = '1';

const nArg = process.argv.find((a) => a.startsWith('--n='));
const N = nArg ? Number(nArg.split('=')[1]) : 250;
const MIN_REPLAY = 50;
const NEAR_DUP = 0.97;

const { entries } = await readQueryLog(0);
const seen = new Set<string>();
const replay = entries.filter((e) => {
  if (e.tool !== 'search_memory' || !e.query) return false;
  const key = e.query.trim().toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

interface Probe {
  query: string;
  exclude: string[];
  synthetic: boolean;
}
let picks: Probe[] = replay.map((e) => ({
  query: e.query!,
  exclude: e.sessionId ? [e.sessionId] : [],
  synthetic: false,
}));

if (picks.length < MIN_REPLAY) {
  const pool = await withSession(async (s) => {
    const r = await s.run(`
      MATCH (c:Chunk { sourceKind: 'conversation', role: 'user' })
      WHERE size(c.text) >= 60 AND c.sessionId IS NOT NULL
      RETURN c.text AS text, c.sessionId AS sessionId
      ORDER BY c.id
    `);
    return r.records.map((rec) => ({
      words: stripWrappers(rec.get('text') as string).split(/\s+/).filter(Boolean),
      sessionId: rec.get('sessionId') as string,
    }));
  });
  const usable = pool.filter((p) => p.words.length >= 6);
  const step = Math.max(1, Math.floor(usable.length / N));
  picks = picks.concat(
    usable
      .filter((_, i) => i % step === 0)
      .slice(0, N - picks.length)
      .map((p) => ({ query: p.words.slice(0, 8).join(' '), exclude: [p.sessionId], synthetic: true })),
  );
}
console.error(`[probe] ${replay.length} queries reais pra replay, ${picks.filter((p) => p.synthetic).length} sintéticas`);

const vecScores: number[] = [];
const margins: number[] = [];
let done = 0;
for (const p of picks) {
  const r = await searchMemory({ query: p.query, k: 8, excludeSessions: p.exclude });
  for (const h of r.hits) {
    if (p.synthetic && h.vec_score >= NEAR_DUP) continue;
    vecScores.push(h.vec_score);
    if (r.poolVecMedian !== null) margins.push(h.vec_score - r.poolVecMedian);
  }
  if (++done % 25 === 0) console.error(`[probe] ${done}/${picks.length}`);
}

const probe: ProbeSamples = {
  v: 1,
  generatedAt: new Date().toISOString(),
  nQueries: picks.length,
  vecScores,
  margins,
};
writeFileSync(learningPaths.probeSamples, JSON.stringify(probe));

const cal = mergedScoreCalibration(entries, probe);
writeFileSync(learningPaths.scoreCalibration, JSON.stringify(cal, null, 2));
console.log(
  `[probe] ${vecScores.length} amostras de ${picks.length} queries | calibração: ready=${cal.ready} ` +
    `real=${cal.nReal} probe=${cal.nProbe} p50=${cal.percentiles.p50?.toFixed(3)} p90=${cal.percentiles.p90?.toFixed(3)}`,
);
await closeDriver();
