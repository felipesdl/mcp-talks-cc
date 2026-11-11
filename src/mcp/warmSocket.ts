import { createServer, type Server, type ServerResponse } from 'node:http';
import { finished } from 'node:stream';
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
/** Folga entre o prazo do server e o --max-time do curl (escrita + leitura do curl). */
const CLIENT_MARGIN_MS = 120;

/**
 * Prazo desta requisição. O hook manda o --max-time da tentativa em
 * `x-deadline-ms`: no fim do prazo total ele cai pra ~150-300ms, e com os 850ms
 * fixos o server respondia depois de o curl desistir (ou escrevia no buffer bem
 * na hora, e contava como entregue). Sem o header, vale o fixo.
 */
export function budgetFor(header: string | string[] | undefined): number {
  const n = Number(Array.isArray(header) ? header[0] : header);
  if (!Number.isFinite(n) || n <= 0) return BUDGET_MS;
  return Math.max(30, Math.min(BUDGET_MS, n - CLIENT_MARGIN_MS));
}

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

export async function withBudget(p: Promise<PushResult>, budgetMs = BUDGET_MS): Promise<PushResult | null> {
  let timer: NodeJS.Timeout | undefined;
  let late = false;
  const timeout = new Promise<null>((res) => {
    timer = setTimeout(() => {
      late = true;
      res(null);
    }, budgetMs);
  });
  try {
    const r = await Promise.race([p.catch(() => null), timeout]);
    // Prazo estourou: o hook recebe vazio, então o resultado que chegar depois
    // não foi entregue e não pode marcar a sessão nem contar como hit.
    if (late) void p.then((x) => x.settle?.(false), () => {});
    return r;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Responde e só então confirma o push. `finish` = a resposta saiu inteira pro
 * socket com o cliente ainda lá. Cliente que já fechou (curl bateu o
 * --max-time, que pode ser menor que o BUDGET_MS quando o prazo total do hook
 * está no fim) = não entregue.
 */
export function respond(res: ServerResponse, out: string, settle?: (delivered: boolean) => void): void {
  let done = false;
  const finish = (delivered: boolean): void => {
    if (done) return;
    done = true;
    try {
      settle?.(delivered);
    } catch {
      // efeito colateral do push nunca quebra a resposta
    }
  };
  if (res.destroyed || res.socket === null || res.socket.destroyed) {
    finish(false);
    return;
  }
  // erro = fechou antes de terminar (ERR_STREAM_PREMATURE_CLOSE) ou falhou a escrita
  finished(res, (err) => finish(!err));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(out);
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
      let r: PushResult | null = null;
      try {
        const input = JSON.parse(body || '{}') as HookInput;
        const sessionId = input.session_id ?? null;
        const budget = budgetFor(req.headers['x-deadline-ms']);
        if (req.url === '/prompt' && typeof input.prompt === 'string') {
          r = await withBudget(pushForPrompt({ prompt: input.prompt, sessionId, cwd: input.cwd ?? null }), budget);
          out = hookOutput('UserPromptSubmit', r);
        } else if (req.url === '/file') {
          const fp = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
          if (fp) {
            r = await withBudget(pushForFile({ path: fp, sessionId }), budget);
            out = hookOutput('PostToolUse', r);
          }
        }
      } catch {
        out = '';
      }
      // settle só existe quando há aviso (context), então out vazio não confirma nada
      respond(res, out, r?.settle);
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
