import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isHarnessTurn } from '../../src/ingest/quality.ts';
import { pushForPrompt, type PushResult } from '../../src/mcp/push.ts';
import { budgetFor, respond, withBudget } from '../../src/mcp/warmSocket.ts';

describe('push: turno que não é da pessoa', () => {
  const harness = [
    '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>',
    '<system-reminder>\nAs you answer the user questions...\n</system-reminder>',
    'Another Claude session sent a message: termina o deploy',
    'This session is being continued from a previous conversation that ran out of context.',
    'Base directory for this skill: /home/dev/.claude/skills/pr-gen',
    '  <local-command-stdout>ok</local-command-stdout>',
  ];

  for (const t of harness) {
    it(`pula antes de buscar: ${t.slice(0, 30).trim()}`, async () => {
      assert.equal(isHarnessTurn(t), true);
      // Volta antes de tocar em calibração, embedder ou Neo4j.
      assert.deepEqual(await pushForPrompt({ prompt: t, sessionId: 's1', cwd: '/home/dev/code/api-core' }), {
        context: null,
        reason: 'harness',
      });
    });
  }

  it('prompt da pessoa segue pra busca, mesmo abrindo com tag ou com wrapper em volta', () => {
    assert.equal(isHarnessTurn('como a gente resolveu o timeout do hook de push?'), false);
    assert.equal(isHarnessTurn('<pasted_content id="1">log</pasted_content>\nolha esse erro'), false);
    assert.equal(isHarnessTurn('<Button variant="ghost"> não renderiza no modal, pq?'), false);
    assert.equal(isHarnessTurn('<?xml version="1.0"?><config/> esse arquivo tá certo?'), false);
    assert.equal(isHarnessTurn('Caveat: isso só vale no ambiente de teste, certo?'), false);
    assert.equal(isHarnessTurn('<system-reminder>ctx</system-reminder>\ncomo resolvemos o timeout do push?'), false);
  });
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

describe('push: estado só vale se o aviso chegou', () => {
  it('resposta lida pelo cliente confirma a entrega', async () => {
    let settled: (d: boolean) => void = () => {};
    const got = new Promise<boolean>((r) => (settled = r));
    const { server, port } = await serve((_req, res) => respond(res, '{"x":1}', settled));
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ port, host: '127.0.0.1', method: 'POST', path: '/prompt' }, (res) => {
        let b = '';
        res.on('data', (c: Buffer) => (b += c.toString()));
        res.on('end', () => resolve(b));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(body, '{"x":1}');
    assert.equal(await got, true);
    server.close();
  });

  it('cliente que desistiu antes da resposta (curl --max-time) não confirma', async () => {
    let settled: (d: boolean) => void = () => {};
    const got = new Promise<boolean>((r) => (settled = r));
    const { server, port } = await serve((req, res) => {
      req.resume();
      // responde depois de o cliente já ter fechado
      setTimeout(() => respond(res, '{"x":1}', settled), 120);
    });
    await new Promise<void>((resolve) => {
      const req = request({ port, host: '127.0.0.1', method: 'POST', path: '/prompt' });
      req.setTimeout(20, () => req.destroy());
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.end('{}');
    });
    assert.equal(await got, false);
    server.close();
  });

  it('resultado que chega depois do prazo é descartado como não entregue', async () => {
    const calls: boolean[] = [];
    const slow = new Promise<PushResult>((r) =>
      setTimeout(() => r({ context: 'aviso', reason: 'hit', settle: (d) => calls.push(d) }), 60),
    );
    assert.equal(await withBudget(slow, 10), null);
    await slow;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [false]);
  });

  it('prazo do server acompanha o --max-time do curl', () => {
    assert.equal(budgetFor(undefined), 850);
    assert.equal(budgetFor('1000'), 850);
    assert.equal(budgetFor('300'), 180);
    assert.equal(budgetFor('150'), 30);
    assert.equal(budgetFor('lixo'), 850);
  });

  it('dentro do prazo devolve o resultado sem confirmar nada ainda', async () => {
    const calls: boolean[] = [];
    const r = await withBudget(Promise.resolve({ context: 'aviso', reason: 'hit', settle: (d) => calls.push(d) }), 50);
    assert.equal(r?.context, 'aviso');
    assert.deepEqual(calls, []);
  });
});
