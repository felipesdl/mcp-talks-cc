import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from 'neo4j-driver';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { toToolError } from '../../domain/errors.ts';
import { taskKeyFromSlug } from '../../ingest/entities.ts';
import { familyOf } from '../../epics/family.ts';
import { logToolUse } from '../../learning/queryLog.ts';
import { resolveCallerSession } from '../callerSession.ts';
import { withStructured } from '../output.ts';
import { searchMemory } from './searchMemory.ts';

/**
 * "Qual o meu fluxo pra esse tipo de task": junta as sessões de implementação
 * parecidas (a própria task, irmãs pelo epic, tasks que mexem nos mesmos
 * arquivos, ou o que a busca achar pra uma descrição) e devolve a cadeia típica
 * de skills e agentes, onde costuma quebrar, as correções que mais se repetem e
 * o desfecho. Sem snippet: ~300 tokens.
 */

const inputSchema = {
  taskKey: z.string().min(3).optional().describe('Jira key (e.g. EDC-1234): uses this task, its epic siblings and tasks touching the same files.'),
  query: z.string().min(3).optional().describe('Free description of the kind of task (e.g. "frontend form with figma", "laravel endpoint + migration").'),
  project: z.string().optional().describe('Repo name or absolute path to restrict to.'),
  limit: z.number().int().min(5).max(80).optional().describe('Max sessions to aggregate (default 40).'),
};

export interface SessionFlow {
  id: string;
  tasks: string[];
  skills: string[];
  agents: string[];
  errors: Array<{ where: string; kind: string }>;
  corrections: string[];
  prStates: string[];
}

export interface FlowSummary {
  sessions: number;
  tasks: number;
  skillShare: Array<{ name: string; pct: number }>;
  chain: string[];
  agentShare: Array<{ name: string; pct: number }>;
  hotspots: Array<{ where: string; kind: string; count: number }>;
  /** Bash com exit != 0: quase sempre grep/test sem resultado, por isso fica fora dos hotspots. */
  bashExit: number;
  corrections: Array<{ text: string; count: number }>;
  mergedPct: number | null;
  sessionsPerTask: number | null;
}

