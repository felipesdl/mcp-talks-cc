/**
 * Sinais que saem das chamadas de tool: qual skill/agente foi usado, qual slash
 * command o usuário digitou e que tipo de erro a tool devolveu. Funções puras,
 * consumidas pelo ingest (dado exato do transcript) e pelo backfill do
 * build:entities (sessões cujo .jsonl já foi podado, só com o snippet gravado).
 */

export type ErrorKind = 'rejected' | 'interrupted' | 'hook' | 'tool_error' | 'exit' | 'other';

const REJECTED_RE =
  /The user doesn't want to (proceed with this tool use|take this action)|tool use was rejected|user rejected|Permission to use .* (was )?denied/i;
const INTERRUPTED_RE = /\[Request interrupted by user/i;
const HOOK_RE = /\b(PreToolUse|PostToolUse|UserPromptSubmit)\b.*\b(hook|blocked|denied)\b|\bblocked by (a )?hook\b|\bhook (error|blocked|denied)\b/i;
const TOOL_ERROR_RE = /<tool_use_error>/;
const EXIT_RE = /^\s*Exit code ([1-9]\d*)\b/;

/**
 * Tipo do erro de uma tool.
 *
 * - `isErrorFlag === true`: o transcript marcou erro; classifica o motivo.
 * - `isErrorFlag === null`: flag desconhecido (sessão podada). Só devolve tipo
 *   quando o texto prova o erro sozinho; `other` nunca sai daqui, porque sem o
 *   flag não dá pra distinguir saída normal de erro genérico.
 * - `isErrorFlag === false`: não é erro.
 */
/**
 * Tipos que podem ser inferidos só pelo texto, sem o flag. Medido no portão A
 * (workflowMetrics gate, 10/11/2026) contra o is_error dos transcripts:
 * exit 100%, tool_error 100%, rejected 98,6%. hook (78,6%) e interrupted (0/1)
 * ficaram abaixo do corte de 90% e só contam onde o transcript tem o flag.
 */
export const TEXT_INFERABLE: ReadonlySet<ErrorKind> = new Set(['exit', 'tool_error', 'rejected']);

export function classifyToolError(text: string | null | undefined, isErrorFlag: boolean | null): ErrorKind | null {
  if (isErrorFlag === false) return null;
  if (isErrorFlag === null) {
    const k = classifyToolError(text, true);
    return k && TEXT_INFERABLE.has(k) ? k : null;
  }
  const t = text ?? '';
  if (REJECTED_RE.test(t)) return 'rejected';
  if (INTERRUPTED_RE.test(t)) return 'interrupted';
  if (TOOL_ERROR_RE.test(t)) return 'tool_error';
  if (HOOK_RE.test(t)) return 'hook';
  if (EXIT_RE.test(t)) return 'exit';
  return isErrorFlag ? 'other' : null;
}

function jsonField(snippet: string | null | undefined, field: string): string | null {
  if (!snippet) return null;
  try {
    const o = JSON.parse(snippet) as Record<string, unknown>;
    const v = o?.[field];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    // snippet cortado em 500 chars: cai pro regex
    const m = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(snippet);
    return m?.[1]?.trim() || null;
  }
}

/** Nome da skill a partir do input serializado da tool `Skill`. */
export function skillFromSnippet(snippet: string | null | undefined): string | null {
  const s = jsonField(snippet, 'skill');
  return s ? s.replace(/^\//, '') : null;
}

/** Tipo do subagente a partir do input da tool `Agent`/`Task`. Sem tipo = general-purpose. */
export function agentFromSnippet(snippet: string | null | undefined): string {
  return jsonField(snippet, 'subagent_type') ?? 'general-purpose';
}

const COMMAND_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;

/** Slash command digitado pelo usuário (`<command-name>/x</command-name>`). */
export function slashFromText(text: string | null | undefined): string | null {
  const m = COMMAND_RE.exec(text ?? '');
  return m ? m[1]! : null;
}

/** Comandos do próprio Claude Code: viram Skill { kind: 'command' }, não skill. */
export const BUILTIN_COMMANDS = new Set([
  'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'effort', 'exit', 'export', 'help',
  'hooks', 'ide', 'init', 'login', 'logout', 'mcp', 'memory', 'model', 'permissions', 'plugin',
  'plugins', 'rate-limit-options', 'recap', 'release-notes', 'reload-plugins', 'reload-skills',
  'resume', 'review', 'rewind', 'status', 'statusline', 'terminal-setup', 'theme', 'todos', 'usage',
  'vim', 'agents', 'add-dir', 'bug', 'feedback', 'fast', 'artifacts', 'loop', 'schedule',
]);

export const AGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * Pareamento por posição: o resultado no índice j da mensagem de usuário é a
 * resposta do pedido no índice j da mensagem do assistant que ela responde
 * (`parentUuid`). Usado onde não há `tool_use_id` (sessão podada) e medido
 * contra o pareamento exato no workflowMetrics (portão A).
 */
export const POSITION_PAIRING_CYPHER = `
  MATCH (rm:Message)-[:INVOKED]->(res:ToolCall { name: 'tool_result' })
  WHERE $onlyUnpaired = false OR NOT (res)-[:RESULT_OF]->()
  MATCH (am:Message { uuid: rm.parentUuid })-[:INVOKED]->(use:ToolCall) WHERE use.name <> 'tool_result'
  WITH res, use ORDER BY toInteger(split(use.id, '::tool::')[1])
  WITH res, collect(use.id) AS uses, toInteger(split(res.id, '::tool::')[1]) AS j
  WHERE j < size(uses)
  RETURN res.id AS res, uses[j] AS use`;
