import assert from 'node:assert/strict';
import type { WorkflowRouteDecision } from './workflow-router.ts';
import {
  canRunChallenge,
  chooseChallengeStage,
  chooseDistinctChallengerModel,
  decideChallengeLaunch,
  extractChallengeRecommendation,
  routeChangedMaterially,
  deriveChallengeBranch,
  deriveChallengeSlug,
  deriveChallengerKey,
  filterDeepSeekChallengeModels,
  getChallengeModelPool,
  pickChallengeWorkflowsWithContext,
  pickChallengeModels,
  pickChallengeWorkflows,
  variedModelForStage,
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

test('challenge model pool excludes DeepSeek by default', () => {
  const pool = getChallengeModelPool(
    { models: ['deepseek-v4-flash', 'claude-opus-4-6', 'deepseek-v4-pro'] },
    { models: ['gpt-5.3-codex'] },
  );
  assert.deepEqual(pool, ['claude-opus-4-6']);
});

test('challenge model pool includes DeepSeek when allowDeepseek is enabled', () => {
  const pool = getChallengeModelPool(
    { allowDeepseek: true, models: ['deepseek-v4-flash', 'claude-opus-4-6', 'deepseek-v4-flash'] },
    { models: ['gpt-5.3-codex'] },
  );
  assert.deepEqual(pool, ['deepseek-v4-flash', 'claude-opus-4-6']);
});

test('filterDeepSeekChallengeModels returns a clear rationale when it removes candidates', () => {
  const filtered = filterDeepSeekChallengeModels(
    ['deepseek-v4-flash', 'claude-deepseek', 'claude-opus-4-6', ''],
    {},
  );
  assert.deepEqual(filtered.models, ['claude-opus-4-6']);
  assert.deepEqual(filtered.warnings, ['DeepSeek excluded: challenge.allowDeepseek is not enabled']);
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

test('all-DeepSeek pool becomes not runnable when allowDeepseek is not enabled', () => {
  const pool = getChallengeModelPool(
    { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
    { models: [] },
  );
  assert.deepEqual(pool, []);
  assert.equal(canRunChallenge(pool), false);
  const pair = pickChallengeModels(pool, {
    pairId: 'HOK-982',
    issueId: 'HOK-982',
    slug: 'all-deepseek',
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
  assert.equal(pair!.primary.model, 'gpt-5.4');
  assert.equal(pair!.primary.codeDepth, 'deep');
  assert.equal(pair!.primary.planner, 'claude-opus-4-6');
  assert.equal(pair!.primary.planDepth, 'deep');
});

test('pickChallengeWorkflowsWithContext carries expanded route context to both challenge entries', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'bootstrap-planner',
    coder: 'claude-sonnet-4-6',
    reviewer: 'bootstrap-reviewer',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };
  const expanded: RouteArtifactSnapshot = {
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-6',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['gpt-5.4', 'claude-sonnet-4-6'],
    {
      pairId: 'HOK-980',
      issueId: 'HOK-980',
      slug: 'expanded-context',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-6',
      randomFn: () => 0,
    },
    { bootstrap, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
  assert.equal(pair!.routeContext.expandedRoute, expanded);
  assert.equal(pair!.primary.model, 'gpt-5.4');
  assert.equal(pair!.primary.codeDepth, 'deep');
  assert.equal(pair!.primary.reviewMode, 'static+llm');
  assert.equal(pair!.primary.planner, 'bootstrap-planner');
  assert.equal(pair!.challenger.codeDepth, 'deep');
  assert.equal(pair!.challenger.reviewMode, 'static+llm');
  assert.equal(pair!.challenger.planner, 'bootstrap-planner');
});

test('pickChallengeWorkflowsWithContext treats absent invalid expanded snapshot as bootstrap-only', () => {
  const bootstrap: RouteArtifactSnapshot = {
    planner: 'bootstrap-planner',
    coder: 'claude-sonnet-4-6',
    reviewer: 'bootstrap-reviewer',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewMode: 'llm',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-sonnet-4-6', 'gpt-5.4'],
    {
      pairId: 'HOK-981',
      issueId: 'HOK-981',
      slug: 'invalid-expanded-absent',
      prompt: 'irrelevant',
      primaryModel: 'claude-sonnet-4-6',
      randomFn: () => 0,
    },
    { bootstrap, expanded: null },
  );

  assert.ok(pair);
  assert.equal(pair!.routeContext.decisionSource, 'bootstrap');
  assert.equal(pair!.routeContext.expandedRoute, undefined);
  assert.equal(pair!.primary.model, 'claude-sonnet-4-6');
  assert.equal(pair!.primary.codeDepth, 'medium');
  assert.equal(pair!.primary.reviewMode, 'llm');
});

function snapshotWithRecommendation(
  recommendation: Record<string, unknown> | undefined,
  coder = 'claude-sonnet-4-6',
): RouteArtifactSnapshot {
  return {
    coder,
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'llm',
    ...(recommendation !== undefined
      ? { expectedMetrics: { challengeRecommendation: recommendation } }
      : {}),
  };
}

test('extractChallengeRecommendation prefers the expanded artifact', () => {
  const recommendation = extractChallengeRecommendation({
    bootstrap: snapshotWithRecommendation({
      shouldChallenge: true,
      reason: 'low-confidence',
      challengerModel: 'gpt-5.4',
      priority: 300,
    }),
    expanded: snapshotWithRecommendation({
      shouldChallenge: true,
      reason: 'new-model',
      challengerModel: 'claude-fable-5',
      priority: 200,
    }),
  });
  assert.equal(recommendation?.reason, 'new-model');
  assert.equal(recommendation?.challengerModel, 'claude-fable-5');
});

test('extractChallengeRecommendation falls back to bootstrap and rejects non-actionable payloads', () => {
  const fromBootstrap = extractChallengeRecommendation({
    bootstrap: snapshotWithRecommendation({
      shouldChallenge: true,
      reason: 'low-data-stage',
      challengerModel: 'claude-fable-5',
      stage: 'review',
      priority: 100,
    }),
    expanded: snapshotWithRecommendation(undefined),
  });
  assert.equal(fromBootstrap?.reason, 'low-data-stage');
  assert.equal(fromBootstrap?.stage, 'review');

  assert.equal(extractChallengeRecommendation({ bootstrap: null, expanded: null }), null);
  assert.equal(
    extractChallengeRecommendation({
      bootstrap: snapshotWithRecommendation({ shouldChallenge: false, reason: 'disabled', priority: 0 }),
      expanded: null,
    }),
    null,
  );
  assert.equal(
    extractChallengeRecommendation({
      bootstrap: snapshotWithRecommendation({ shouldChallenge: true, reason: 'mystery', priority: 1 }),
      expanded: null,
    }),
    null,
  );
});

test('decideChallengeLaunch without recommendation is a plain random roll', () => {
  const win = decideChallengeLaunch({ pool: ['a-model-1', 'b-model-2'], rate: 0.3, randomFn: () => 0.2 });
  assert.equal(win.launch, true);
  assert.equal(win.selectionPath, 'random-roll');
  assert.equal(win.forcedChallengerModel, undefined);

  const lose = decideChallengeLaunch({ pool: ['a-model-1', 'b-model-2'], rate: 0.3, randomFn: () => 0.9 });
  assert.equal(lose.launch, false);
});

test('decideChallengeLaunch fires exploration recommendations regardless of base rate', () => {
  const decision = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'claude-fable-5'],
    primaryModel: 'claude-sonnet-4-6',
    rate: 0.1,
    recommendation: {
      shouldChallenge: true,
      reason: 'new-model',
      challengerModel: 'claude-fable-5',
      priority: 200,
    },
    randomFn: () => 0.99,
  });
  assert.equal(decision.launch, true);
  assert.equal(decision.selectionPath, 'recommendation-driven');
  assert.equal(decision.forcedChallengerModel, 'claude-fable-5');
});

test('decideChallengeLaunch honors a reduced recommendationRate', () => {
  const decision = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'claude-fable-5'],
    rate: 0.1,
    recommendationRate: 0.5,
    recommendation: {
      shouldChallenge: true,
      reason: 'low-data-stage',
      challengerModel: 'claude-fable-5',
      priority: 100,
    },
    randomFn: () => 0.7,
  });
  assert.equal(decision.launch, false);
  assert.equal(decision.selectionPath, 'recommendation-driven');
});

