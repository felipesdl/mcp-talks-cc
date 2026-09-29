import { createServer, type Server } from 'node:http';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { learningPaths } from '../learning/paths.ts';
import { pushForFile, pushForPrompt, type PushResult } from './push.ts';

/**
 * Caminho quente pros hooks de push.
 *
 * Hook é processo novo a cada disparo: carregar o bge-m3 ali custaria 1-60s por
 * prompt. O MCP server já tem o embedder e o driver quentes, então ele expõe um
 * unix socket local e o hook só faz `curl --unix-socket`. Cada sessão do Claude
 * Code sobe o próprio server, e qualquer um serve (a busca não depende de quem
 * chama; o estado de dedup mora em arquivo por sessionId).
 *
 * O server devolve o JSON de saída do hook pronto, ou corpo vazio. Assim o
 * bash não precisa escapar JSON nenhum.
 *
 * Tudo aqui é fail-open: erro, timeout ou Neo4j fora viram corpo vazio.
 */

export const SOCK_DIR = join(learningPaths.cacheDir, 'sock');
/** Abaixo do timeout do curl no hook (1s): responde vazio antes de o hook desistir. */
const BUDGET_MS = 850;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupStale(): void {
  try {
    for (const f of readdirSync(SOCK_DIR)) {
      const pid = Number(f.replace(/\.sock$/, ''));
      if (Number.isFinite(pid) && pid !== process.pid && !pidAlive(pid)) {
        try {
          unlinkSync(join(SOCK_DIR, f));
        } catch {
          // outro server limpou antes
        }
      }
    }
  } catch {
    // dir ainda não existe
  }
}

function hookOutput(event: string, r: PushResult | null): string {
  if (!r?.context) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: r.context } });
}

async function withBudget(p: Promise<PushResult>): Promise<PushResult | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), BUDGET_MS);
  });
  try {
    return await Promise.race([p.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface HookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string };
}

export function startWarmSocket(): Server | null {
  try {
    mkdirSync(SOCK_DIR, { recursive: true });
  } catch {
    return null;
  }
  cleanupStale();
  const path = join(SOCK_DIR, `${process.pid}.sock`);

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
      if (body.length > 256_000) req.destroy();
    });
    req.on('end', async () => {
      let out = '';
      try {
        const input = JSON.parse(body || '{}') as HookInput;
        const sessionId = input.session_id ?? null;
        if (req.url === '/prompt' && typeof input.prompt === 'string') {
          const r = await withBudget(
            pushForPrompt({ prompt: input.prompt, sessionId, cwd: input.cwd ?? null }),
          );
          out = hookOutput('UserPromptSubmit', r);
        } else if (req.url === '/file') {
          const fp = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
          if (fp) out = hookOutput('PostToolUse', await withBudget(pushForFile({ path: fp, sessionId })));
        }
      } catch {
        out = '';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(out);
    });
  });
  server.on('error', (e) => console.error('[warm] socket error:', e.message));
  try {
    unlinkSync(path);
  } catch {
    // não existia
  }
  server.listen(path, () => console.error(`[warm] push socket em ${path}`));
  // o socket nunca segura o processo vivo: quem manda no ciclo de vida é o stdio
  server.unref();
  const close = (): void => {
    try {
      unlinkSync(path);
    } catch {
      // já foi
    }
  };
  process.on('exit', close);
  return server;
}
