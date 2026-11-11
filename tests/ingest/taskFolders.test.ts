import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectPath } from '../../src/ingest/entities.ts';
import {
  gcDecision,
  isTaskFolderId,
  parseTaskMeta,
  prMatchesTask,
  replacementPairs,
  taskNodeKey,
} from '../../src/ingest/taskFolders.ts';
import { isRepoDocPath } from '../../src/ingest/sources/repoDocs.ts';
import { researchTitle } from '../../src/ingest/sources/research.ts';

describe('normalizeProjectPath', () => {
  const exists = (p: string): boolean => p === '/home/dev/code/api-core';

  it('worktree do Orca aponta pro repo em codeHome', () => {
    const r = normalizeProjectPath('/home/dev/orca/workspaces/api-core/wip-1110-135228', '/home/dev/code', exists);
    assert.deepEqual(r, {
      repoPath: '/home/dev/code/api-core',
      worktree: '/home/dev/orca/workspaces/api-core/wip-1110-135228',
      worktreeName: 'wip-1110-135228',
    });
  });

  it('subpasta do worktree guarda a raiz do worktree, não o cwd', () => {
    const r = normalizeProjectPath('/home/dev/orca/workspaces/api-core/EDC-1001/app/Models', '/home/dev/code', exists);
    assert.equal(r.worktree, '/home/dev/orca/workspaces/api-core/EDC-1001');
    assert.equal(r.worktreeName, 'EDC-1001');
  });

  it('repo que não existe em codeHome colapsa pro diretório do workspace', () => {
    const r = normalizeProjectPath('/home/dev/orca/workspaces/web-panel/wip-1', '/home/dev/code', exists);
    assert.equal(r.repoPath, '/home/dev/orca/workspaces/web-panel');
  });

  it('worktree do Claude Code aponta pro próprio repo', () => {
    const r = normalizeProjectPath('/home/dev/code/api-core/.claude/worktrees/fix-x', '/home/dev/code', exists);
    assert.equal(r.repoPath, '/home/dev/code/api-core');
    assert.equal(r.worktreeName, 'fix-x');
  });

  it('cwd comum fica como está', () => {
    assert.deepEqual(normalizeProjectPath('/home/dev/code/api-core', '/home/dev/code', exists), {
      repoPath: '/home/dev/code/api-core',
      worktree: null,
      worktreeName: null,
    });
  });
});

describe('id de pasta', () => {
  it('aceita key e provisório, recusa caminho e oculto', () => {
    assert.ok(isTaskFolderId('EDC-1001'));
    assert.ok(isTaskFolderId('wip-1110-135228'));
    assert.ok(!isTaskFolderId('.git'));
    assert.ok(!isTaskFolderId('a/b'));
    assert.ok(!isTaskFolderId('x'));
  });

  it('só o id inteiro vira key do Jira', () => {
    assert.deepEqual(taskNodeKey('EDC-1001'), { key: 'EDC-1001', provisional: false });
    assert.deepEqual(taskNodeKey('edc-01001'), { key: 'EDC-1001', provisional: false });
    assert.deepEqual(taskNodeKey('EDC-1001-notas'), { key: 'EDC-1001-notas', provisional: true });
    assert.deepEqual(taskNodeKey('wip-1110-135228'), { key: 'wip-1110-135228', provisional: true });
  });
});

describe('parseTaskMeta', () => {
  it('meta ausente ou quebrado vira vazio com o id da pasta', () => {
    assert.equal(parseTaskMeta(null, 'wip-1').id, 'wip-1');
    assert.deepEqual(parseTaskMeta('{quebrado', 'wip-1').branches, []);
    assert.deepEqual(parseTaskMeta('[1,2]', 'wip-1').aliases, []);
  });

  it('nome da pasta manda no id; alias igual ao id sai; listas sem repetição', () => {
    const m = parseTaskMeta(
      JSON.stringify({ id: 'outro', aliases: ['EDC-1001', 'wip-1'], branches: ['b', 'b', 3], repos: ['api-core'] }),
      'EDC-1001',
    );
    assert.equal(m.id, 'EDC-1001');
    assert.deepEqual(m.aliases, ['wip-1']);
    assert.deepEqual(m.branches, ['b']);
  });
});

