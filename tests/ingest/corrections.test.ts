import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyText, detectCorrections, ownWords, rejectionReason } from '../../src/ingest/corrections.ts';
import type { SessionEvent } from '../../src/ingest/corrections.ts';
import { aggregateFlow } from '../../src/mcp/tools/myFlow.ts';
import type { SessionFlow } from '../../src/mcp/tools/myFlow.ts';

const user = (uuid: string, text: string, tools: SessionEvent['tools'] = []): SessionEvent => ({ uuid, role: 'user', text, tools });
const asst = (uuid: string, tools: SessionEvent['tools'] = []): SessionEvent => ({ uuid, role: 'assistant', text: 'ok', tools });
const use = (id: string, name = 'Bash'): SessionEvent['tools'][number] => ({ id, name, errorKind: null, snippet: null });
const result = (id: string, errorKind: string | null, snippet: string | null = null): SessionEvent['tools'][number] => ({
  id,
  name: 'tool_result',
  errorKind,
  snippet,
});

describe('classifyText', () => {
  it('marcador forte com ou sem acento', () => {
    assert.equal(classifyText('Já falei que é pra usar a outra skill')?.level, 'strong');
    assert.equal(classifyText('ja te falei isso')?.level, 'strong');
    assert.equal(classifyText('não era isso que eu pedi')?.level, 'strong');
    assert.equal(classifyText('vc usou a skill errada de novo')?.level, 'strong');
    assert.equal(classifyText('vc não atualizou o PR guarda-chuva')?.signal, 'marker');
  });

  it('marcador leve só no começo, e também conta como forte', () => {
    assert.equal(classifyText('faltou a versão mobile')?.signal, 'marker_start');
    assert.equal(classifyText('não precisa, pode seguir')?.level, 'strong');
    assert.equal(classifyText('pode seguir, não precisa de teste'), null);
  });

  it('pedido normal não é correção', () => {
    assert.equal(classifyText('pode fazer o commit e abrir o PR'), null);
    assert.equal(classifyText('analise a task EDC-1001'), null);
  });
});

