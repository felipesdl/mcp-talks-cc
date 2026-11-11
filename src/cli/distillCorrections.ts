import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { embed } from '../embeddings/localEmbedder.ts';
import { HEADLESS_MODEL } from '../distill/headless.ts';
import {
  dedupeByText,
  extractImpliedRules,
  groupRules,
  judgeCoverage,
  loadCorrections,
  loadSkillChunks,
  topSkillChunks,
} from '../distill/corrections.ts';
import type { RuleGroup } from '../distill/corrections.ts';

/**
 * Correção repetida -> regra (Decision source='correction') + cobertura por skill.
 *
 *   npm run distill:corrections              # mostra grupos e cobertura, não grava no grafo
 *   npm run distill:corrections -- --apply   # grava
 *
 * Usa Haiku (claude -p) nas 3 etapas; a extração por correção fica em cache
 * (CACHE_DIR/correction-rules.json), então só correção nova custa chamada. O
 * agrupamento só roda de novo quando o conjunto de regras muda.
 */

const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
const apply = values.apply as boolean;
const CACHE_FILE = join(config.paths.cacheDir, 'correction-rules.json');
const DUP_COSINE = 0.93;

interface Cache {
  rules: Record<string, string | null>;
  groupsKey?: string;
  groups?: RuleGroup[];
}

const cache: Cache = await readFile(CACHE_FILE, 'utf8')
  .then((r) => JSON.parse(r) as Cache)
  .catch(() => ({ rules: {} }));

await withSession(async (s) => {
  const items = dedupeByText(await loadCorrections(s));
  const missing = items.filter((m) => !(m.uuid in cache.rules));
  if (missing.length > 0) {
    console.log(`extraindo regra implícita de ${missing.length} correções (${Math.ceil(missing.length / 25)} chamadas)`);
    const got = await extractImpliedRules(missing);
    for (const [k, v] of got) cache.rules[k] = v;
  }
  const withRule = items.filter((m) => cache.rules[m.uuid]);
  console.log(`${items.length} correções fortes únicas, ${withRule.length} com regra reutilizável`);

  const key = createHash('sha1').update(withRule.map((m) => m.uuid).sort().join(',')).digest('hex');
  if (cache.groupsKey !== key) {
    cache.groups = await groupRules(withRule.map((m) => cache.rules[m.uuid]!));
    cache.groupsKey = key;
  }
  await mkdir(config.paths.cacheDir, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 1));

  const groups = (cache.groups ?? [])
    .map((g) => {
      const members = g.members.map((i) => withRule[i]!).filter(Boolean);
      return { ...g, members, sessions: new Set(members.map((m) => m.sessionId)).size };
    })
    .filter((g) => g.sessions >= 2)
    .sort((a, b) => b.members.length - a.members.length);

  const skillChunks = await loadSkillChunks(s);
  const vecs = await embed(groups.map((g) => g.text));
  const verdicts = await judgeCoverage(
    groups.map((g, i) => ({ text: g.text, candidates: topSkillChunks(vecs[i]!, skillChunks, 3) })),
  );
  console.log(`${groups.length} regras repetidas em 2+ sessões\n`);

  const now = new Date().toISOString();
  const touched: string[] = [];
  if (apply) {
    // Recalculado do zero: evidência que deixou de ser correção forte (detector
    // mudou) sai antes de religar.
    await s.run(`MATCH (:Decision)-[r:FROM_CORRECTION]->(m:Message) WHERE coalesce(m.correction, '') <> 'strong' DELETE r`);
  }
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const v = verdicts[i]!;
    const earliest = [...g.members].sort((a, b) => a.ts.localeCompare(b.ts))[0]!;
    const id = `corr-${createHash('sha1').update(earliest.uuid).digest('hex').slice(0, 16)}`;
    console.log(`- ${g.members.length}x/${g.sessions} sessões ${v.covered ? `COBERTA (${v.skill})` : 'FORA DAS SKILLS'} [${g.where}${g.skill ? `, ${g.skill}` : ''}]: ${g.text}`);
    if (!apply) continue;

    const dup = await s.run(
      `CALL db.index.vector.queryNodes('chunks_embedding', 10, $vec) YIELD node, score
       WHERE node.sourceKind = 'decision' AND score >= $min
       MATCH (d:Decision)-[:HAS_CHUNK]->(node) WHERE d.id <> $id AND coalesce(d.source, '') <> 'correction'
       RETURN d.id AS id LIMIT 1`,
      { vec: vecs[i], min: DUP_COSINE, id },
    );
    const target = (dup.records[0]?.get('id') as string | undefined) ?? id;
    touched.push(target);
    await s.run(
      `MERGE (d:Decision { id: $id })
       ON CREATE SET d.text = $text, d.kind = 'rule', d.source = 'correction', d.scope = $scope,
                     d.status = 'active', d.createdAt = $now, d.model = $model, d.taskKeys = []
       SET d.correctionCount = $n, d.correctionSessions = $sessions,
           d.where = $where, d.skill = coalesce($skill, d.skill),
           d.coveredBySkill = $covered, d.coveredSkill = $covSkill,
           d.coveredAt = CASE WHEN $covered THEN coalesce(d.coveredAt, $now) ELSE null END,
           d.text = CASE WHEN d.source = 'correction' THEN $text ELSE d.text END
       WITH d
       FOREACH (_ IN CASE WHEN $isNew THEN [1] ELSE [] END |
         MERGE (c:Chunk { id: $id })
         SET c.text = '[rule] ' + $text, c.ordinal = 0, c.sourceKind = 'decision', c.timestamp = coalesce(c.timestamp, $now),
             c.role = null, c.valueScore = 1.0, c.embedding = $vec
         MERGE (d)-[:HAS_CHUNK]->(c))
       WITH d
       UNWIND $members AS u MATCH (m:Message { uuid: u }) MERGE (d)-[:FROM_CORRECTION]->(m)
       WITH DISTINCT d
       OPTIONAL MATCH (k:Skill { name: d.skill })
       FOREACH (_ IN CASE WHEN k IS NULL THEN [] ELSE [1] END | MERGE (d)-[:ABOUT_SKILL]->(k))`,
      {
        id: target,
        isNew: target === id,
        text: g.text,
        scope: g.scope,
        where: g.where,
        skill: g.skill,
        model: HEADLESS_MODEL,
        n: g.members.length,
        sessions: g.sessions,
        covered: v.covered,
        covSkill: v.skill,
        now,
        vec: vecs[i],
        members: g.members.map((m) => m.uuid),
      },
    );
  }
  if (apply) {
    // Regra de correção que não saiu nesta rodada (grupo sumiu ou caiu pra 1
    // sessão) para de valer: some do primer, mas fica no grafo pra histórico.
    const r = await s.run(
      `MATCH (d:Decision { source: 'correction', status: 'active' }) WHERE NOT d.id IN $touched
       SET d.status = 'stale', d.staleAt = $now RETURN count(d) AS n`,
      { touched, now },
    );
    const n = Number(r.records[0]?.get('n') ?? 0);
    if (n > 0) console.log(`\n${n} regras de rodadas anteriores marcadas stale`);
  }
});
await closeDriver();
