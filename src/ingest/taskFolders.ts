/**
 * Pasta de trabalho por task (`<TASKS_HOME>/<id>/`). Funções puras: o ingest,
 * o build:entities, o sync de PRs, o gc e o CLI task-folder consomem daqui.
 *
 * O id é a key do Jira (`EDC-1234`) ou um provisório enquanto a task não
 * existe, normalmente o nome do worktree (`wip-1110-135228`). Quando a task
 * aparece, a pasta é renomeada pra key e o id antigo vira alias no meta.json;
 * o build:entities junta o nó provisório no da task.
 */

import { taskKeyFromSlug, taskKeysFromText, taskKeyFromBranch } from './entities.ts';

/** Nome de pasta aceito como id: sem barra, sem espaço, sem começar com ponto. */
const FOLDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/;

export function isTaskFolderId(name: string): boolean {
  return FOLDER_ID_RE.test(name);
}

/** Key do Jira quando o id é uma; senão o próprio id (provisório). */
export function taskNodeKey(id: string): { key: string; provisional: boolean } {
  // Só vale como key se o id INTEIRO é a key: `EDC-1234-notas` não deve virar EDC-1234.
  const jira = /^[A-Za-z]{2,6}-\d{1,6}$/.test(id) ? taskKeyFromSlug(id) : null;
  if (jira) return { key: jira, provisional: false };
  return { key: id, provisional: true };
}

export interface TaskMeta {
  id: string;
  aliases: string[];
  repos: string[];
  branches: string[];
  worktrees: string[];
  createdAt: string | null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))];
}

/**
 * meta.json tolerante: arquivo ausente, quebrado ou com campo errado vira meta
 * vazio com o id da pasta. O nome da pasta manda no id (é o que o gc e o
 * rename enxergam), o campo `id` do arquivo só é informativo.
 */
export function parseTaskMeta(raw: string | null, folderName: string): TaskMeta {
  let o: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) o = parsed as Record<string, unknown>;
    } catch {
      // meta quebrado não derruba o ingest
    }
  }
  return {
    id: folderName,
    aliases: strList(o.aliases).filter((a) => a !== folderName),
    repos: strList(o.repos),
    branches: strList(o.branches),
    worktrees: strList(o.worktrees),
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : null,
  };
}

// ── Limpeza ────────────────────────────────────────────────────────────────

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

export type GcDecision =
  | { action: 'delete'; reason: 'merged' | 'idle' }
  | { action: 'keep'; reason: 'not-ingested' | 'open-pr' | 'active' };

/**
 * Quando a pasta sai. Nunca antes de o conteúdo estar no grafo (a pasta é
 * descartável, a memória não).
 *
 * - Todos os PRs da task mergeados: merge é deploy, a task acabou.
 * - Sem mexer há `idleLimit` dias e sem PR aberto: pesquisa que não virou nada,
 *   PR fechado sem substituto, task abandonada. O conteúdo já está na memória.
 */
export function gcDecision(input: {
  ingested: boolean;
  prStates: PrState[];
  idleDays: number;
  idleLimit: number;
}): GcDecision {
  if (!input.ingested) return { action: 'keep', reason: 'not-ingested' };
  if (input.prStates.length > 0 && input.prStates.every((s) => s === 'MERGED')) {
    return { action: 'delete', reason: 'merged' };
  }
  // PR aberto é task viva, mesmo parada em review: vem antes do idle.
  if (input.prStates.includes('OPEN')) return { action: 'keep', reason: 'open-pr' };
  if (input.idleDays >= input.idleLimit) return { action: 'delete', reason: 'idle' };
  return { action: 'keep', reason: 'active' };
}

// ── PRs ────────────────────────────────────────────────────────────────────

/**
 * O PR é da task quando a key está no título (padrão `[KEY] - título`) ou na
 * branch. A busca do GitHub é por texto e devolve `EDC-12345` pra `EDC-1234`,
 * então a confirmação é por regex com fronteira.
 */
export function prMatchesTask(title: string, branch: string | null, key: string): boolean {
  if (taskKeysFromText(title).includes(key)) return true;
  // título com mais de 5 keys cai no corte anti-backlog; confere direto
  const re = new RegExp(`(^|[^A-Za-z0-9])${key.replace('-', '-0*')}(?!\\d)`, 'i');
  if (re.test(title)) return true;
  return taskKeyFromBranch(branch) === key;
}

export interface PrLite {
  key: string;
  repo: string;
  state: PrState;
  createdAt: string;
}

/**
 * PR fechado sem merge seguido de outro PR da mesma task no mesmo repo: o
 * seguinte substitui o fechado. Só o imediatamente seguinte, pra cadeia
 * A(fechado) -> B(fechado) -> C virar C->B->A e não C->A.
 */
export function replacementPairs(prs: PrLite[]): Array<{ newer: string; older: string }> {
  const byRepo = new Map<string, PrLite[]>();
  for (const p of prs) {
    if (!byRepo.has(p.repo)) byRepo.set(p.repo, []);
    byRepo.get(p.repo)!.push(p);
  }
  const out: Array<{ newer: string; older: string }> = [];
  for (const list of byRepo.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i]!.state === 'CLOSED') out.push({ newer: list[i + 1]!.key, older: list[i]!.key });
    }
  }
  return out;
}