describe('gcDecision', () => {
  const base = { ingested: true, prStates: [] as Array<'OPEN' | 'MERGED' | 'CLOSED'>, idleDays: 0, idleLimit: 30 };

  it('nunca apaga o que não foi ingerido', () => {
    assert.equal(gcDecision({ ...base, ingested: false, prStates: ['MERGED'], idleDays: 99 }).action, 'keep');
  });

  it('todos os PRs mergeados apaga', () => {
    assert.deepEqual(gcDecision({ ...base, prStates: ['MERGED', 'MERGED'] }), { action: 'delete', reason: 'merged' });
  });

  it('um mergeado e outro aberto mantém', () => {
    assert.deepEqual(gcDecision({ ...base, prStates: ['MERGED', 'OPEN'] }), { action: 'keep', reason: 'open-pr' });
  });

  it('PR aberto mantém mesmo parada há mais de 30 dias', () => {
    assert.deepEqual(gcDecision({ ...base, prStates: ['OPEN'], idleDays: 45 }), { action: 'keep', reason: 'open-pr' });
  });

  it('sem PR e parada há 30 dias apaga; com 29 mantém', () => {
    assert.deepEqual(gcDecision({ ...base, idleDays: 30 }), { action: 'delete', reason: 'idle' });
    assert.equal(gcDecision({ ...base, idleDays: 29 }).action, 'keep');
  });
});

describe('PRs', () => {
  it('casa key no título com fronteira, e pela branch', () => {
    assert.ok(prMatchesTask('[EDC-1001] - Checkout V2', null, 'EDC-1001'));
    assert.ok(!prMatchesTask('[EDC-10012] - outra coisa', null, 'EDC-1001'));
    assert.ok(prMatchesTask('ajuste de layout', 'feature/EDC-1001-layout', 'EDC-1001'));
  });

  it('fechado seguido de outro no mesmo repo é substituído pelo seguinte', () => {
    const pairs = replacementPairs([
      { key: 'api-core#3', repo: 'api-core', state: 'OPEN', createdAt: '2026-10-03' },
      { key: 'api-core#1', repo: 'api-core', state: 'CLOSED', createdAt: '2026-10-01' },
      { key: 'api-core#2', repo: 'api-core', state: 'CLOSED', createdAt: '2026-10-02' },
      { key: 'web-panel#9', repo: 'web-panel', state: 'MERGED', createdAt: '2026-10-01' },
    ]);
    assert.deepEqual(pairs, [
      { newer: 'api-core#2', older: 'api-core#1' },
      { newer: 'api-core#3', older: 'api-core#2' },
    ]);
  });
});

describe('docs do repo e pesquisa', () => {
  it('só markdown fora de dependência, sem changelog, respeitando exclusão', () => {
    assert.ok(isRepoDocPath('docs/specs/checkout.md', []));
    assert.ok(isRepoDocPath('CLAUDE.md', []));
    assert.ok(!isRepoDocPath('node_modules/x/README.md', []));
    assert.ok(!isRepoDocPath('packages/a/node_modules/x.md', []));
    assert.ok(!isRepoDocPath('CHANGELOG.md', []));
    assert.ok(!isRepoDocPath('docs/tmp/a.md', ['docs/tmp/']));
    assert.ok(!isRepoDocPath('src/app.ts', []));
  });

  it('título da pesquisa vem do primeiro heading', () => {
    assert.equal(researchTitle('intro\n# Cache de busca\ntexto', '/r/2026-11-10-cache.md'), 'Cache de busca');
    assert.equal(researchTitle('sem heading', '/r/2026-11-10-cache.md'), '2026-11-10-cache');
  });
});
