import assert from 'node:assert/strict';
import type { WorkflowRouteDecision } from './workflow-router.ts';
import {
  canRunChallenge,
  chooseDistinctChallengerModel,
  routeChangedMaterially,
  deriveChallengeBranch,
  deriveChallengeSlug,
  deriveChallengerKey,
  getChallengeModelPool,
  pickChallengeWorkflowsWithContext,
  pickChallengeModels,
  pickChallengeWorkflows,
} from './challenge-mode.ts';
import type { RouteArtifactSnapshot } from './route-artifact.ts';

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
  assert.equal(deriveChallengerKey('HOK-970'), 'HOK-970_c');
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
  assert.equal(pair!.challenger.key, 'HOK-970_c');
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

test('pickChallengeModels populates routing fields with empty strings', () => {
  const pair = pickChallengeModels(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-972',
      issueId: 'HOK-972',
      slug: 'test-routing-fields',
      primaryModel: 'claude-opus-4-6',
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.planner, '');
  assert.equal(pair!.primary.reviewer, '');
  assert.equal(pair!.primary.planDepth, '');
  assert.equal(pair!.primary.codeDepth, '');
  assert.equal(pair!.primary.reviewMode, '');
  assert.equal(pair!.challenger.planner, '');
  assert.equal(pair!.challenger.reviewer, '');
  assert.equal(pair!.challenger.planDepth, '');
  assert.equal(pair!.challenger.codeDepth, '');
  assert.equal(pair!.challenger.reviewMode, '');
});

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
  reasoning: [],
  signals: {},
});

test('pickChallengeWorkflows populates routing fields for both sides', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-973',
      issueId: 'HOK-973',
      slug: 'oauth-auth',
      prompt: 'Implement user authentication with OAuth2',
      primaryModel: 'claude-opus-4-6',
      agentMap: { 'gpt-5.3-codex': 'codex' },
      defaultAgent: 'claude',
      randomFn: () => 0.9,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-opus-4-6');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);

  // Both sides should have routing fields populated from mock
  assert.equal(pair!.primary.planner, 'claude-opus-4-6');
  assert.equal(pair!.primary.reviewer, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.primary.planDepth, 'deep');
  assert.equal(pair!.primary.codeDepth, 'medium');
  assert.equal(pair!.primary.reviewMode, 'llm');

  assert.equal(pair!.challenger.planner, 'claude-opus-4-6');
  assert.equal(pair!.challenger.reviewer, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.challenger.planDepth, 'deep');
  assert.equal(pair!.challenger.codeDepth, 'medium');
  assert.equal(pair!.challenger.reviewMode, 'llm');
});

test('pickChallengeWorkflows uses same routing for both sides', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-974',
      issueId: 'HOK-974',
      slug: 'fix-oauth-bug',
      prompt: 'Fix authentication bug in OAuth flow',
      primaryModel: 'claude-opus-4-6',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  // Both sides should have the same planner/reviewer/depths
  assert.equal(pair!.primary.planner, pair!.challenger.planner);
  assert.equal(pair!.primary.reviewer, pair!.challenger.reviewer);
  assert.equal(pair!.primary.planDepth, pair!.challenger.planDepth);
  assert.equal(pair!.primary.codeDepth, pair!.challenger.codeDepth);
  assert.equal(pair!.primary.reviewMode, pair!.challenger.reviewMode);

  // But different coders
  assert.notEqual(pair!.primary.model, pair!.challenger.model);
});

test('pickChallengeWorkflows returns null when fewer than two distinct models exist', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6'],
    {
      pairId: 'HOK-975',
      issueId: 'HOK-975',
      slug: 'new-feature',
      prompt: 'Add new feature',
      routeFn: mockRouteFn,
    },
  );
  assert.equal(pair, null);
});

test('routeChangedMaterially ignores model swaps within same class', () => {
  const bootstrap: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-5-20250929',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-7',
    codeDepth: 'medium',
    reviewMode: 'static+llm',
  };

  assert.deepEqual(routeChangedMaterially(bootstrap, expanded), { changed: false, reasons: [] });
});

