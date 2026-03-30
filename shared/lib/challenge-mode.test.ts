import assert from 'node:assert/strict';
import {
  canRunChallenge,
  chooseDistinctChallengerModel,
  deriveChallengeBranch,
  deriveChallengeSlug,
  deriveChallengerKey,
  getChallengeModelPool,
  pickChallengeModels,
  pickChallengeWorkflows,
} from './challenge-mode.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

console.log('\n--- Challenge Mode Tests ---\n');

test('challenge model pool prefers explicit challenge.models', () => {
  const pool = getChallengeModelPool(
    { models: ['claude-opus-4-6', 'gpt-5.3-codex', 'claude-opus-4-6'] },
    { models: ['claude-sonnet-4-5-20250929'] },
  );
  assert.deepEqual(pool, ['claude-opus-4-6', 'gpt-5.3-codex']);
});

test('challenge model pool falls back to router models when challenge.models is null', () => {
  const pool = getChallengeModelPool(
    { models: null },
    { models: ['claude-sonnet-4-5-20250929', 'gpt-5.3-codex'] },
  );
  assert.deepEqual(pool, ['claude-sonnet-4-5-20250929', 'gpt-5.3-codex']);
});

test('canRunChallenge requires at least two distinct models', () => {
  assert.equal(canRunChallenge(['claude-opus-4-6']), false);
  assert.equal(canRunChallenge(['claude-opus-4-6', 'claude-opus-4-6', 'gpt-5.3-codex']), true);
});

test('derive challenge identifiers and branches', () => {
  assert.equal(deriveChallengerKey('HOK-970'), 'HOK-970__challenger');
  assert.equal(deriveChallengeSlug('feature-name', 'primary'), 'feature-name');
  assert.equal(deriveChallengeSlug('feature-name', 'challenger'), 'feature-name-challenger');
  assert.equal(deriveChallengeBranch('feature-name', 'primary'), 'task/feature-name');
  assert.equal(deriveChallengeBranch('feature-name', 'challenger'), 'task/feature-name-challenger');
});

test('chooseDistinctChallengerModel skips the primary model', () => {
  const challenger = chooseDistinctChallengerModel(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    'claude-opus-4-6',
    () => 0,
  );
  assert.equal(challenger, 'claude-sonnet-4-5-20250929');
});

test('pickChallengeModels uses the router-selected primary model', () => {
  const pair = pickChallengeModels(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-970',
      issueId: 'HOK-970',
      slug: 'challenge-mode',
      primaryModel: 'claude-opus-4-6',
      agentMap: { 'gpt-5.3-codex': 'codex' },
      defaultAgent: 'claude',
      randomFn: () => 0.9,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-opus-4-6');
  assert.equal(pair!.primary.agent, 'claude');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);
  assert.equal(pair!.challenger.agent, 'codex');
  assert.equal(pair!.challenger.key, 'HOK-970__challenger');
});