describe('detectCorrections', () => {
  it('recusa com motivo vira correção fraca com o motivo como texto', () => {
    const ev = [
      asst('a1', [use('a1::tool::0', 'Edit')]),
      user('u1', '', [result('u1::tool::0', 'rejected', "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said: use o helper que já existe")]),
    ];
    const c = detectCorrections(ev);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.level, 'weak');
    assert.equal(c[0]!.text, 'use o helper que já existe');
    assert.equal(c[0]!.target, 'a1::tool::0');
  });

  it('recusa com motivo que tem marcador vira forte', () => {
    const ev = [
      asst('a1', [use('a1::tool::0', 'Edit')]),
      user('u1', '', [result('u1::tool::0', 'rejected', 'the user said: já falei que é pelo container')]),
    ];
    assert.deepEqual(detectCorrections(ev)[0]!.signals, ['rejected', 'marker']);
  });

  it('mensagem depois de recusa sem motivo, de interromper ou de erro, sem marcador, não é correção', () => {
    const rej = [
      asst('a1', [use('a1::tool::0')]),
      user('u1', '', [result('u1::tool::0', 'rejected', "The user doesn't want to proceed with this tool use.")]),
      user('u2', 'roda pelo container, não local'),
    ];
    const intr = [asst('a1', [use('a1::tool::0')]), user('u1', '[Request interrupted by user]'), user('u2', 'espera, olha o outro arquivo')];
    const err = [asst('a1', [use('a1::tool::0')]), user('u1', '', [result('u1::tool::0', 'exit')]), user('u2', 'não deu, acho que falta auth')];
    assert.equal(detectCorrections(rej).length, 0);
    assert.equal(detectCorrections(intr).length, 0);
    assert.equal(detectCorrections(err).length, 0);
  });

  it('com marcador, o contexto do passo anterior vira sinal extra', () => {
    const ev = [asst('a1', [use('a1::tool::0')]), user('u1', '[Request interrupted by user]'), user('u2', 'já falei que é o outro arquivo')];
    assert.deepEqual(detectCorrections(ev)[0]!.signals, ['marker', 'after_interrupt']);
  });

  it('texto do harness e colado não contam', () => {
    const ev = [
      asst('a1'),
      user('u1', '<command-name>/compact</command-name>'),
      user('u2', 'This session is being continued from a previous conversation'),
      user('u3', '<pasted_content id="x">já falei isso no doc</pasted_content> pode ver'),
    ];
    assert.equal(detectCorrections(ev).length, 0);
  });

  it('retomada depois de interromper não é correção', () => {
    const ev = [asst('a1', [use('a1::tool::0')]), user('u1', '[Request interrupted by user]'), user('u2', 'tente novamente')];
    assert.equal(detectCorrections(ev).length, 0);
  });

  it('resposta do AskUserQuestion não é recusa, e imagem/tag do harness não contam', () => {
    const ev = [
      asst('a1', [use('a1::tool::0', 'AskUserQuestion')]),
      user('u1', '', [result('u1::tool::0', 'rejected', 'The user wants to clarify these questions.')]),
      user('u2', 'prefiro a opção 2'),
      asst('a2'),
      user('u3', '[Image: source: /tmp/x.png]'),
      user('u4', '<artifact-content-authored-by-others/> resumo'),
    ];
    assert.equal(detectCorrections(ev).length, 0);
  });

  it('mensagem de subagente e skill injetada não contam', () => {
    const ev: SessionEvent[] = [
      asst('a1'),
      { ...user('u1', 'já falei que é pra usar o outro arquivo'), sidechain: true },
      user('u2', 'Base directory for this skill: /x/skills/foo  já falei'),
    ];
    assert.equal(detectCorrections(ev).length, 0);
  });

  it('erro de tool seguido de "ok" não é correção', () => {
    const ev = [asst('a1', [use('a1::tool::0')]), user('u1', '', [result('u1::tool::0', 'exit')]), user('u2', 'ok, pode seguir')];
    assert.equal(detectCorrections(ev).length, 0);
  });

  it('ownWords e rejectionReason', () => {
    assert.equal(ownWords('antes <pasted_content id="a">x y z</pasted_content> depois'), 'antes depois');
    assert.equal(rejectionReason('foo the user said: bar baz'), 'bar baz');
    assert.equal(rejectionReason('sem motivo'), null);
  });
});

describe('aggregateFlow', () => {
  const flow = (p: Partial<SessionFlow>): SessionFlow => ({
    id: 's', tasks: [], skills: [], agents: [], errors: [], corrections: [], prStates: [], ...p,
  });

  it('cadeia típica segue os pares mais frequentes', () => {
    const f = aggregateFlow([
      flow({ id: '1', skills: ['scenarios', 'pr-gen', 'qa-check'], tasks: ['EDC-1001'], prStates: ['MERGED'] }),
      flow({ id: '2', skills: ['scenarios', 'pr-gen', 'qa-check'], tasks: ['EDC-1002'], prStates: ['OPEN'] }),
      flow({ id: '3', skills: ['scenarios', 'db-change'], tasks: ['EDC-1002'] }),
    ]);
    assert.deepEqual(f.chain, ['scenarios', 'pr-gen', 'qa-check']);
    assert.equal(f.skillShare[0]!.name, 'scenarios');
    assert.equal(f.skillShare[0]!.pct, 100);
    assert.equal(f.mergedPct, 50);
    assert.equal(f.tasks, 2);
  });

  it('Bash exit fica fora dos hotspots e correção igual com prefixo diferente junta', () => {
    const f = aggregateFlow([
      flow({ errors: [{ where: 'Bash', kind: 'exit' }, { where: 'db-change', kind: 'rejected' }], corrections: ['já falei, usa a outra'] }),
      flow({ corrections: ['❯ já falei, usa a outra'] }),
    ]);
    assert.equal(f.bashExit, 1);
    assert.deepEqual(f.hotspots.map((h) => h.where), ['db-change']);
    assert.equal(f.corrections[0]!.count, 2);
  });

  it('sem sessão devolve vazio sem quebrar', () => {
    const f = aggregateFlow([]);
    assert.equal(f.sessions, 0);
    assert.deepEqual(f.chain, []);
  });
});