test('routeChangedMaterially detects class and depth changes', () => {
  const bootstrap: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-sonnet-4-5-20250929',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'gpt-5.4',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'llm',
  };

  assert.deepEqual(routeChangedMaterially(bootstrap, expanded), {
    changed: true,
    reasons: ['coder_class', 'code_depth', 'reviewer_class'],
  });
});

test('routeChangedMaterially compares unknown models by exact id', () => {
  const bootstrap: RouteArtifactSnapshot = {
    coder: 'custom-a',
    reviewer: 'custom-reviewer',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'custom-b',
    reviewer: 'custom-reviewer',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };

  assert.deepEqual(routeChangedMaterially(bootstrap, expanded), {
    changed: true,
    reasons: ['coder_class'],
  });
});

test('pickChallengeWorkflowsWithContext uses bootstrap route when expanded route is absent', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'gpt-5.4',
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-6',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-sonnet-4-6', 'gpt-5.4'],
    {
      pairId: 'HOK-976',
      issueId: 'HOK-976',
      slug: 'bootstrap-only',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-6',
      randomFn: () => 0,
    },
    { bootstrap, expanded: null },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'bootstrap');
  assert.equal(pair!.primary.planner, 'gpt-5.4');
  assert.equal(pair!.primary.planDepth, 'deep');
  assert.equal(pair!.primary.reviewer, 'claude-opus-4-6');
});

test('pickChallengeWorkflowsWithContext uses expanded route when bootstrap is unavailable', () => {
  const expanded: RouteArtifactSnapshot = {
    coder: 'gpt-5.4',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'static',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['gpt-5.4', 'claude-sonnet-4-6'],
    {
      pairId: 'HOK-977',
      issueId: 'HOK-977',
      slug: 'expanded-only',
      prompt: 'irrelevant',
      randomFn: () => 0,
    },
    { bootstrap: null, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
  assert.equal(pair!.primary.model, 'gpt-5.4');
  assert.equal(pair!.primary.codeDepth, 'deep');
});

test('pickChallengeWorkflowsWithContext preserves bootstrap participants when route is not materially different', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'claude-opus-4-6',
    coder: 'claude-sonnet-4-5-20250929',
    reviewer: 'claude-opus-4-6',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-7',
    codeDepth: 'medium',
    reviewMode: 'static+llm',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-sonnet-4-6', 'gpt-5.4'],
    {
      pairId: 'HOK-978',
      issueId: 'HOK-978',
      slug: 'preserved',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-5-20250929',
      randomFn: () => 0,
    },
    { bootstrap, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'preserved');
  assert.equal(pair!.primary.model, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.primary.codeDepth, 'medium');
  assert.equal(pair!.primary.reviewer, 'claude-opus-4-6');
  assert.equal(pair!.routeContext.refreshRationale, 'expanded route matches bootstrap on coder class/depth');
});

test('pickChallengeWorkflowsWithContext refreshes participants when expanded route changes materially', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'claude-opus-4-6',
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-sonnet-4-5-20250929',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'gpt-5.4',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'static',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['gpt-5.4', 'claude-sonnet-4-6'],
    {
      pairId: 'HOK-979',
      issueId: 'HOK-979',
      slug: 'refreshed',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-6',
      randomFn: () => 0,
    },
    { bootstrap, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
  assert.equal(pair!.routeContext.bootstrapRoute?.coder, 'claude-sonnet-4-6');
  assert.equal(pair!.routeContext.expandedRoute?.coder, 'gpt-5.4');
  assert.equal(pair!.primary.model, 'gpt-5.4');
  assert.equal(pair!.primary.codeDepth, 'deep');
  assert.equal(pair!.primary.planner, 'claude-opus-4-6');
  assert.equal(pair!.primary.planDepth, 'deep');
  assert.equal(pair!.primary.reviewer, 'claude-opus-4-6');
  assert.equal(pair!.primary.reviewMode, 'static');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);
  assert.equal(pair!.challenger.codeDepth, 'deep');
  assert.equal(pair!.challenger.reviewer, 'claude-opus-4-6');
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});
