import { config } from '../config.ts';

/**
 * Filtro de qualidade dos chunks de conversa.
 *
 * Motivo (medido em 2026-08-03): o índice tinha 38.360 chunks `conversation`,
 * 34% deles com menos de 200 chars e 9% boilerplate literal. Como o bge-m3
 * devolve cosseno entre 0.87 e 0.91 pra qualquer par, uma frase curta e vazia
 * ("Now let me check the repositories") embeda num vetor genérico que fica perto
 * de tudo, entra no pool de recall e compete de igual com conteúdo real. O
 * resultado prático era `confidence` alta em filler.
 *
 * Este módulo é a ÚNICA fonte desse critério: o ingest usa pra não indexar, e
 * `src/cli/pruneChunks.ts` usa pra apagar o que já entrou. Predicado puro, sem
 * I/O, pra poder testar e pra dry-run do prune bater com o ingest.
 */

/** Blocos que o harness injeta e que nunca são conteúdo do usuário. */
const WRAPPER_PATTERNS: RegExp[] = [
  /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<(?:bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>[\s\S]*?<\/(?:bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>/g,
  // referência de imagem no cache local: caminho opaco, zero valor semântico
  /\[Image(?::\s*source:[^\]]*|\s*#\d+)\]/g,
  // preâmbulo de skill: o corpo da skill não é fala de ninguém
  /^Base directory for this skill:.*$/gm,
  // texto injetado por hook do próprio mcp-talks-cc (o aviso de tuning estava indexado)
  /^\s*>?\s*⚠️.*mcp-talks-cc.*$/gm,
  /^\s*Lembrete: mcp-talks-cc.*$/gm,
  /^\[(?:memória|ALERTA) mcp-talks-cc[\s\S]*?$/gm,
  /^CAVEMAN MODE ACTIVE.*$/gm,
];

/**
 * Anúncio de próxima ação, sem conteúdo próprio: "Now let me check X",
 * "Agora listing-detail-page. Leio os 2 blocos:", "Vou refazer o sync".
 * É a maior família de ruído do corpus. Ancorado no início porque o que importa
 * é a mensagem ser SÓ o anúncio.
 */
const ANNOUNCEMENT_RE =
  /^(?:(?:ok|okay|certo|pronto|beleza|feito|excellent|perfect|great|got it|alright)[\s,.!]*)*(?:now\s+|então\s+|agora\s+)?(?:let me|let's|i'll|i will|i'm going to|i am going to|vou|vamos|agora vou|agora|primeiro|deixa eu|deixe-me)\b/i;

/**
 * Sinal de que um texto curto ainda carrega informação: crase de código, URL,
 * caminho, extensão de arquivo, ticket ou identificador camelCase.
 * "Modificar service: dispatch Job ao invés de `Mail::to->send`." tem 61 chars
 * e é uma decisão de verdade — o floor de tamanho não pode matar isso.
 */
const CONTENT_SIGNAL_RE =
  /`|https?:\/\/|\/[\w.-]+\/|\.(?:ts|tsx|js|jsx|mjs|php|md|py|go|rb|sql|json|ya?ml|sh|css|scss)\b|\b[A-Z]{2,}-\d+\b|\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/;

/** Marcador de que a mensagem entrega conclusão, não só anuncia. */
const PAYLOAD_RE = /```|^\s*[-*|>]\s|\n\s*[-*|]\s|\bporque\b|\bbecause\b|→/;

/** Acima disso, um texto que começa com anúncio provavelmente também entrega. */
const ANNOUNCEMENT_MAX_CHARS = 260;

export type LowValueReason = 'empty' | 'filler' | 'short';

/** Remove blocos injetados pelo harness. Pode devolver string vazia. */
export function stripWrappers(text: string): string {
  let out = text;
  for (const re of WRAPPER_PATTERNS) out = out.replace(re, ' ');
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Motivo pelo qual o texto não merece um chunk, ou null se merece.
 * Espera texto JÁ passado por stripWrappers.
 */
export function lowValueReason(stripped: string): LowValueReason | null {
  const t = stripped.trim();
  if (t.length < config.quality.hardFloorChars) return 'empty';

  if (
    t.length < ANNOUNCEMENT_MAX_CHARS &&
    ANNOUNCEMENT_RE.test(t) &&
    !PAYLOAD_RE.test(t)
  ) {
    return 'filler';
  }

  if (t.length < config.quality.minConversationChars && !CONTENT_SIGNAL_RE.test(t)) {
    return 'short';
  }

  return null;
}

export function isLowValueText(stripped: string): boolean {
  return lowValueReason(stripped) !== null;
}

/**
 * Pipeline completo pro ingest: limpa e decide. Devolve o texto limpo quando
 * vale indexar, ou null quando não vale.
 */
export function prepareConversationText(raw: string): string | null {
  const stripped = stripWrappers(raw);
  return lowValueReason(stripped) === null ? stripped : null;
}
