import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { toToolError } from '../../domain/errors.ts';

const inputSchema = {
  project: z
    .string()
    .min(1)
    .describe(
      'Absolute project path (e.g. /Users/you/Documents/code/your-project). Match exactly the `cwd` recorded in Claude Code JSONL events.',
    ),
  since: z
    .string()
    .optional()
    .describe('ISO timestamp. Only sessions started >= since.'),
};

export interface ProjectActivity {
  found: boolean;
  project: string;
  sessionCount: number;
  messageCount: number;
  toolCallCount: number;
  branches: string[];
  firstSession: string | null;
  lastSession: string | null;
  hint?: string;
}

async function listProjectActivity(args: {
  project: string;
  since?: string;
}): Promise<ProjectActivity> {
  return withSession(async (s) => {
    const exists = await s.run(`MATCH (p:Project { path: $project }) RETURN p.path AS path`, {
      project: args.project,
    });
    if (!exists.records.length) {
      return {
        found: false,
        project: args.project,
        sessionCount: 0,
        messageCount: 0,
        toolCallCount: 0,
        branches: [],
        firstSession: null,
        lastSession: null,
        hint: 'Project path not indexed. Check spelling or run `npm run ingest -- --source=all`.',
      };
    }
    const r = await s.run(
      `MATCH (p:Project { path: $project })
       OPTIONAL MATCH (p)-[:HAS_SESSION]->(sess:Session)
       WHERE $since IS NULL OR sess.startedAt >= $since
       OPTIONAL MATCH (sess)-[:HAS_MESSAGE]->(m:Message)
       OPTIONAL MATCH (m)-[:INVOKED]->(tc:ToolCall)
       RETURN p.path AS project,
              count(DISTINCT sess) AS sessionCount,
              count(DISTINCT m) AS messageCount,
              count(DISTINCT tc) AS toolCallCount,
              collect(DISTINCT sess.gitBranch) AS branches,
              min(sess.startedAt) AS firstSession,
              max(sess.startedAt) AS lastSession`,
      { project: args.project, since: args.since ?? null },
    );
    const rec = r.records[0]!;
    return {
      found: true,
      project: rec.get('project'),
      sessionCount: rec.get('sessionCount'),
      messageCount: rec.get('messageCount'),
      toolCallCount: rec.get('toolCallCount'),
      branches: (rec.get('branches') as (string | null)[]).filter((b): b is string => !!b),
      firstSession: rec.get('firstSession'),
      lastSession: rec.get('lastSession'),
    };
  });
}

export function registerListProjectActivityTool(server: McpServer): void {
  server.registerTool(
    'list_project_activity',
    {
      description:
        'Aggregate stats for one project: session count, message count, tool calls, branches touched, first/last session timestamps. Pure Cypher, no embeddings. Returns `found: false` if project path not indexed.',
      inputSchema,
    },
    async (args) => {
      try {
        const a = await listProjectActivity(args);
        if (!a.found) {
          return {
            content: [{ type: 'text', text: `Project ${a.project} not indexed. ${a.hint ?? ''}` }],
            structuredContent: a,
          };
        }
        const text = [
          `Project: ${a.project}`,
          `Sessions: ${a.sessionCount}`,
          `Messages: ${a.messageCount}`,
          `Tool calls: ${a.toolCallCount}`,
          `Branches: ${a.branches.join(', ') || '-'}`,
          `First session: ${a.firstSession ?? '-'}`,
          `Last session:  ${a.lastSession ?? '-'}`,
        ].join('\n');
        return { content: [{ type: 'text', text }], structuredContent: a };
      } catch (e) {
        const err = toToolError(e);
        return {
          isError: true,
          content: [
            { type: 'text', text: `list_project_activity ${err.errorType}: ${err.message}` },
          ],
          structuredContent: err,
        };
      }
    },
  );
}
