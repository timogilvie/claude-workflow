/**
 * Tests for the challenge scheduler.
 */

import assert from 'node:assert/strict';
import {
  evaluateChallenge,
  checkLowConfidence,
  checkNewModel,
  checkLowDataStage,
  type ChallengeSchedulerInput,
  type ChallengeSchedulerConfig,
  type ChallengeRecommendation,
} from './challenge-scheduler.ts';
import type { StageAwareDecision } from './stage-aware-router.ts';

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

// ────────────────────────────────────────────────────────────────
// Mock Data Builders
// ────────────────────────────────────────────────────────────────

function makeDecision(overrides: Partial<StageAwareDecision> = {}): StageAwareDecision {
  return {
    planner: 'claude-opus-4-6',
    coder: 'claude-sonnet-4-5-20250929',
    reviewer: 'claude-haiku-4-5-20251001',
    planDepth: 'light',
    codeDepth: 'medium',
    reviewRecommended: 'llm',
    expectedSuccess: 0.75,
    expectedCostPlan: 1.0,
    expectedCostCode: 2.5,
    expectedCostReview: 0.5,
    reasoning: ['test decision'],
    signals: {
      taskType: 'feature',
      promptLength: 'medium',
      complexityScore: 0.6,
      fileTypes: ['ts'],
      riskScore: 0.5,
    },
    routingMode: 'stage-aware',
    neighborCount: 5,
    neighborSimilarityRange: [0.7, 0.95],
    expectedCost: 4.0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ChallengeSchedulerConfig> = {}): ChallengeSchedulerConfig {
  return {
    enabled: true,
    confidenceThreshold: 0.7,
    newModelChallengeCount: 5,
    minEvalRecordsPerStage: 10,
    maxConcurrentChallenges: 2,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<ChallengeSchedulerInput> = {},
): ChallengeSchedulerInput {
  return {
    routingDecision: makeDecision(overrides.routingDecision),
    evalSummary: {
      'claude-opus-4-6': 50,
      'claude-sonnet-4-5-20250929': 48,
      'gpt-5.4': 3,
    },
    stageEvalCounts: {
      planning: 45,
      coding: 48,
      review: 8,
    },
    config: makeConfig(overrides.config),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// checkLowConfidence Tests
// ────────────────────────────────────────────────────────────────

test('checkLowConfidence: recommends challenge when confidence below threshold', () => {
  const decision = makeDecision({ expectedSuccess: 0.65 });
  const result = checkLowConfidence(decision, 0.7, {
    'claude-opus-4-6': 50,
    'claude-sonnet-4-5-20250929': 48,
  });

  assert.ok(result);
  assert.strictEqual(result.reason, 'low-confidence');
  assert.strictEqual(result.defaultModel, 'claude-opus-4-6');
  assert.strictEqual(result.challengerModel, 'claude-sonnet-4-5-20250929');
  assert.ok(result.priority > 0);
  assert.ok(result.priority <= 5);
});

test('checkLowConfidence: returns null when confidence at threshold', () => {
  const decision = makeDecision({ expectedSuccess: 0.7 });
  const result = checkLowConfidence(decision, 0.7, {
    'claude-opus-4-6': 50,
    'claude-sonnet-4-5-20250929': 48,
  });

  assert.strictEqual(result, null);
});

test('checkLowConfidence: returns null when confidence above threshold', () => {
  const decision = makeDecision({ expectedSuccess: 0.8 });
  const result = checkLowConfidence(decision, 0.7, {
    'claude-opus-4-6': 50,
    'claude-sonnet-4-5-20250929': 48,
  });

  assert.strictEqual(result, null);
});

test('checkLowConfidence: returns null when only one candidate model', () => {
  const decision = makeDecision({ expectedSuccess: 0.65 });
  const result = checkLowConfidence(decision, 0.7, {
    'claude-opus-4-6': 50,
  });

  assert.strictEqual(result, null);
});

test('checkLowConfidence: calculates priority based on confidence gap', () => {
  const decision1 = makeDecision({ expectedSuccess: 0.65 });
  const result1 = checkLowConfidence(decision1, 0.7, {
    'claude-opus-4-6': 50,
    'claude-sonnet-4-5-20250929': 48,
  });

  const decision2 = makeDecision({ expectedSuccess: 0.35 });
  const result2 = checkLowConfidence(decision2, 0.7, {
    'claude-opus-4-6': 50,
    'claude-sonnet-4-5-20250929': 48,
  });

  assert.ok(result1 && result2);
  assert.ok(result2.priority > result1.priority);
});

test('checkLowConfidence: handles undefined expectedSuccess as 0', () => {
  const decision = makeDecision({ expectedSuccess: undefined as unknown as number });
  const result = checkLowConfidence(decision, 0.7, {
    'claude-opus-4-6': 50,
    'claude-sonnet-4-5-20250929': 48,
  });

  assert.ok(result);
  assert.strictEqual(result.reason, 'low-confidence');
});

// ────────────────────────────────────────────────────────────────
// checkNewModel Tests
// ────────────────────────────────────────────────────────────────

test('checkNewModel: recommends challenge for model with < N evals', () => {
  const config = makeConfig();
  const decision = makeDecision();
  const result = checkNewModel(config, {
    'claude-opus-4-6': 50,
    'gpt-5.4': 2, // < 5
  }, decision);

  assert.ok(result);
  assert.strictEqual(result.reason, 'new-model');
  assert.strictEqual(result.challengerModel, 'gpt-5.4');
  assert.strictEqual(result.priority, 3);
});

test('checkNewModel: returns null when all models have sufficient data', () => {
  const config = makeConfig({ newModelChallengeCount: 5 });
  const decision = makeDecision();
  const result = checkNewModel(config, {
    'claude-opus-4-6': 50,
    'claude-sonnet-4-5-20250929': 48,
  }, decision);

  assert.strictEqual(result, null);
});

test('checkNewModel: uses coder as default model', () => {
  const config = makeConfig();
  const decision = makeDecision({
    coder: 'claude-sonnet-4-5-20250929',
  });
  const result = checkNewModel(config, {
    'claude-opus-4-6': 50,
    'gpt-5.4': 1,
  }, decision);

  assert.ok(result);
  assert.strictEqual(result.defaultModel, 'claude-sonnet-4-5-20250929');
});

// ────────────────────────────────────────────────────────────────
// checkLowDataStage Tests
// ────────────────────────────────────────────────────────────────

test('checkLowDataStage: recommends challenge for stage with < N evals', () => {
  const config = makeConfig({ minEvalRecordsPerStage: 10 });
  const decision = makeDecision();
  const result = checkLowDataStage(config, {
    planning: 45,
    coding: 48,
    review: 5, // < 10
  }, decision);

  assert.ok(result);
  assert.strictEqual(result.reason, 'low-data-stage');
  assert.strictEqual(result.stage, 'review');
  assert.strictEqual(result.priority, 2);
});

test('checkLowDataStage: returns null when all stages have sufficient data', () => {
  const config = makeConfig({ minEvalRecordsPerStage: 10 });
  const decision = makeDecision();
  const result = checkLowDataStage(config, {
    planning: 45,
    coding: 48,
    review: 10,
  }, decision);

  assert.strictEqual(result, null);
});

test('checkLowDataStage: selects appropriate stage model', () => {
  const config = makeConfig();
  const decision = makeDecision({
    planner: 'claude-opus-4-6',
    coder: 'claude-sonnet-4-5-20250929',
    reviewer: 'claude-haiku-4-5-20251001',
  });
  const result = checkLowDataStage(config, {
    planning: 5,
    coding: 48,
    review: 15,
  }, decision);

  assert.ok(result);
  assert.strictEqual(result.stage, 'planning');
  assert.strictEqual(result.defaultModel, 'claude-opus-4-6');
});

// ────────────────────────────────────────────────────────────────
// evaluateChallenge Tests
// ────────────────────────────────────────────────────────────────

test('evaluateChallenge: returns disabled when config.enabled = false', () => {
  const input = makeInput({
    config: makeConfig({ enabled: false }),
  });
  const result = evaluateChallenge(input);

  assert.strictEqual(result.shouldChallenge, false);
  assert.strictEqual(result.reason, 'disabled');
  assert.strictEqual(result.priority, 0);
});

test('evaluateChallenge: returns no-challenge when no triggers fire', () => {
  const input = makeInput({
    routingDecision: makeDecision({ expectedSuccess: 0.8 }),
    evalSummary: {
      'claude-opus-4-6': 50,
      'claude-sonnet-4-5-20250929': 48,
    },
    stageEvalCounts: {
      planning: 45,
      coding: 48,
      review: 15,
    },
  });
  const result = evaluateChallenge(input);

  assert.strictEqual(result.shouldChallenge, false);
  assert.strictEqual(result.priority, 0);
});

test('evaluateChallenge: returns highest-priority recommendation when multiple triggers fire', () => {
  const input = makeInput({
    routingDecision: makeDecision({ expectedSuccess: 0.35 }), // low confidence = priority ~3
    config: makeConfig({
      confidenceThreshold: 0.7,
      newModelChallengeCount: 5,
      minEvalRecordsPerStage: 10,
    }),
    evalSummary: {
      'claude-opus-4-6': 50,
      'claude-sonnet-4-5-20250929': 48,
      'gpt-5.4': 1, // new model = priority 3
    },
    stageEvalCounts: {
      planning: 45,
      coding: 48,
      review: 5, // low data = priority 2
    },
  });
  const result = evaluateChallenge(input);

  assert.strictEqual(result.shouldChallenge, true);
  assert.ok(result.reason === 'low-confidence'); // highest priority
});

test('evaluateChallenge: low confidence has priority over new model', () => {
  const input = makeInput({
    routingDecision: makeDecision({ expectedSuccess: 0.35 }), // priority 5 (very low confidence)
    config: makeConfig(),
    evalSummary: {
      'claude-opus-4-6': 50,
      'claude-sonnet-4-5-20250929': 1, // new model = priority 3
    },
  });
  const result = evaluateChallenge(input);

  assert.ok(result.shouldChallenge);
  assert.strictEqual(result.reason, 'low-confidence');
});

// ────────────────────────────────────────────────────────────────
// Test Summary
// ────────────────────────────────────────────────────────────────

console.log(`\n  Challenge Scheduler Tests\n`);
console.log(`  ${passed} passed`);
console.log(`  ${failed} failed`);
if (failed > 0) process.exit(1);
