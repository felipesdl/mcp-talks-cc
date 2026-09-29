// Formato de saída das tools, pensado pra custo de contexto.
//
// O Claude Code entrega o `structuredContent` ao modelo como JSON quando ele
// existe, no lugar do `content` texto. Medido em 2026-09-29: search_memory com
// k=5 voltou ~6.5KB de JSON, com `neighbors` inteiros (800 chars cada), ~1.8k
// tokens por busca. Com esse preço o modelo evita buscar de novo no meio da
// conversa, que é justamente quando a memória mais ajuda.
//
// Por isso structuredContent só sai com MCP_TALKS_STRUCTURED=1 (a suite liga,
// pra poder inspecionar os hits), e o texto default é brief: 1 linha por hit,
// o suficiente pra decidir se vale `expand_hits`.

export const STRUCTURED = process.env.MCP_TALKS_STRUCTURED === '1';

/** Prefixo do id do chunk aceito por expand_hits (sha1 = 40 hex). */
export const SHORT_ID_LEN = 12;

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LEN);
}

export function projectName(path: string | null): string {
  if (!path) return '-';
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function day(ts: string | null): string {
  return ts ? ts.slice(0, 10) : '-';
}

export function fmtConf(c: number | null): string {
  return c === null ? 'n/a' : c.toFixed(2);
}

/** Adiciona structuredContent só quando ligado. */
export function withStructured<T extends object>(
  base: { content: Array<{ type: 'text'; text: string }>; isError?: boolean },
  structured: T,
): typeof base & { structuredContent?: T } {
  return STRUCTURED ? { ...base, structuredContent: structured } : base;
}
