/**
 * Detector de correção do usuário: a mensagem que diz "não era isso" pro passo
 * anterior do assistant. Função pura sobre a sequência de eventos de uma
 * sessão, consumida pelo build:entities (passo `corrections`) e medida contra o
 * gabarito rotulado (workflowMetrics, portão A).
 *
 * Forte: marcador no texto ("já falei", "usa a minha", "faltou X", "vc não
 * atualizou"). Fraco: motivo escrito ao recusar a tool.
 *
 * Interromper, recusar sem motivo e erro de tool NÃO marcam correção sozinhos:
 * no gabarito de 10/11 (60 mensagens rotuladas) a mensagem depois de
 * interromper era correção em 1 de 12, depois de recusa em 0 de 4 e depois de
 * erro em 3 de 12. Quase sempre é o usuário acrescentando contexto ou mudando
 * de assunto. Ficam só como sinal de contexto quando o texto já tem marcador.
 */

export interface SessionEvent {
  uuid: string;
  role: 'user' | 'assistant';
  /** Mensagem de subagente: fica fora (não é a pessoa falando). */
  sidechain?: boolean;
  text: string;
  tools: Array<{ id: string; name: string; errorKind: string | null; snippet: string | null }>;
}

export interface Correction {
  uuid: string;
  level: 'strong' | 'weak';
  signals: string[];
  /** Texto da correção (a mensagem, ou o motivo escrito na recusa). */
  text: string;
  /** ToolCall (último pedido do assistant) ou Message (a resposta) corrigido. */
  target: string | null;
}

/** Sem acento e minúsculo: "Já falei" e "ja falei" casam igual. */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const STRONG_RE =
  /\b(ja (te )?(falei|disse|pedi|expliquei)|eu (falei|disse|pedi) (que|pra|para|isso)|nao (era|e) (isso|bem isso|assim|o que eu)|skill errad|usa(r)? a minha|nao (e|era) pra (usar|fazer|mexer)|para de |pare de |vc errou|voce errou|ta errado|esta errado|de novo isso|nao foi isso que|(vc|voce) nao [a-z]+ou\b)/;
const WEAK_START_RE = /^\s*(nao precisa|errado|faltou|de novo|vc esqueceu|voce esqueceu|esqueceu|nao,|nao nao|na verdade|mas eu (pedi|falei)|nao quero)/;

/** Texto que o harness injeta no papel de usuário e não é fala do usuário. */
function isHarnessText(t: string): boolean {
  const s = t.trimStart();
  // Qualquer tag do harness abrindo a mensagem (<artifact-...>, <system-reminder>...),
  // menos o bloco colado, que é texto do usuário.
  if (/^<[a-z][\w-]*[\s/>]/i.test(s) && !s.startsWith('<pasted_content')) return true;
  return (
    s.startsWith('The fork runs as its own') ||
    s.startsWith('Base directory for this skill') ||
    s.startsWith('Continue from where you left off') ||
    s.startsWith('<command-') ||
    s.startsWith('<local-command') ||
    s.startsWith('<task-notification') ||
    s.startsWith('<system-reminder') ||
    s.startsWith('<bash-') ||
    s.startsWith('Caveat:') ||
    s.startsWith('This session is being continued') ||
    s.startsWith('Another Claude session sent a message') ||
    s.startsWith('[Request interrupted')
  );
}

/** Tira blocos colados: o que conta é o que o usuário escreveu em volta. */
export function ownWords(text: string): string {
  return text
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' ')
    .replace(/\[Image[^\]]*\]/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "continue", "tente novamente": retomada, não correção (mesmo depois de interromper). */
const RESUME_RE = /^(continue|continua|continuar|pode continuar|tente novamente|tenta de novo|segue|pode seguir|sim|ok|s|go)\b[\s.!]*$/;

/** Ferramentas cujo "erro" é fluxo normal de pergunta, não recusa. */
const NOT_A_REJECTION = new Set(['AskUserQuestion']);

/** Motivo que o usuário digitou ao recusar a tool ("... the user said: X"). */
export function rejectionReason(snippet: string | null): string | null {
  const m = /the user said:\s*([\s\S]+)$/i.exec(snippet ?? '');
  const r = m?.[1]?.trim();
  return r && r.length >= 3 ? r : null;
}

/** Marcador no texto: forte em qualquer lugar, leve só no começo. Os dois contam como correção forte. */
export function classifyText(text: string): { level: 'strong'; signal: 'marker' | 'marker_start' } | null {
  const n = normalize(text);
  if (STRONG_RE.test(n)) return { level: 'strong', signal: 'marker' };
  if (WEAK_START_RE.test(n)) return { level: 'strong', signal: 'marker_start' };
  return null;
}

export function detectCorrections(events: SessionEvent[]): Correction[] {
  const out: Correction[] = [];
  let lastToolUse: string | null = null;
  let lastAssistant: string | null = null;
  let rejected = false;
  let errored = false;
  let interrupted = false;

  const toolName = new Map<string, string>();
  for (const ev of events) {
    if (ev.sidechain) continue;
    if (ev.role === 'assistant') {
      lastAssistant = ev.uuid;
      for (const t of ev.tools) {
        if (t.name === 'tool_result') continue;
        lastToolUse = t.id;
        toolName.set(t.id, t.name);
      }
      continue;
    }
    // Evento de usuário que só carrega resultado de tool.
    for (const t of ev.tools) {
      if (t.name !== 'tool_result' || !t.errorKind) continue;
      if (t.errorKind === 'rejected') {
        if (lastToolUse && NOT_A_REJECTION.has(toolName.get(lastToolUse) ?? '')) continue;
        rejected = true;
        const reason = rejectionReason(t.snippet);
        // Recusa com motivo: o motivo É a correção, dentro do próprio resultado.
        if (reason) {
          const byReason = classifyText(reason);
          out.push({
            uuid: ev.uuid,
            level: byReason ? 'strong' : 'weak',
            signals: byReason ? ['rejected', byReason.signal] : ['rejected'],
            text: reason.slice(0, 1000),
            target: lastToolUse,
          });
          rejected = false;
        }
      } else if (t.errorKind === 'interrupted') {
        interrupted = true;
      } else {
        errored = true;
      }
    }
    const raw = ev.text ?? '';
    if (/\[Request interrupted by user/i.test(raw)) {
      interrupted = true;
      continue;
    }
    if (!raw.trim() || isHarnessText(raw)) continue;
    const words = ownWords(raw);
    if (words.length < 3) continue;
    if (RESUME_RE.test(normalize(words))) {
      rejected = false;
      errored = false;
      interrupted = false;
      continue;
    }

    const signals: string[] = [];
    let level: 'strong' | 'weak' | null = null;
    const byText = classifyText(words);
    if (byText) {
      signals.push(byText.signal);
      level = byText.level;
      // Contexto do passo anterior: só anota, não decide.
      if (rejected) signals.push('after_rejection');
      if (interrupted) signals.push('after_interrupt');
      if (errored) signals.push('after_error');
    }
    if (level) {
      out.push({ uuid: ev.uuid, level, signals, text: words.slice(0, 1000), target: lastToolUse ?? lastAssistant });
    }
    rejected = false;
    errored = false;
    interrupted = false;
    lastToolUse = null;
  }
  return out;
}
