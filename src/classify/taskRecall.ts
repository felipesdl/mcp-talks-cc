import { createHash } from 'node:crypto';
import type { Session } from 'neo4j-driver';
import { searchMemory } from '../mcp/tools/searchMemory.ts';

/**
 * Invariante POPULACIONAL de recuperação, gerado dos dados.
 *
 * Não é fixture de casos: a população é toda sessão cuja `gitBranch` carrega um
 * código de task, e ela cresce sozinha conforme o trabalho acontece. Fixture
 * curada envelhece e vira superficial; uma taxa sobre a população inteira não.
 *
 * O rótulo mora no grafo (`Session.gitBranch`), não nos arquivos de transcript,
 * então o teste NÃO decai com a poda de 90 dias do Claude Code — 373 das 609
 * sessões já não existem em disco e continuam valendo aqui.
 *
 * Duas métricas, e confundi-las é o erro fácil:
 *
 *  - `hitRate` é ANTI-REGRESSÃO. Buscar `EDC-3197` casa LITERAL_TOKEN_RE e liga
 *    o caminho lexical, que a demoção por valor quase não toca. Ele prova que
 *    nada quebrou, e NÃO mede o benefício. Um teste que não pode falhar pela
 *    mudança em questão dá falsa segurança.
 *  - `narrationShare` é o BENEFÍCIO: quanto do que voltou é narração de
 *    processo. É esse que precisa cair.
 */

export interface RecallResult {
  n: number;
  hitRate: number;
  mrr: number;
  narrationShare: number;
  misses: string[];
}

/** Abaixo disto o chunk é narração, segundo o classificador de valor. */
const NARRATION_BELOW = 0.3;

export interface TaskTarget {
  ticket: string;
  sessions: string[];
}

export async function taskTargets(s: Session): Promise<TaskTarget[]> {
  const r = await s.run(`
    MATCH (se:Session) WHERE se.gitBranch =~ '.*[A-Z]{2,6}-[0-9]+.*'
    RETURN se.id AS id, se.gitBranch AS branch ORDER BY se.id
  `);
  const byTicket = new Map<string, string[]>();
  for (const rec of r.records) {
    const t = /[A-Z]{2,6}-\d+/.exec(String(rec.get('branch')))?.[0];
    if (!t) continue;
    if (!byTicket.has(t)) byTicket.set(t, []);
    byTicket.get(t)!.push(rec.get('id') as string);
  }
  return [...byTicket.entries()]
    .map(([ticket, sessions]) => ({ ticket, sessions }))
    .sort((a, b) => (a.ticket < b.ticket ? -1 : 1));
}

/**
 * Amostra determinística por passo, não aleatória: reprodutível sem semente e
 * estável enquanto a população não mudar muito.
 */
export function sampleTargets(all: TaskTarget[], oneIn: number): TaskTarget[] {
  return all.filter((_, i) => i % oneIn === 0);
}

export async function measureRecall(targets: TaskTarget[], k = 8): Promise<RecallResult> {
  let hits = 0;
  let rrSum = 0;
  let narration = 0;
  let total = 0;
  const misses: string[] = [];

  for (const { ticket, sessions } of targets) {
    // Chamada direta, sem passar pelo cliente MCP: evita centenas de
    // round-trips de stdio e, sobretudo, evita gravar no query-log, que
    // alimenta a CDF de vec_score do self-tune. Um bench de 148 buscas
    // sintéticas envenenaria a calibração inteira.
    const { hits: found } = await searchMemory({ query: ticket, k });
    const rank = found.findIndex((h) => h.sessionId !== null && sessions.includes(h.sessionId));
    if (rank >= 0) {
      hits++;
      rrSum += 1 / (rank + 1);
    } else {
      misses.push(ticket);
    }
    for (const h of found) {
      total++;
      if (h.value_score !== null && h.value_score < NARRATION_BELOW) narration++;
    }
  }

  return {
    n: targets.length,
    hitRate: targets.length > 0 ? hits / targets.length : 0,
    mrr: targets.length > 0 ? rrSum / targets.length : 0,
    narrationShare: total > 0 ? narration / total : 0,
    misses,
  };
}

/** Só para diagnóstico: identifica a fatia mais antiga, que é onde dói. */
export function digest(r: RecallResult): string {
  return [
    `tasks       : ${r.n}`,
    `hitRate@8   : ${(r.hitRate * 100).toFixed(1)}%`,
    `MRR         : ${r.mrr.toFixed(3)}`,
    `narração@8  : ${(r.narrationShare * 100).toFixed(1)}%`,
    `falhas      : ${r.misses.slice(0, 12).join(', ')}${r.misses.length > 12 ? ` (+${r.misses.length - 12})` : ''}`,
  ].join('\n  ');
}

export { createHash };
