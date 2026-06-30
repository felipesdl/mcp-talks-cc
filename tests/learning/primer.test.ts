import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimer } from '../../src/learning/primer.ts';
import type { Profile } from '../../src/learning/types.ts';

function profile(over: Partial<Profile> = {}): Profile {
  return {
    v: 1,
    generatedAt: '2026-06-11T00:00:00.000Z',
    windowDays: 30,
    topProjects: [{ path: '/p/web-app', name: 'web-app', share: 0.6, meanUtility: 0.7 }],
    // (nome de projeto fictício; o real vem do seu corpus em runtime)
    projectClusters: [],
    recurringTopics: ['react query', 'feature flag'],
    terminology: [],
    sourceKindUtility: {},
    queryShapes: { zeroHitTerms: [], medianK: 8, literalVsNL: { lit: 1, nl: 1 } },
    recentHighValue: [],
    lastEval: { ranAt: '2026-06-11T00:00:00.000Z', queriesGraded: 10, meanUtility: 0.6, healthy: true },
    ...over,
  };
}

describe('buildPrimer', () => {
  it('cold start (sem dado) -> null', () => {
    const p = profile({ topProjects: [], lastEval: { ranAt: '', queriesGraded: 0, meanUtility: 0, healthy: true } });
    assert.equal(buildPrimer(p), null);
  });

  it('envelope SessionStart válido, sem aviso quando não há candidate', () => {
    const raw = buildPrimer(profile());
    assert.ok(raw);
    const parsed = JSON.parse(raw!);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('web-app'));
    assert.ok(!parsed.hookSpecificOutput.additionalContext.includes('TUNING PENDENTE'));
  });

  it('candidate pendente -> aviso com idade e instrução de avisar o user', () => {
    const proposedAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const raw = buildPrimer(profile(), { proposedAt, nGrades: 41 });
    const ctx = JSON.parse(raw!).hookSpecificOutput.additionalContext as string;
    assert.ok(ctx.includes('TUNING PENDENTE'));
    assert.ok(ctx.includes('pendente há 5d'));
    assert.ok(ctx.includes('41 grades'));
    assert.ok(ctx.includes('avise o user'));
    assert.ok(ctx.includes('self-tune:accept'));
  });

  it('candidate recém-proposto -> "nova"', () => {
    const raw = buildPrimer(profile(), { proposedAt: new Date().toISOString(), nGrades: 30 });
    const ctx = JSON.parse(raw!).hookSpecificOutput.additionalContext as string;
    assert.ok(ctx.includes('proposta de retrieval nova'));
  });
});
