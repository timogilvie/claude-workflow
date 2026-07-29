import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeRouteModelSuccessors } from './route-model-successors.ts';

function decision(overrides: Partial<Parameters<typeof upgradeRouteModelSuccessors>[0]> = {}) {
  return {
    planner: 'gpt-5.4',
    coder: 'gpt-5',
    reviewer: 'gpt-5-mini',
    planDepth: 'deep' as const,
    codeDepth: 'deep' as const,
    reviewRecommended: 'static+llm' as const,
    expectedSuccess: 0.9,
    expectedCostPlan: 1,
    expectedCostCode: 2,
    expectedCostReview: 1,
    confidence: 0.8,
    reasoning: ['External router recommendation.'],
    signals: {
      taskType: 'feature' as const,
      promptLength: 'medium' as const,
      complexityScore: 3,
      fileTypes: ['ts'],
      riskScore: 3,
    },
    ...overrides,
  };
}

test('upgrades retired Codex model IDs in every workflow stage', () => {
  const upgraded = upgradeRouteModelSuccessors(decision());

  assert.equal(upgraded.planner, 'gpt-5.6-terra');
  assert.equal(upgraded.coder, 'gpt-5.5');
  assert.equal(upgraded.reviewer, 'gpt-5.5');
  assert.match(upgraded.reasoning.join('\n'), /gpt-5\.4 to its ChatGPT Codex successor gpt-5\.6-terra/);
});

test('preserves routes that do not require an explicit successor', () => {
  const original = decision({
    planner: 'gpt-5.5',
    coder: 'claude-sonnet-5',
    reviewer: 'gpt-5.6-terra',
  });

  assert.equal(upgradeRouteModelSuccessors(original), original);
});
