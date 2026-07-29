import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withSession } from '../../neo4j/driver.ts';
import { toToolError } from '../../domain/errors.ts';
import { resolveCallerSession } from '../callerSession.ts';
import { logQuery } from '../../learning/queryLog.ts';

const inputSchema = {
  sessionId: z
    .string()
    .uuid()
    .describe('Session UUID (sessionId field from JSONL events). Get from search_memory results.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(200)
    .describe('Max messages to return ordered by timestamp ascending (default 200).'),
};

export interface TranscriptResult {
  found: boolean;
  sessionId: string;
  project: string | null;
  gitBranch: string | null;
  messageCount: number;
  messages: Array<{ role: string; timestamp: string; text: string }>;
  hint?: string;
}

async function getSessionTranscript(args: {
  sessionId: string;
  limit?: number;
}): Promise<TranscriptResult> {
  const limit = args.limit ?? 200;
  return withSession(async (s) => {
    const r = await s.run(
      `MATCH (sess:Session { id: $sid })
       OPTIONAL MATCH (sess)-[:HAS_MESSAGE]->(m:Message)
       WITH sess, m ORDER BY m.timestamp ASC
       LIMIT toInteger($limit)
       RETURN sess.id AS sessionId,
              sess.projectPath AS project,
              sess.gitBranch AS branch,
              sess.messageCount AS count,
              collect({ role: m.role, timestamp: m.timestamp, text: coalesce(m.text, '') }) AS msgs`,
      { sid: args.sessionId, limit },
    );
    const rec = r.records[0];
    if (!rec || !rec.get('sessionId')) {
      return {
        found: false,
        sessionId: args.sessionId,
        project: null,
        gitBranch: null,
        messageCount: 0,
        messages: [],
        hint: 'Session not indexed. Run `npm run ingest -- --source=conversations` or check sessionId.',
      };
    }
    return {
      found: true,
      sessionId: rec.get('sessionId'),
      project: rec.get('project'),
      gitBranch: rec.get('branch'),
      messageCount: rec.get('count') ?? 0,
      messages: (rec.get('msgs') as Array<{ role: string; timestamp: string; text: string }>).filter(
        (m) => m.role,
      ),
    };
  });
}

export function registerGetSessionTranscriptTool(server: McpServer): void {
  server.registerTool(
    'get_session_transcript',
    {
      description:
        'Retrieve full transcript (ordered messages) of a past Claude Code session by sessionId. Use after `search_memory` returns a session you want to expand. Returns `found: false` if sessionId not indexed.',
      inputSchema,
    },
    async (args) => {
      try {
        const t0 = Date.now();
        const t = await getSessionTranscript(args);
        // sinal de drill-in p/ o grader: transcript aberto logo após uma busca
        // cujos hits apontavam pra essa sessão = retrieval foi útil
        void logQuery({
          v: 1,
          ts: new Date().toISOString(),
          tool: 'get_session_transcript',
          sessionId: resolveCallerSession().sessionId,
          callerProject: resolveCallerSession().project,
          query: null,
          k: null,
          scope: null,
          project: t.project,
          projectStrict: null,
          diversity: null,
          hybridUsed: null,
          nResults: t.found ? t.messages.length : 0,
          topScore: null,
          scores: [],
          latencyMs: Date.now() - t0,
          hits: [],
          refSessionId: args.sessionId,
        });
        if (!t.found) {
          return {
            content: [{ type: 'text', text: `Session ${t.sessionId} not found. ${t.hint ?? ''}` }],
            structuredContent: t,
          };
        }
        const lines = [
          `Session: ${t.sessionId}`,
          `Project: ${t.project ?? '-'}`,
          `Branch:  ${t.gitBranch ?? '-'}`,
          `Messages: ${t.messages.length} / ${t.messageCount}`,
          '',
          ...t.messages.map((m) => `--- ${m.role} @ ${m.timestamp}\n${m.text}`),
        ];
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: t,
        };
      } catch (e) {
        const err = toToolError(e);
        return {
          isError: true,
          content: [{ type: 'text', text: `get_session_transcript ${err.errorType}: ${err.message}` }],
          structuredContent: err,
        };
      }
    },
  );
}
