import type { QueryLogEntry } from './types.ts';

/**
 * Métricas de USO, separadas da utility.
 *
 * A pergunta "a memória está sendo consultada ao longo da conversa?" não se
 * responde com grade: grade só existe pra busca que aconteceu. Antes disto o
 * único jeito de ver adoção era cruzar query-log com o grafo na mão (medido em
 * 2026-09-29: 53 de 150 sessões com busca, 35%).
 */

/** Janela pra casar um push com um expand do mesmo id. */
const PUSH_EXPAND_WINDOW_MS = 30 * 60 * 1000;

export interface UsageStats {
  windowDays: number;
  sessionsInWindow: number | null;
  sessionsWithSearch: number;
  /** sessões com busca OU ponteiro expandido ÷ sessões na janela */
  adoption: number | null;
  searches: number;
  searchesPerActiveSession: number;
  expands: number;
  pushes: { evaluated: number; fired: number; expanded: number; expandRate: number | null };
}

export function usageStats(
  entries: QueryLogEntry[],
  windowStartIso: string,
  windowDays: number,
  sessionsInWindow: number | null,
): UsageStats {
  const win = entries.filter((e) => e.ts >= windowStartIso);
  const searches = win.filter((e) => e.tool === 'search_memory');
  const expands = win.filter((e) => e.tool === 'expand_hits');
  const pushes = win.filter((e) => e.tool === 'push');
  const fired = pushes.filter((p) => p.hits.length > 0);

  let expanded = 0;
  const activeSessions = new Set(searches.map((e) => e.sessionId).filter((s): s is string => !!s));
  for (const p of fired) {
    const id = p.hits[0]!.id;
    const t = Date.parse(p.ts);
    const hit = expands.some(
      (x) =>
        x.sessionId === p.sessionId &&
        Date.parse(x.ts) > t &&
        Date.parse(x.ts) - t <= PUSH_EXPAND_WINDOW_MS &&
        (x.refChunkIds ?? []).includes(id),
    );
    if (hit) {
      expanded++;
      if (p.sessionId) activeSessions.add(p.sessionId);
    }
  }

  const withSearch = new Set(searches.map((e) => e.sessionId).filter(Boolean)).size;
  return {
    windowDays,
    sessionsInWindow,
    sessionsWithSearch: withSearch,
    adoption: sessionsInWindow ? activeSessions.size / sessionsInWindow : null,
    searches: searches.length,
    searchesPerActiveSession: withSearch > 0 ? searches.length / withSearch : 0,
    expands: expands.length,
    pushes: {
      evaluated: pushes.length,
      fired: fired.length,
      expanded,
      expandRate: fired.length > 0 ? expanded / fired.length : null,
    },
  };
}

export function usageSection(u: UsageStats): string {
  const pct = (v: number | null): string => (v === null ? '-' : `${(v * 100).toFixed(0)}%`);
  return [
    '## uso',
    `- adoção: ${pct(u.adoption)} das ${u.sessionsInWindow ?? '?'} sessões em ${u.windowDays}d (busca ou ponteiro expandido); meta >= 70%`,
    `- buscas: ${u.searches} em ${u.sessionsWithSearch} sessões (${u.searchesPerActiveSession.toFixed(1)}/sessão ativa)`,
    `- expand_hits: ${u.expands} chamadas`,
    `- push: ${u.pushes.fired} ponteiros de ${u.pushes.evaluated} prompts avaliados, ${u.pushes.expanded} expandidos (${pct(u.pushes.expandRate)}); abaixo de 25% o gate está frouxo`,
    '',
  ].join('\n');
}