const gist = (t: string, n = 110): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Agregação pura: testável sem banco. */
export function aggregateFlow(flows: SessionFlow[]): FlowSummary {
  const n = flows.length;
  const share = (pick: (f: SessionFlow) => string[]): Array<{ name: string; pct: number }> => {
    const c = new Map<string, number>();
    for (const f of flows) for (const x of new Set(pick(f))) c.set(x, (c.get(x) ?? 0) + 1);
    return [...c.entries()]
      .map(([name, k]) => ({ name, pct: Math.round((100 * k) / Math.max(n, 1)) }))
      .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  };

  // Cadeia típica: começa pela skill que mais abre sessão e segue o par mais frequente.
  const pairs = new Map<string, Map<string, number>>();
  const firsts = new Map<string, number>();
  for (const f of flows) {
    const seq = f.skills.filter((x, i) => f.skills.indexOf(x) === i);
    if (seq[0]) firsts.set(seq[0], (firsts.get(seq[0]) ?? 0) + 1);
    for (let i = 0; i < seq.length - 1; i++) {
      const m = pairs.get(seq[i]!) ?? new Map<string, number>();
      m.set(seq[i + 1]!, (m.get(seq[i + 1]!) ?? 0) + 1);
      pairs.set(seq[i]!, m);
    }
  }
  const chain: string[] = [];
  let cur = [...firsts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  while (cur && !chain.includes(cur) && chain.length < 7) {
    chain.push(cur);
    const next = [...(pairs.get(cur) ?? new Map()).entries()]
      .filter(([k, v]) => !chain.includes(k) && v >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    cur = next?.[0];
  }

  const hot = new Map<string, { where: string; kind: string; count: number }>();
  let bashExit = 0;
  for (const f of flows) {
    for (const e of f.errors) {
      if (e.where === 'Bash' && e.kind === 'exit') {
        bashExit++;
        continue;
      }
      const k = `${e.where}|${e.kind}`;
      const h = hot.get(k) ?? { ...e, count: 0 };
      h.count++;
      hot.set(k, h);
    }
  }
  const corr = new Map<string, { text: string; count: number }>();
  for (const f of flows) {
    for (const t of f.corrections) {
      const key = t
        .toLowerCase()
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(/\s+/g, ' ')
        .slice(0, 50);
      const c = corr.get(key) ?? { text: t, count: 0 };
      c.count++;
      corr.set(key, c);
    }
  }
  const taskSet = new Set(flows.flatMap((f) => f.tasks));
  const byTaskPrs = new Map<string, string[]>();
  for (const f of flows) for (const t of f.tasks) byTaskPrs.set(t, [...(byTaskPrs.get(t) ?? []), ...f.prStates]);
  const withPr = [...byTaskPrs.values()].filter((s) => s.length > 0);
  const merged = withPr.filter((s) => s.every((x) => x === 'MERGED')).length;

  return {
    sessions: n,
    tasks: taskSet.size,
    skillShare: share((f) => f.skills).slice(0, 8),
    chain,
    agentShare: share((f) => f.agents).slice(0, 5),
    hotspots: [...hot.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    bashExit,
    corrections: [...corr.values()].sort((a, b) => b.count - a.count).slice(0, 4),
    mergedPct: withPr.length ? Math.round((100 * merged) / withPr.length) : null,
    sessionsPerTask: taskSet.size ? Math.round((10 * flows.filter((f) => f.tasks.length).length) / taskSet.size) / 10 : null,
  };
}

async function similarSessions(
  s: Session,
  args: { taskKey?: string; query?: string; project?: string },
  limit: number,
): Promise<{ ids: string[]; basis: string[] }> {
  const ids = new Set<string>();
  const basis: string[] = [];
  const addTaskSessions = async (keys: string[]): Promise<number> => {
    if (keys.length === 0) return 0;
    const r = await s.run(`UNWIND $keys AS k MATCH (:Task { key: k })<-[:ON_TASK]-(se:Session) RETURN DISTINCT se.id AS id`, { keys });
    r.records.forEach((x) => ids.add(x.get('id') as string));
    return r.records.length;
  };
  if (args.taskKey) {
    const key = taskKeyFromSlug(args.taskKey) ?? args.taskKey;
    basis.push(`${key}: ${await addTaskSessions([key])}s`);
    const fam = await familyOf(s, key);
    if (fam.siblings.length) basis.push(`irmãs ${fam.epic?.key ?? ''}: ${await addTaskSessions(fam.siblings)}s`);
    const near = await s.run(
      `MATCH (:Task { key: $key })-[:TOUCHES]->(f:File)<-[:TOUCHES]-(o:Task) WHERE o.key <> $key
       WITH o, sum(coalesce(f.idf, 1)) AS w ORDER BY w DESC LIMIT 6 RETURN collect(o.key) AS keys`,
      { key },
    );
    const keys = (near.records[0]?.get('keys') as string[]) ?? [];
    if (keys.length) basis.push(`mesmos arquivos (${keys.slice(0, 3).join(', ')}): ${await addTaskSessions(keys)}s`);
  }
  if (args.query) {
    const r = await searchMemory({
      query: args.query,
      k: 30,
      scope: ['conversation', 'task_memory', 'pr'],
      diversity: 0.3,
      callerSessionId: null,
    });
    let n = 0;
    for (const h of r.hits) if (h.sessionId && !ids.has(h.sessionId)) (ids.add(h.sessionId), n++);
    n += await addTaskSessions([...new Set(r.hits.filter((h) => !h.sessionId).flatMap((h) => h.tasks))]);
    basis.push(`busca "${gist(args.query, 40)}": ${n}s`);
  }
  if (ids.size === 0) return { ids: [], basis };
  const proj = args.project ?? null;
  const r = await s.run(
    `UNWIND $ids AS id MATCH (se:Session { id: id }) WHERE coalesce(se.kind, 'implementation') = 'implementation'
       AND ($proj IS NULL OR se.projectPath = $proj OR se.projectPath ENDS WITH ('/' + $proj))
     RETURN se.id AS id ORDER BY se.startedAt DESC LIMIT toInteger($limit)`,
    { ids: [...ids], proj, limit },
  );
  return { ids: r.records.map((x) => x.get('id') as string), basis };
}

async function loadFlows(s: Session, ids: string[]): Promise<SessionFlow[]> {
  const r = await s.run(
    `UNWIND $ids AS id MATCH (se:Session { id: id })
     CALL (se) { OPTIONAL MATCH (se)-[u:USED_SKILL]->(k:Skill { kind: 'skill' })
       WITH k, u ORDER BY u.firstAt RETURN collect(k.name) AS skills }
     CALL (se) { OPTIONAL MATCH (se)-[:USED_AGENT]->(a:AgentType) RETURN collect(a.name) AS agents }
     CALL (se) { OPTIONAL MATCH (se)-[:ON_TASK]->(t:Task) RETURN collect(DISTINCT t.key) AS tasks }
     CALL (se) { OPTIONAL MATCH (se)-[:ON_TASK]->(:Task)<-[:FOR_TASK]-(pr:PullRequest) RETURN collect(DISTINCT pr.state) AS prs }
     CALL (se) { OPTIONAL MATCH (se)-[:HAS_MESSAGE]->(:Message)-[:INVOKED]->(res:ToolCall { name: 'tool_result' })-[:RESULT_OF]->(use:ToolCall)
       WHERE res.isError = true
       RETURN collect({ where: coalesce(use.skill, use.name), kind: res.errorKind }) AS errors }
     CALL (se) { OPTIONAL MATCH (se)-[:HAS_MESSAGE]->(m:Message { correction: 'strong' })
       RETURN collect(m.correctionText) AS corrections }
     RETURN se.id AS id, skills, agents, tasks, prs, errors, corrections`,
    { ids },
  );
  return r.records.map((x) => ({
    id: x.get('id') as string,
    skills: (x.get('skills') as string[]).filter(Boolean),
    agents: (x.get('agents') as string[]).filter(Boolean),
    tasks: (x.get('tasks') as string[]).filter(Boolean),
    prStates: (x.get('prs') as string[]).filter(Boolean),
    errors: (x.get('errors') as Array<{ where: string | null; kind: string | null }>)
      .filter((e) => e.where && e.kind)
      .map((e) => ({ where: e.where!, kind: e.kind! })),
    corrections: (x.get('corrections') as string[]).filter(Boolean),
  }));
}

export function formatFlow(f: FlowSummary, basis: string[]): string {
  if (f.sessions === 0) return `nenhuma sessão de implementação parecida (${basis.join('; ') || 'sem base'}).`;
  const lines = [
    `${f.sessions} sessões de implementação, ${f.tasks} tasks (${basis.join('; ')})`,
    f.chain.length ? `cadeia típica: ${f.chain.join(' -> ')}` : 'cadeia típica: sem skill recorrente',
    `skills: ${f.skillShare.map((x) => `${x.name} ${x.pct}%`).join(', ') || '-'}`,
    `agentes: ${f.agentShare.map((x) => `${x.name} ${x.pct}%`).join(', ') || '-'}`,
  ];
  if (f.hotspots.length || f.bashExit) {
    const hs = f.hotspots.map((h) => `${h.where.replace(/^mcp__/, '')} ${h.kind} ${h.count}x`).join(', ');
    lines.push(`onde quebra: ${hs || '-'}${f.bashExit ? ` (+ Bash exit≠0 ${f.bashExit}x, quase sempre grep sem resultado)` : ''}`);
  }
  if (f.corrections.length) lines.push(`correções que mais voltam: ${f.corrections.map((c) => `"${gist(c.text, 80)}"${c.count > 1 ? ` ${c.count}x` : ''}`).join(' | ')}`);
  const out = [
    f.mergedPct !== null ? `${f.mergedPct}% das tasks com PR mergeado` : null,
    f.sessionsPerTask !== null ? `${f.sessionsPerTask} sessões por task` : null,
  ].filter(Boolean);
  if (out.length) lines.push(`desfecho: ${out.join(', ')}`);
  return lines.join('\n');
}

export async function myFlow(args: {
  taskKey?: string;
  query?: string;
  project?: string;
  limit?: number;
}): Promise<{ summary: FlowSummary; basis: string[] }> {
  return withSession(async (s) => {
    const sim = await similarSessions(s, args, args.limit ?? 40);
    return { summary: aggregateFlow(await loadFlows(s, sim.ids)), basis: sim.basis };
  });
}

export function registerMyFlowTool(server: McpServer): void {
  server.registerTool(
    'my_flow',
    {
      description:
        'Your usual workflow for a kind of task, from past implementation sessions (~300 tokens): typical chain of skills, share of skills and agents, where it usually breaks (tool errors and rejections by tool/skill), the corrections you repeat most, and the outcome (PRs merged, sessions per task). Pass `taskKey` (that task, its epic siblings and tasks touching the same files) and/or `query` (free description of the kind of task). Use it when starting a task, before planning.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        if (!args.taskKey && !args.query) throw new Error('passe taskKey ou query');
        const t0 = Date.now();
        const { summary, basis } = await myFlow(args);
        logToolUse('my_flow', resolveCallerSession(), args.taskKey ?? args.query ?? null, summary.sessions, Date.now() - t0);
        return withStructured({ content: [{ type: 'text', text: formatFlow(summary, basis) }] }, { ...summary, basis });
      } catch (e) {
        const err = toToolError(e);
        return withStructured({ isError: true, content: [{ type: 'text', text: `my_flow ${err.errorType}: ${err.message}` }] }, err);
      }
    },
  );
}