test('decideChallengeLaunch keeps the base rate for low-confidence recommendations', () => {
  const decision = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'gpt-5.4'],
    rate: 0.3,
    recommendation: {
      shouldChallenge: true,
      reason: 'low-confidence',
      challengerModel: 'gpt-5.4',
      priority: 300,
    },
    randomFn: () => 0.5,
  });
  assert.equal(decision.launch, false);
  assert.equal(decision.selectionPath, 'recommendation-driven');
  assert.equal(decision.forcedChallengerModel, 'gpt-5.4');
});

test('decideChallengeLaunch drops unusable recommended challengers', () => {
  const notInPool = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'gpt-5.4'],
    rate: 0.1,
    recommendation: {
      shouldChallenge: true,
      reason: 'new-model',
      challengerModel: 'claude-fable-5',
      priority: 200,
    },
    randomFn: () => 0,
  });
  assert.equal(notInPool.launch, true);
  assert.equal(notInPool.forcedChallengerModel, undefined);

  const samePrimary = decideChallengeLaunch({
    pool: ['claude-sonnet-4-6', 'gpt-5.4'],
    primaryModel: 'gpt-5.4',
    rate: 0.1,
    recommendation: {
      shouldChallenge: true,
      reason: 'new-model',
      challengerModel: 'gpt-5.4',
      priority: 200,
    },
    randomFn: () => 0,
  });
  assert.equal(samePrimary.forcedChallengerModel, undefined);
});

