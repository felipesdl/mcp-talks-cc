import { basename } from 'node:path';
import type { Profile } from './types.ts';

const MAX_CONTEXT_CHARS = 1800; // ~400 tokens (inclui aviso de tuning pendente)

export interface PendingCandidateInfo {
  proposedAt: string; // estável entre re-runs (preservado se o conteúdo não mudou)
  nGrades: number;
}

/**
 * Gera primer.json no envelope final do hook SessionStart — o hook bash só
 * faz cat. Escapagem fica aqui (JSON.stringify), não no shell.
 * Retorna null quando ainda não há dado aprendido (cold start: sem primer).
 */
export function buildPrimer(
  profile: Profile,
  pendingCandidate: PendingCandidateInfo | null = null,
): string | null {
  if (profile.lastEval.queriesGraded === 0 && profile.topProjects.length === 0) return null;

  const lines: string[] = [
    `[memória mcp-talks-cc | perfil aprendido em ${profile.generatedAt.slice(0, 10)}, janela ${profile.windowDays}d]`,
  ];

  if (profile.topProjects.length > 0) {
    lines.push(
      `projetos quentes: ${profile.topProjects
        .slice(0, 3)
        .map((p) => `${p.name} (${Math.round(p.share * 100)}%)`)
        .join(', ')}`,
    );
  }
  if (profile.projectClusters.length > 0) {
    lines.push(
      `repos que andam juntos: ${profile.projectClusters
        .slice(0, 2)
        .map((c) => c.map((p) => basename(p)).join('+'))
        .join('; ')} (regras podem cruzar repos — busca sem projectStrict)`,
    );
  }
  if (profile.recurringTopics.length > 0) {
    lines.push(`temas recorrentes: ${profile.recurringTopics.slice(0, 6).join(', ')}`);
  }
  if (profile.recentHighValue.length > 0) {
    lines.push('buscas de alto valor recentes:');
    for (const hv of profile.recentHighValue.slice(0, 3)) {
      lines.push(`- "${hv.gist}" (${hv.when}, ${hv.ref})`);
    }
  }
  if (pendingCandidate) {
    const days = Math.floor(
      (Date.now() - new Date(pendingCandidate.proposedAt).getTime()) / 86_400_000,
    );
    const age = days >= 1 ? `pendente há ${days}d` : 'nova';
    lines.push(
      `>> TUNING PENDENTE: proposta de retrieval ${age} (${pendingCandidate.nGrades} grades). ` +
        `IMPORTANTE: avise o user no início da primeira resposta: revisar ~/.cache/mcp-talks-cc/tuning-rationale.md ` +
        `e aplicar com \`npm run self-tune:accept\` (ou pedir "mostra o tuning" pra ver o resumo aqui).`,
    );
  }
  lines.push(
    'isto é só um índice. pra detalhe, chame search_memory (tópico abstrato > palavra solta).',
  );

  let context = lines.join('\n');
  if (context.length > MAX_CONTEXT_CHARS) context = context.slice(0, MAX_CONTEXT_CHARS - 1) + '…';

  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    }) + '\n'
  );
}
