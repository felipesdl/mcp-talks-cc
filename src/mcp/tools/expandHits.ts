import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { toToolError } from '../../domain/errors.ts';
import { resolveCallerSession } from '../callerSession.ts';
import { logQuery } from '../../learning/queryLog.ts';
import { resolveChunkIds } from '../chunkIds.ts';
import { day, projectName, shortId, withStructured } from '../output.ts';
import { stripWrappers } from '../../ingest/quality.ts';

/**
 * Segundo estágio do retrieval em duas etapas: search_memory devolve 1 linha
 * por hit, e só o que o modelo escolher ler custa o texto inteiro.
 *
 * Também é o sinal de uso mais honesto que o grader tem. Antes o drill-in
 * dependia de get_session_transcript, que o modelo quase nunca chama (1 vez em
 * 57 dias), então o sinal de maior peso da utility nunca disparava. Expandir um
 * hit é escolha explícita de um resultado: é crédito direto pra ele.
 */

const NEIGHBOR_CHARS = 400;

const inputSchema = {
  ids: z
    .array(z.string().min(8))
    .min(1)
    .max(10)
    .describe('Chunk ids from search_memory / find_similar_chunks / memory pointers (the 12-char short id is enough).'),
  neighbors: z
    .boolean()
    .optional()
    .describe('Also return the previous/next chunk of the same message or plan (default false).'),
};

interface Expanded {
  id: string;
  text: string;
  source: string;
  project: string | null;
  sessionId: string | null;
  timestamp: string | null;
  tasks: string[];
  parentLabel: string | null;
  parentKey: string | null;
  neighbors: string[];
}

export async function expandHits(ids: string[], neighbors = false): Promise<Expanded[]> {
  return withSession(async (s) => {
    const full = await resolveChunkIds(s, ids);
    if (full.length === 0) return [];
    const r = await s.run(
      `UNWIND $ids AS id
       MATCH (c:Chunk { id: id })
       OPTIONAL MATCH (parent)-[:HAS_CHUNK]->(c)
       OPTIONAL MATCH (parent)-[:HAS_CHUNK]->(sib:Chunk)
       WHERE $neighbors AND sib.id <> c.id AND abs(sib.ordinal - c.ordinal) <= 1
       WITH c, parent, sib ORDER BY sib.ordinal
       WITH c, parent, collect(sib.text) AS neighbors
       OPTIONAL MATCH (:Session { id: c.sessionId })-[:ON_TASK]->(t:Task)
       RETURN c.id AS id, c.text AS text, c.sourceKind AS source, c.projectPath AS project,
              c.sessionId AS sessionId, c.timestamp AS timestamp,
              collect(DISTINCT t.key)[..3] AS tasks,
              labels(parent)[0] AS parentLabel,
              coalesce(parent.uuid, parent.path, parent.id) AS parentKey,
              neighbors`,
      { ids: full, neighbors },
    );
    return r.records.map((rec) => ({
      id: rec.get('id'),
      text: rec.get('text'),
      source: rec.get('source'),
      project: rec.get('project'),
      sessionId: rec.get('sessionId'),
      timestamp: rec.get('timestamp'),
      tasks: rec.get('tasks'),
      parentLabel: rec.get('parentLabel'),
      parentKey: rec.get('parentKey'),
      neighbors: (rec.get('neighbors') as string[]).map((n) => n.slice(0, NEIGHBOR_CHARS)),
    }));
  });
}

export function registerExpandHitsTool(server: McpServer): void {
  server.registerTool(
    'expand_hits',
    {
      description:
        'Full text of chosen memory hits. search_memory returns one line per hit to save context; call this with the ids worth reading (only those). Also accepts ids from memory pointers injected by hooks. Use `neighbors: true` for the surrounding chunks.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const t0 = Date.now();
        const found = await expandHits(args.ids, args.neighbors ?? false);
        const caller = resolveCallerSession();
        void logQuery({
          v: 1,
          ts: new Date().toISOString(),
          tool: 'expand_hits',
          sessionId: caller.sessionId,
          callerProject: caller.project,
          query: null,
          k: null,
          scope: null,
          project: null,
          projectStrict: null,
          diversity: null,
          hybridUsed: null,
          nResults: found.length,
          topScore: null,
          scores: [],
          latencyMs: Date.now() - t0,
          hits: [],
          refChunkIds: found.map((f) => f.id),
        });
        const text =
          found.length === 0
            ? 'nenhum id resolvido (prefixo curto demais, ambíguo ou inexistente).'
            : found
                .map((f) => {
                  const head = `[${shortId(f.id)}] ${f.source} ${projectName(f.project)} ${day(f.timestamp)} session=${f.sessionId ?? '-'}${f.tasks.length ? ` ${f.tasks.join(',')}` : ''} parent=${f.parentLabel}/${f.parentKey}`;
                  const nb = f.neighbors.length > 0 ? `\n  vizinhos: ${f.neighbors.map(stripWrappers).join(' | ')}` : '';
                  return `${head}\n${stripWrappers(f.text)}${nb}`;
                })
                .join('\n\n');
        return withStructured({ content: [{ type: 'text', text }] }, { hits: found });
      } catch (e) {
        const err = toToolError(e);
        return withStructured(
          { isError: true, content: [{ type: 'text', text: `expand_hits ${err.errorType}: ${err.message}` }] },
          err,
        );
      }
    },
  );
}
