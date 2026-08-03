import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lowValueReason,
  prepareConversationText,
  stripWrappers,
} from '../../src/ingest/quality.ts';

// Todos os casos abaixo são texto REAL amostrado do grafo em 2026-08-03.
describe('stripWrappers', () => {
  it('remove wrapper de slash command', () => {
    const raw =
      '<command-message>pr-verify</command-message>\n<command-name>/pr-verify</command-name>\n<command-args>https://github.com/px-center/px-painel/pull/1705</command-args>';
    assert.equal(stripWrappers(raw), '');
  });

  it('remove preâmbulo de skill mas preserva o resto', () => {
    const raw =
      'Base directory for this skill: /Users/felipesdl/.claude/skills/pr-verify\n\nO gate real do fluxo está em `FreightPolicy::canAdvance`.';
    const out = stripWrappers(raw);
    assert.ok(!out.includes('Base directory'));
    assert.ok(out.includes('FreightPolicy::canAdvance'));
  });

  it('remove aviso injetado por hook do próprio mcp-talks-cc', () => {
    const raw =
      'Ambiente: **px-painel → front-web (`front`)**. PR OPEN, 40 arquivos, +4402/-115.\n\n> ⚠️ tuning do mcp-talks-cc pendente (136 grades). Revisar o rationale.';
    const out = stripWrappers(raw);
    assert.ok(out.includes('PR OPEN, 40 arquivos'));
    assert.ok(!out.includes('tuning do mcp-talks-cc pendente'));
  });

  it('remove bash-stdout e referência de imagem', () => {
    assert.equal(stripWrappers('<bash-stdout>Switched to branch \'main\'</bash-stdout>'), '');
    assert.equal(stripWrappers('[Image #2] [Image #3]'), '');
    assert.equal(
      stripWrappers('[Image: source: /Users/felipesdl/.claude/image-cache/442d9f10/1.png]'),
      '',
    );
  });
});

describe('lowValueReason — corta filler navegacional', () => {
  const filler = [
    "I'll start with Phase 1: get PR metadata.",
    'Excellent! Now let me check the repositories to understand the data access patterns.',
    'Let me try a different approach to find the modules.',
    'Now let me check the other tab components and the ListLayout structure:',
    'Now let me search for all usages of these components in the codebase:',
    'Certo, vou refazer o sync do px-docs pra pegar as `decisions/`.',
    'Agora listing-detail-page. Leio os 2 blocos:',
    'Vou ver a divergência e integrar antes de seguir com o resto.',
  ];
  for (const t of filler) {
    it(`corta: ${t.slice(0, 45)}`, () => {
      assert.equal(lowValueReason(t), 'filler');
    });
  }

  it('não corta anúncio que também entrega conclusão', () => {
    const t =
      'Vou aplicar os 3 casos. O gate real é `canAdvance`, porque o status só avança quando a vistoria de retirada existe.';
    assert.equal(lowValueReason(t), null);
  });

  it('não corta achado técnico que começa com interjeição', () => {
    const t =
      'Interesting! The `useUpdateJobMutation` has query invalidation but `useCreateJobMutation` does not.';
    assert.equal(lowValueReason(t), null);
  });
});

describe('lowValueReason — floor de tamanho com exceção por sinal de conteúdo', () => {
  it('corta texto curto e sem sinal', () => {
    assert.equal(lowValueReason('1 - sim\n3 - sim e me fale como eu poderia testar'), 'short');
  });

  it('mantém texto curto COM sinal de código', () => {
    // 61 chars, é uma decisão de verdade
    assert.equal(lowValueReason('Modificar service: dispatch Job ao invés de `Mail::to->send`.'), null);
  });

  it('mantém texto curto com ticket ou path', () => {
    assert.equal(lowValueReason('Bug reproduz só na EDC-2410, resto passa.'), null);
    assert.equal(lowValueReason('Olhar app/Models/Application.php, PK própria.'), null);
  });

  it('corta o que sobra vazio depois do strip', () => {
    assert.equal(lowValueReason(stripWrappers('[Image #2]')), 'empty');
  });

  it('mantém relato de bug do usuário mesmo sem código', () => {
    const t =
      'outra questão o scroll não está subindo até ele quando da erro, só até um anterior, isso deve ser o offset';
    assert.equal(lowValueReason(t), null);
  });
});

describe('prepareConversationText', () => {
  it('devolve texto limpo quando vale indexar', () => {
    const raw = '<system-reminder>ignore isso</system-reminder>\nO gate é `FreightPolicy::canAdvance`, confirmado no teste.';
    const out = prepareConversationText(raw);
    assert.ok(out);
    assert.ok(!out.includes('system-reminder'));
    assert.ok(out.includes('canAdvance'));
  });

  it('devolve null pra filler', () => {
    assert.equal(prepareConversationText('Let me read the Tooltip component source files:'), null);
  });
});
