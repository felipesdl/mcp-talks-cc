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
  // o assistant repassando o aviso do primer pro user ("Antes de tudo, um aviso
  // do mcp-talks-cc: tem uma proposta de tuning..."). Voltava como hit nº 1 de
  // busca sobre o próprio MCP. Só a LINHA sai: o resto da mensagem é conteúdo.
  /^.*\baviso do mcp-talks-cc\b.*$/gim,
  /^.*\bproposta de tuning\b.*\b(?:esperando|pendente|aguardando)\b.*$/gim,
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

/**
 * Sinais lexicais do texto, expostos para o classificador de valor reaproveitar
 * o mesmo critério em vez de reescrevê-lo.
 *
 * `payload` é o veto da demoção na busca: chunk com bloco de código, bullet,
 * `porque`/`because` ou seta entrega alguma coisa, e não é rebaixado por mais
 * que o modelo diga o contrário. É a defesa barata contra o overlap de 150
 * chars do chunker, que faz um pedaço COMEÇAR com cauda de anúncio e mesmo
 * assim entregar conteúdo.
 */
export function lexicalHints(text: string): {
  announcement: boolean;
  payload: boolean;
  contentSignal: boolean;
} {
  return {
    announcement: ANNOUNCEMENT_RE.test(text),
    payload: PAYLOAD_RE.test(text),
    contentSignal: CONTENT_SIGNAL_RE.test(text),
  };
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

/** Tamanho do gist na saída brief das tools. ~40 tokens. */
export const GIST_CHARS = 160;

/**
 * Resumo de 1 linha pra saída brief: o suficiente pro modelo decidir se expande.
 *
 * Tira wrapper, marcação markdown e a frase de anúncio do começo (a cauda de
 * overlap do chunker costuma começar com "vou verificar X"), e corta em limite
 * de palavra. Sem LLM e sem I/O: roda por hit no hot path.
 */
export function gistOf(text: string, max: number = GIST_CHARS): string {
  let t = stripWrappers(text)
    .replace(/```[\s\S]*?```/g, ' [código] ')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Chunk que não é o primeiro da mensagem começa com a cauda de 150 chars do
  // overlap, muitas vezes no meio de uma palavra ("iveCandidatesOnFreight`").
  // Começo em minúscula = fragmento: pula até a primeira fronteira de frase.
  if (/^[a-zà-ú`),.;]/.test(t)) {
    const m = /[.!?:]\s+(?=\S)|\s-\s/.exec(t.slice(0, 220));
    if (m && m.index + m[0].length < t.length - 20) t = t.slice(m.index + m[0].length);
  }
  // pula anúncios iniciais, mantendo pelo menos uma frase
  for (let i = 0; i < 2; i++) {
    const m = /^(.{10,200}?[.:!?])\s+(.+)$/.exec(t);
    if (!m || !ANNOUNCEMENT_RE.test(m[1]!) || PAYLOAD_RE.test(m[1]!)) break;
    t = m[2]!;
  }
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}
