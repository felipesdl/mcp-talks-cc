import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentFromSnippet, classifyToolError, skillFromSnippet, slashFromText } from '../../src/ingest/toolSignals.ts';

describe('classifyToolError', () => {
  it('flag verdadeiro classifica o motivo', () => {
    assert.equal(
      classifyToolError("The user doesn't want to proceed with this tool use. The tool use was rejected", true),
      'rejected',
    );
    assert.equal(classifyToolError('<tool_use_error>File has not been read yet</tool_use_error>', true), 'tool_error');
    assert.equal(classifyToolError('Exit code 1\nnpm ERR! missing script', true), 'exit');
    assert.equal(classifyToolError('PreToolUse:Bash hook blocked this command', true), 'hook');
    assert.equal(classifyToolError('algo estranho', true), 'other');
  });

  it('commit que cita "hook" na mensagem não é erro de hook', () => {
    assert.equal(classifyToolError('Exit code 1 dev@acme.test 743a006 fix: hook de push sem timeout', true), 'exit');
  });

  it('sem flag (sessão podada) só devolve tipo quando o texto prova', () => {
    assert.equal(classifyToolError('<tool_use_error>x</tool_use_error>', null), 'tool_error');
    assert.equal(classifyToolError('Exit code 2', null), 'exit');
    assert.equal(classifyToolError('Exit code 0', null), null);
    assert.equal(classifyToolError('saída normal do comando', null), null);
    // abaixo do corte no portão A: sem flag não infere
    assert.equal(classifyToolError('PreToolUse:Bash hook blocked this command', null), null);
  });

  it('flag falso nunca é erro', () => {
    assert.equal(classifyToolError('<tool_use_error>x</tool_use_error>', false), null);
  });
});

describe('skill, agente e slash', () => {
  it('skill do input JSON, inteiro ou cortado', () => {
    assert.equal(skillFromSnippet('{"skill":"pr-gen","args":"EDC-1001"}'), 'pr-gen');
    assert.equal(skillFromSnippet('{"skill":"qa-kit:pr-check","args":"um texto muito lon'), 'qa-kit:pr-check');
    assert.equal(skillFromSnippet('{"skill":"/commit"}'), 'commit');
    assert.equal(skillFromSnippet('{"args":"x"}'), null);
    assert.equal(skillFromSnippet(null), null);
  });

  it('agente sem tipo é general-purpose', () => {
    assert.equal(agentFromSnippet('{"subagent_type":"Explore","prompt":"x"}'), 'Explore');
    assert.equal(agentFromSnippet('{"prompt":"x"}'), 'general-purpose');
  });

  it('slash command da mensagem de usuário', () => {
    assert.equal(slashFromText('<command-name>/pr-review</command-name>\n<command-args></command-args>'), 'pr-review');
    assert.equal(slashFromText('<command-name>compact</command-name>'), 'compact');
    assert.equal(slashFromText('texto normal'), null);
  });
});
