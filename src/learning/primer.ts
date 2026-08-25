import { basename } from 'node:path';
import type { Profile } from './types.ts';

const MAX_CONTEXT_CHARS = 1800; // ~400 tokens (inclui aviso de tuning pendente)

/**
 * Fallback do gate quando a calibração de score não está pronta. Mesmos números
 * do CLAUDE.md, repetidos aqui de propósito: o primer é a única coisa garantida
 * em contexto no início da sessão.
 */
const GATE_FALLBACK = { strong: 0.9, floor: 0.59 };

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
  // Gate de citação empurrado, não puxado. A regra equivalente já existia no
  // CLAUDE.md mandando LER o rationale antes de citar, e ficou inerte por semanas:
  // leitura discricionária depende de alguém lembrar. ~20 tokens por sessão pra
  // que o número esteja em contexto na hora da decisão.
  const gate = profile.confidenceGate;
  if (gate) {
    lines.push(
      `gate de citação desta sessão: forte >= ${gate.strong.toFixed(2)}, ignorar < ${gate.floor.toFixed(2)} ` +
        `(p75/p25 de ${gate.nQueries} queries; deriva com o volume, use este valor e não um lembrado).`,
    );
  } else {
    lines.push(
      `gate de citação: calibração de score incompleta, search_memory devolve confidence=null. ` +
        `NENHUM hit conta como forte; fallback forte >= ${GATE_FALLBACK.strong.toFixed(2)}, ignorar < ${GATE_FALLBACK.floor.toFixed(2)}.`,
    );
  }
  if (pendingCandidate) {
    const days = Math.floor(
      (Date.now() - new Date(pendingCandidate.proposedAt).getTime()) / 86_400_000,
    );
    const age = days >= 1 ? `pendente há ${days}d` : 'nova';
    lines.push(
      `>> TUNING PENDENTE: proposta de retrieval ${age} (${pendingCandidate.nGrades} grades). ` +
        `IMPORTANTE: avise o user no início da primeira resposta: revisar ~/.cache/mcp-talks-cc/tuning-rationale.md ` +
        `e então aplicar com \`npm run self-tune:accept\` OU recusar com \`npm run self-tune:reject\` ` +
        `(ou pedir "mostra o tuning" pra ver o resumo aqui). Recusar é uma saída legítima: ` +
        `não sugira aplicar sem antes ler o rationale.`,
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
