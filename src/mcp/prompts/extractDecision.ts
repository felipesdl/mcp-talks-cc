import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerExtractDecisionPrompt(server: McpServer): void {
  server.registerPrompt(
    'extract_decision',
    {
      description:
        'Extrai decisão arquitetural estruturada de uma task de ticket: consulta task memory + transcripts e responde no formato Problema/Opções/Escolha/Razão.',
      argsSchema: {
        taskId: z.string().describe('Ticket id (e.g. ABC-123).'),
        topic: z
          .string()
          .optional()
          .describe('Aspecto específico da decisão (ex: "validação de formulário"). Vazio = todas as decisões da task.'),
      },
    },
    ({ taskId, topic }) => {
      const query = topic ?? `decisões arquiteturais da ${taskId}`;
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Para reconstruir decisão da task ${taskId}:

1. Chame find_decisions({ query: "${query}", taskId: "${taskId}", k: 10 }). Anote kind/path de cada hit (decisions.md, learnings.md, context.md).
2. Se as decisões mencionarem sessionId, chame get_session_transcript({ sessionId, limit: 100 }) para cada um.
3. Responda no formato abaixo, em pt-BR:

**${taskId}${topic ? ` — ${topic}` : ''}**

- **Problema**: 1-2 frases
- **Opções consideradas**: bullets curtos
- **Escolha**: opção selecionada
- **Razão**: por quê (com referência a decisions.md/learnings.md quando aplicável)
- **Aprendizados**: se houver learnings.md, sintetize 1-2 pontos

Se não encontrar info suficiente, avise quais arquivos/sessões consultou e o que falta.`,
            },
          },
        ],
      };
    },
  );
}
