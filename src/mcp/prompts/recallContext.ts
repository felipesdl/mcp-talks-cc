import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerRecallContextPrompt(server: McpServer): void {
  server.registerPrompt(
    'recall_context',
    {
      description:
        'Antes de responder pergunta técnica ou propor decisão arquitetural, busca memória cross-conversa indexada. Use quando user referenciar projeto, ticket, ou tópico que pode ter sido discutido antes.',
      argsSchema: {
        query: z.string().min(3).describe('Tópico, pergunta ou keyword a recordar.'),
        scope: z
          .string()
          .optional()
          .describe(
            'Comma-separated subset: conversation,tool_output,plan,todo,task_memory. Vazio = tudo.',
          ),
      },
    },
    ({ query, scope }) => {
      const scopeArr = scope
        ? scope
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const scopeArg = scopeArr.length ? `, scope: [${scopeArr.map((s) => `"${s}"`).join(', ')}]` : '';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Antes de responder, chame search_memory({ query: "${query}", k: 8${scopeArg} }).

Avalie hits:
- score >= 0.75: contexto forte, cite snippet + sessionId no início da resposta
- score 0.6-0.75: contexto fraco, use com cautela e mencione que recuperou da memória
- score < 0.6 em todos hits: memória não cobre o assunto; avise e prossiga com conhecimento geral

Se algum hit tiver source=plan ou source=task_memory, considere expandir com find_related_plans / find_decisions / get_session_transcript antes de responder.`,
            },
          },
        ],
      };
    },
  );
}