test('pickChallengeModels uses the forced challenger when usable', () => {
  const pair = pickChallengeModels(
    ['claude-sonnet-4-6', 'gpt-5.4', 'claude-fable-5'],
    {
      pairId: 'HOK-990',
      issueId: 'HOK-990',
      slug: 'forced-challenger',
      primaryModel: 'claude-sonnet-4-6',
      forcedChallengerModel: 'claude-fable-5',
      randomFn: () => 0, // would otherwise pick gpt-5.4
    },
  );
  assert.equal(pair?.challenger.model, 'claude-fable-5');
  assert.equal(pair?.primary.model, 'claude-sonnet-4-6');
});

test('pickChallengeModels falls back to random when the forced challenger is unusable', () => {
  const equalsPrimary = pickChallengeModels(
    ['claude-sonnet-4-6', 'gpt-5.4'],
    {
      pairId: 'HOK-991',
      issueId: 'HOK-991',
      slug: 'forced-equals-primary',
      primaryModel: 'claude-sonnet-4-6',
      forcedChallengerModel: 'claude-sonnet-4-6',
      randomFn: () => 0,
    },
  );
  assert.equal(equalsPrimary?.challenger.model, 'gpt-5.4');

  const notInPool = pickChallengeModels(
    ['claude-sonnet-4-6', 'gpt-5.4'],
    {
      pairId: 'HOK-992',
      issueId: 'HOK-992',
      slug: 'forced-not-in-pool',
      primaryModel: 'claude-sonnet-4-6',
      forcedChallengerModel: 'claude-fable-5',
      randomFn: () => 0,
    },
  );
  assert.equal(notInPool?.challenger.model, 'gpt-5.4');
});

test('pickChallengeWorkflowsWithContext threads the forced challenger through route snapshots', () => {
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-6',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'llm',
    planner: 'claude-sonnet-4-6',
    planDepth: 'light',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-sonnet-4-6', 'gpt-5.4', 'claude-fable-5'],
    {
      pairId: 'HOK-993',
      issueId: 'HOK-993',
      slug: 'forced-with-context',
      prompt: 'irrelevant',
      forcedChallengerModel: 'claude-fable-5',
      randomFn: () => 0, // would otherwise pick gpt-5.4
    },
    { bootstrap: null, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-sonnet-4-6');
  assert.equal(pair!.challenger.model, 'claude-fable-5');
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
});


test('chooseChallengeStage defaults to implementation and honors recommendations', () => {
  assert.equal(chooseChallengeStage(), 'implementation');
  assert.equal(chooseChallengeStage({ weights: {} }), 'implementation');
  assert.equal(chooseChallengeStage({ weights: { plan: 0, review: 0 } }), 'implementation');
  assert.equal(
    chooseChallengeStage({ weights: { implementation: 1 }, recommendedStage: 'review' }),
    'review',
  );
  assert.equal(chooseChallengeStage({ recommendedStage: 'plan' }), 'plan');
});

test('chooseChallengeStage samples stages by weight with a seeded randomFn', () => {
  const weights = { plan: 1, implementation: 2, review: 1 };
  // Cumulative mass: plan [0, 0.25), implementation [0.25, 0.75), review [0.75, 1)
  assert.equal(chooseChallengeStage({ weights, randomFn: () => 0.1 }), 'plan');
  assert.equal(chooseChallengeStage({ weights, randomFn: () => 0.5 }), 'implementation');
  assert.equal(chooseChallengeStage({ weights, randomFn: () => 0.9 }), 'review');
});

test('variedModelForStage maps stage to the right entry field', () => {
  const entry = {
    key: 'K', issueId: 'K', slug: 's', branch: 'task/s', role: 'primary' as const,
    model: 'coder-m', agent: 'claude',
    planner: 'planner-m', plannerAgent: 'claude',
    reviewer: 'reviewer-m', reviewerAgent: 'claude',
    planDepth: '', codeDepth: '', reviewMode: '',
  };
  assert.equal(variedModelForStage(entry, 'plan'), 'planner-m');
  assert.equal(variedModelForStage(entry, 'review'), 'reviewer-m');
  assert.equal(variedModelForStage(entry, 'implementation'), 'coder-m');
  assert.equal(variedModelForStage(entry, undefined), 'coder-m');
});

test('pickChallengeWorkflows varies only the planner for plan-stage challenges', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-995',
      issueId: 'HOK-995',
      slug: 'plan-stage',
      prompt: 'Implement user authentication with OAuth2',
      primaryModel: 'claude-sonnet-4-5-20250929',
      challengeStage: 'plan',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'plan');
  // Coder and reviewer are shared; only the planner differs
  assert.equal(pair!.primary.model, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.challenger.model, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.primary.reviewer, pair!.challenger.reviewer);
  assert.equal(pair!.primary.planner, 'claude-opus-4-6');
  assert.notEqual(pair!.challenger.planner, pair!.primary.planner);
  assert.equal(pair!.primary.planDepth, pair!.challenger.planDepth);
});

