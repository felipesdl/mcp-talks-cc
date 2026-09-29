import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { toToolError } from '../../domain/errors.ts';
import { day, fmtConf, projectName, shortId, withStructured } from '../output.ts';
import { searchMemory } from './searchMemory.ts';

/**
 * Decisões, regras e gotchas destilados (nós Decision, src/distill/).
 *
 * Antes olhava só `task_memory` (<project>/.claude/tasks/*), que no acervo real
 * tinha 4 chunks: a tool devolvia vazio quase sempre. Agora a fonte principal é
 * o Decision destilado de toda sessão fechada, e task_memory entra junto quando
 * existe.
 */

const inputSchema = {
  query: z.string().min(1).describe('Topic / question you want decisions, rules or gotchas about.'),
  taskId: z
    .string()
    .optional()
    .describe('ABC-1234. When set, lists every distilled decision of that task (query only ranks).'),
  k: z.number().int().min(1).max(20).default(8).describe('Number of results (default 8).'),
};

export interface DecisionHit {
  id: string;
  kind: string;
  text: string;
  project: string | null;
  tasks: string[];
  timestamp: string | null;
  confidence: number | null;
  source: string;
}

async function decisionsOfTask(taskId: string, k: number): Promise<DecisionHit[]> {
  return withSession(async (s) => {
    const r = await s.run(
      `MATCH (d:Decision { status: 'active' })-[:ON_TASK]->(:Task { key: $key })
       RETURN d.id AS id, d.kind AS kind, d.text AS text, d.projectPath AS project,
              d.taskKeys AS tasks, d.createdAt AS ts
       ORDER BY d.createdAt DESC LIMIT toInteger($k)`,
      { key: taskId.toUpperCase(), k },
    );
    return r.records.map((rec) => ({
      id: rec.get('id'),
      kind: rec.get('kind'),
      text: rec.get('text'),
      project: rec.get('project'),
      tasks: rec.get('tasks') ?? [],
      timestamp: rec.get('ts'),
      confidence: null,
      source: 'decision',
    }));
  });
}

export async function findDecisions(args: { query: string; taskId?: string; k?: number }): Promise<DecisionHit[]> {
  const k = args.k ?? 8;
  if (args.taskId) {
    const own = await decisionsOfTask(args.taskId, k);
    if (own.length > 0) return own;
  }
  const r = await searchMemory({
    query: args.taskId ? `${args.taskId} ${args.query}` : args.query,
    k,
    scope: ['decision', 'task_memory'],
    diversity: 0.5,
  });
  return r.hits.map((h) => ({
    id: h.id,
    kind: h.source === 'decision' ? (/^\[(\w+)\]/.exec(h.snippet)?.[1] ?? 'decision') : 'task_memory',
    text: h.snippet.replace(/^\[\w+\]\s*/, ''),
    project: h.project,
    tasks: h.tasks,
    timestamp: h.timestamp,
    confidence: h.confidence,
    source: h.source,
  }));
}

export function registerFindDecisionsTool(server: McpServer): void {
  server.registerTool(
    'find_decisions',
    {
      description:
        'Distilled decisions, rules and gotchas from past sessions (short, self-contained, ~50 tokens each). Cheapest way to recall "what did we decide about X" or "what is the rule for Y". With `taskId`, lists that task\'s decisions.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const hits = await findDecisions(args);
        const text =
          hits.length === 0
            ? 'nenhuma decisão destilada encontrada.'
            : hits
                .map(
                  (h, i) =>
                    `[${i + 1}] conf=${fmtConf(h.confidence)} id=${shortId(h.id)} ${h.kind} ${projectName(h.project)} ${day(h.timestamp)}${h.tasks.length ? ` ${h.tasks.join(',')}` : ''} | ${h.source === 'decision' ? h.text : h.text.slice(0, 200)}`,
                )
                .join('\n');
        return withStructured({ content: [{ type: 'text', text }] }, { hits });
      } catch (e) {
        const err = toToolError(e);
        return withStructured(
          { isError: true, content: [{ type: 'text', text: `find_decisions ${err.errorType}: ${err.message}` }] },
          err,
        );
      }
    },
  );
}
