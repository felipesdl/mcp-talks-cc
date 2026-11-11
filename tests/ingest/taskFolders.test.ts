import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectPath } from '../../src/ingest/entities.ts';

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
