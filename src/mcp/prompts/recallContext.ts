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
            'Comma-separated subset: conversation,plan,task_memory. Vazio = tudo.',
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

Saída vem brief (1 linha por hit). Decida pela \`conf\`, nunca pelo \`score\` (o score só ordena dentro da mesma busca):
- conf >= gate forte do primer (fallback 0.90): contexto forte. Chame expand_hits só nos ids que vai usar e cite em 1 frase.
- conf entre o piso e o forte: fraco. Só expande se for diretamente útil, e cite com cautela.
- conf abaixo do piso (fallback 0.59) em todos, ou conf n/a: memória não cobre bem. Não cite, siga com conhecimento geral.

Se o assunto mudar no meio da conversa, busque de novo: brief custa ~400 tokens.`,
            },
          },
        ],
      };
    },
  );
}