test('pickChallengeModels allows a router-selected primary model outside the configured pool', () => {
  const pair = pickChallengeModels(
    ['claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-971',
      issueId: 'HOK-971',
      slug: 'external-primary',
      primaryModel: 'claude-opus-4-6',
      agentMap: { 'gpt-5.3-codex': 'codex' },
      defaultAgent: 'claude',
      randomFn: () => 0,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-opus-4-6');
  assert.equal(pair!.challenger.model, 'claude-sonnet-4-5-20250929');
});

test('pickChallengeModels returns null when fewer than two distinct models exist', () => {
  const pair = pickChallengeModels(['claude-opus-4-6'], {
    pairId: 'HOK-970',
    issueId: 'HOK-970',
    slug: 'challenge-mode',
  });
  assert.equal(pair, null);
});

console.log('\n--- pickChallengeWorkflows Tests ---\n');

test('pickChallengeWorkflows populates routing fields for both sides', () => {
  const mockRouteFn = (): WorkflowRouteDecision => ({
    planner: 'claude-opus-4-6',
    coder: 'claude-opus-4-6',
    reviewer: 'claude-sonnet-4-5-20250929',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewRecommended: 'llm',
    expectedSuccess: 0.85,
    expectedCostPlan: 100,
    expectedCostCode: 200,
    expectedCostReview: 50,
  });

  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-1044',
      issueId: 'HOK-1044',
      slug: 'test-routing',
      prompt: 'Implement a new feature',
      primaryModel: 'claude-opus-4-6',
      agentMap: { 'gpt-5.3-codex': 'codex' },
      defaultAgent: 'claude',
      randomFn: () => 0.9,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.planner, 'claude-opus-4-6');
  assert.equal(pair!.primary.reviewer, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.primary.planDepth, 'deep');
  assert.equal(pair!.primary.codeDepth, 'medium');
  assert.equal(pair!.primary.reviewMode, 'llm');
  assert.equal(pair!.primary.plannerAgent, 'claude');
  assert.equal(pair!.primary.reviewerAgent, 'claude');

  assert.equal(pair!.challenger.planner, 'claude-opus-4-6');
  assert.equal(pair!.challenger.reviewer, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.challenger.planDepth, 'deep');
  assert.equal(pair!.challenger.codeDepth, 'medium');
  assert.equal(pair!.challenger.reviewMode, 'llm');
});

test('pickChallengeWorkflows ensures distinct coder models', () => {
  const mockRouteFn = (): WorkflowRouteDecision => ({
    planner: 'claude-opus-4-6',
    coder: 'claude-opus-4-6',
    reviewer: 'claude-sonnet-4-5-20250929',
    planDepth: 'light',
    codeDepth: 'light',
    reviewRecommended: 'static',
    expectedSuccess: 0.9,
    expectedCostPlan: 50,
    expectedCostCode: 100,
    expectedCostReview: 25,
  });

  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-1044',
      issueId: 'HOK-1044',
      slug: 'distinct-models',
      prompt: 'Fix a bug',
      primaryModel: 'claude-opus-4-6',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-opus-4-6');
  assert.equal(pair!.challenger.model, 'claude-sonnet-4-5-20250929');
  assert.notEqual(pair!.primary.model, pair!.challenger.model);
});

test('pickChallengeWorkflows resolves agents from agentMap', () => {
  const mockRouteFn = (): WorkflowRouteDecision => ({
    planner: 'gpt-5.3-codex',
    coder: 'claude-opus-4-6',
    reviewer: 'gpt-5.3-codex',
    planDepth: 'deep',
    codeDepth: 'deep',
    reviewRecommended: 'llm',
    expectedSuccess: 0.8,
    expectedCostPlan: 150,
    expectedCostCode: 300,
    expectedCostReview: 100,
  });

  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-1044',
      issueId: 'HOK-1044',
      slug: 'agent-resolution',
      prompt: 'Add tests',
      primaryModel: 'claude-opus-4-6',
      agentMap: { 'gpt-5.3-codex': 'codex' },
      defaultAgent: 'claude',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.plannerAgent, 'codex');
  assert.equal(pair!.primary.reviewerAgent, 'codex');
  assert.equal(pair!.primary.agent, 'claude');
  assert.equal(pair!.challenger.agent, 'codex');
});

test('pickChallengeWorkflows returns null when pool has fewer than 2 distinct models', () => {
  const mockRouteFn = (): WorkflowRouteDecision => ({
    planner: 'claude-opus-4-6',
    coder: 'claude-opus-4-6',
    reviewer: 'claude-opus-4-6',
    planDepth: 'light',
    codeDepth: 'medium',
    reviewRecommended: 'none',
    expectedSuccess: 0.95,
    expectedCostPlan: 50,
    expectedCostCode: 100,
    expectedCostReview: 0,
  });

  const pair = pickChallengeWorkflows(['claude-opus-4-6'], {
    pairId: 'HOK-1044',
    issueId: 'HOK-1044',
    slug: 'insufficient-pool',
    prompt: 'Refactor code',
    primaryModel: 'claude-opus-4-6',
    routeFn: mockRouteFn,
  });

  assert.equal(pair, null);
});

test('pickChallengeWorkflows uses router recommendation when primaryModel is not provided', () => {
  const mockRouteFn = (): WorkflowRouteDecision => ({
    planner: 'claude-opus-4-6',
    coder: 'claude-sonnet-4-5-20250929',
    reviewer: 'claude-opus-4-6',
    planDepth: 'light',
    codeDepth: 'light',
    reviewRecommended: 'static',
    expectedSuccess: 0.9,
    expectedCostPlan: 50,
    expectedCostCode: 80,
    expectedCostReview: 30,
  });

  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-1044',
      issueId: 'HOK-1044',
      slug: 'router-primary',
      prompt: 'Update docs',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  // Should use the coder from routing decision
  assert.equal(pair!.primary.model, 'claude-sonnet-4-5-20250929');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});
