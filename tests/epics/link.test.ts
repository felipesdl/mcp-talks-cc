import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBucketTitle, parentRefsFromText, parseTaskLines } from '../../src/ingest/entities.ts';
import { bestPerTask, buildLlmInput, needsLlm, regexLinks, worthLlm } from '../../src/epics/link.ts';
import type { Link, Unit } from '../../src/epics/link.ts';

function unit(p: Partial<Unit>): Unit {
  return { kind: 'session', id: 's1', project: '/r/web-panel', tasks: [], texts: [], lastTs: '2026-10-01', llmVersion: 0, llmAt: null, ...p };
}

function link(p: Partial<Link>): Link {
  return {
    task: 'EDC-1', parent: 'EDC-2', parentType: 'epic', parentTitle: null, bucketHint: null,
    relates: [], source: 'regex', confidence: 'medium', unit: 's1', at: '2026-10-01', ...p,
  };
}

describe('parseTaskLines', () => {
  it('lê a linha do pré-prompt com tipo e título do pai', () => {
    assert.deepEqual(parseTaskLines('ok\n[task] EDC-1002 pai=EDC-1001 (Epic: Checkout V2)\n'), [
      { task: 'EDC-1002', parent: 'EDC-1001', parentType: 'epic', parentTitle: 'Checkout V2' },
    ]);
  });
  it('aceita pai ausente e story', () => {
    assert.deepEqual(parseTaskLines('[task] EDC-1 pai=-'), [{ task: 'EDC-1', parent: null, parentType: null, parentTitle: null }]);
    assert.equal(parseTaskLines('[task] US-10 pai=US-2 (História: Fluxo X)')[0]!.parentType, 'story');
  });
  it('normaliza e respeita a allowlist', () => {
    assert.equal(parseTaskLines('[task] edc-0099 pai=EDC-0012')[0]!.task, 'EDC-99');
    assert.deepEqual(parseTaskLines('[task] NR-12 pai=EDC-1'), []);
    assert.deepEqual(parseTaskLines('[task] EDC-5 pai=EDC-5'), []);
  });
});

describe('parentRefsFromText', () => {
  it('pega key logo depois de épico/epic/parent, com markdown no meio', () => {
    assert.deepEqual(parentRefsFromText('Épico EDC-1001 (Checkout V2)'), ['EDC-1001']);
    assert.deepEqual(parentRefsFromText('- **Parent:** EDC-900 Q2.1'), ['EDC-900']);
    assert.deepEqual(parentRefsFromText('Epic: EDC-800 | História: EDC-801'), ['EDC-800']);
  });
  it('não confunde "pai" dentro de palavra nem key sem gatilho', () => {
    assert.deepEqual(parentRefsFromText('no painel EDC-1100 e no país EDC-1101'), []);
  });
});

describe('isBucketTitle', () => {
  it('reconhece epic balde', () => {
    assert.equal(isBucketTitle('[Q3.2] Débitos técnicos'), true);
    assert.equal(isBucketTitle('Bugs 2026'), true);
    assert.equal(isBucketTitle('Q3.2 | Checkout V2: cupom no carrinho'), false);
    assert.equal(isBucketTitle(null), false);
  });
});

describe('regexLinks', () => {
  it('só liga com 1 task na unidade e 1 pai citado', () => {
    const u = unit({ tasks: ['EDC-1003'], texts: ['Épico EDC-1001 (Checkout V2)'] });
    assert.equal(regexLinks(u)[0]!.parent, 'EDC-1001');
    assert.deepEqual(regexLinks(unit({ tasks: ['EDC-1', 'EDC-2'], texts: ['Épico EDC-1001'] })), []);
    assert.deepEqual(regexLinks(unit({ tasks: ['EDC-1'], texts: ['Épico EDC-1001 e epic EDC-1004'] })), []);
  });
});

describe('fila do Haiku', () => {
  it('worthLlm exige key perto da palavra de hierarquia', () => {
    assert.equal(worthLlm(unit({ texts: ['a task EDC-1002 é do épico de checkout'] })), true);
    assert.equal(worthLlm(unit({ texts: ['meu pai disse oi ' + 'x'.repeat(200) + ' EDC-1'] })), false);
  });
  it('needsLlm pula unidade com linha [task] e reprocessa sessão que cresceu', () => {
    assert.equal(needsLlm(unit({ texts: ['[task] EDC-1 pai=EDC-2'] })), false);
    assert.equal(needsLlm(unit({ llmVersion: 1, llmAt: '2026-10-01', lastTs: '2026-10-01' })), false);
    assert.equal(needsLlm(unit({ llmVersion: 1, llmAt: '2026-10-01', lastTs: '2026-10-02' })), true);
  });
  it('buildLlmInput manda só as janelas com key', () => {
    const t = 'x'.repeat(2000) + ' Épico EDC-1001 ' + 'y'.repeat(2000) + ' story sem key ' + 'z'.repeat(2000);
    const input = buildLlmInput(unit({ texts: [t] }));
    assert.ok(input.includes('EDC-1001'));
    assert.ok(!input.includes('story sem key'));
    assert.ok(input.length < 1000);
  });
});

describe('bestPerTask', () => {
  it('fonte de rank maior vence, empate vai pro mais recente', () => {
    const r = bestPerTask([
      link({ parent: 'EDC-2', source: 'regex' }),
      link({ parent: 'EDC-3', source: 'prompt', confidence: 'high' }),
      link({ task: 'EDC-9', parent: 'EDC-4', source: 'haiku', at: '2026-10-01' }),
      link({ task: 'EDC-9', parent: 'EDC-5', source: 'haiku', at: '2026-10-05' }),
    ]);
    assert.equal(r.find((l) => l.task === 'EDC-1')!.parent, 'EDC-3');
    assert.equal(r.find((l) => l.task === 'EDC-9')!.parent, 'EDC-5');
  });
});
