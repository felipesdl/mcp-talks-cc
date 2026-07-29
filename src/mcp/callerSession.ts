import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { learningPaths } from '../learning/paths.ts';

/**
 * Quem está chamando o MCP.
 *
 * O Claude Code não passa o session id pro processo MCP (stdio child). Sem ele,
 * o grader do self-tune só tem o join por time-window, que é ambíguo e falha
 * fácil: sem sinal de echo, o loop de tuning nunca fecha.
 *
 * Conserto: o hook SessionStart (scripts/session-primer.sh) recebe o JSON do
 * hook no stdin e grava sessions/<slug-do-cwd>.json. O MCP roda com cwd igual
 * ao da sessão, então resolve o próprio caller por esse arquivo.
 */

const CACHE_MS = 5_000;
const MAX_AGE_MS = 24 * 3600 * 1000; // registro velho = sessão provavelmente morta

export interface CallerSession {
  sessionId: string | null;
  project: string | null;
}

/** Mesmo slug do lado bash (`tr -c '[:alnum:]' '-'`). */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function sessionFileFor(cwd: string): string {
  return join(learningPaths.sessionsDir, `${cwdSlug(cwd)}.json`);
}

let _cached: CallerSession = { sessionId: null, project: null };
let _lastCheck = 0;
let _lastMtimeMs = -1;

export function resolveCallerSession(cwd: string = process.cwd()): CallerSession {
  const envId = process.env.CLAUDE_SESSION_ID;
  if (envId) return { sessionId: envId, project: cwd };

  const now = Date.now();
  if (now - _lastCheck < CACHE_MS) return _cached;
  _lastCheck = now;

  const file = sessionFileFor(cwd);
  try {
    const st = statSync(file);
    if (st.mtimeMs === _lastMtimeMs) return _cached;
    _lastMtimeMs = st.mtimeMs;
    if (now - st.mtimeMs > MAX_AGE_MS) {
      _cached = { sessionId: null, project: cwd };
      return _cached;
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    _cached = {
      sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
      project: typeof raw.project === 'string' && raw.project ? raw.project : cwd,
    };
  } catch {
    _lastMtimeMs = -1;
    _cached = { sessionId: null, project: cwd };
  }
  return _cached;
}

/** Só p/ testes. */
export function resetCallerSessionCache(): void {
  _cached = { sessionId: null, project: null };
  _lastCheck = 0;
  _lastMtimeMs = -1;
}