test('pickChallengeWorkflows varies only the reviewer for review-stage challenges', () => {
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-996',
      issueId: 'HOK-996',
      slug: 'review-stage',
      prompt: 'Implement user authentication with OAuth2',
      primaryModel: 'claude-opus-4-6',
      challengeStage: 'review',
      forcedChallengerModel: 'gpt-5.3-codex',
      randomFn: () => 0,
      routeFn: mockRouteFn,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'review');
  assert.equal(pair!.primary.model, pair!.challenger.model);
  assert.equal(pair!.primary.planner, pair!.challenger.planner);
  assert.equal(pair!.primary.reviewer, 'claude-sonnet-4-5-20250929');
  // Forced challenger applies to the varied stage
  assert.equal(pair!.challenger.reviewer, 'gpt-5.3-codex');
});

test('pickChallengeWorkflows falls back to coder variation when the route lacks the stage model', () => {
  const plannerlessRoute = (): WorkflowRouteDecision => ({
    ...mockRouteFn(),
    planner: '',
  });
  const pair = pickChallengeWorkflows(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-997',
      issueId: 'HOK-997',
      slug: 'fallback-stage',
      prompt: 'irrelevant',
      primaryModel: 'claude-opus-4-6',
      challengeStage: 'plan',
      randomFn: () => 0,
      routeFn: plannerlessRoute,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'implementation');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);
});

test('pickChallengeWorkflowsWithContext varies the planner from a route snapshot', () => {
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-5-20250929',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-5-20250929',
    reviewMode: 'llm',
    planner: 'claude-opus-4-6',
    planDepth: 'deep',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-998',
      issueId: 'HOK-998',
      slug: 'snapshot-plan-stage',
      prompt: 'irrelevant',
      challengeStage: 'plan',
      randomFn: () => 0,
    },
    { bootstrap: null, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'plan');
  assert.equal(pair!.routeContext.decisionSource, 'expanded');
  // Coder shared from the route; planner varied on the challenger only
  assert.equal(pair!.primary.model, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.challenger.model, 'claude-sonnet-4-5-20250929');
  assert.equal(pair!.primary.planner, 'claude-opus-4-6');
  assert.notEqual(pair!.challenger.planner, 'claude-opus-4-6');
  assert.equal(pair!.primary.reviewer, pair!.challenger.reviewer);
  assert.equal(pair!.challenger.planDepth, 'deep');
});

test('pickChallengeWorkflowsWithContext keeps coder variation by default', () => {
  const expanded: RouteArtifactSnapshot = {
    coder: 'claude-sonnet-4-5-20250929',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-5-20250929',
    reviewMode: 'llm',
    planner: 'claude-opus-4-6',
    planDepth: 'light',
  };

  const pair = pickChallengeWorkflowsWithContext(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
    {
      pairId: 'HOK-999',
      issueId: 'HOK-999',
      slug: 'default-stage',
      prompt: 'irrelevant',
      randomFn: () => 0,
    },
    { bootstrap: null, expanded },
  );

  assert.ok(pair);
  assert.equal(pair!.challengeStage, 'implementation');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);
  assert.equal(pair!.primary.planner, pair!.challenger.planner);
  assert.equal(pair!.primary.reviewer, pair!.challenger.reviewer);
});


process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});
