/**
 * Tests for the challenge scheduler policy.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildEvalSummary,
  clearChallengeSchedulerCache,
  evaluateChallenge,
  type EvalSummary,
} from './challenge-scheduler.ts';
import { clearConfigCache } from './config.ts';
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

function makeRepo(config: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'challenge-scheduler-test-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    router: {
      defaultModel: 'claude-sonnet-4-5-20250929',
      models: ['claude-sonnet-4-5-20250929', 'gpt-5.4', 'gpt-5.3-codex'],
    },
    eval: {
      pricing: {
        'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15 },
        'gpt-5.4': { inputCostPerMTok: 2, outputCostPerMTok: 10 },
        'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14 },
      },
    },
    ...config,
  }));

  clearConfigCache(repoDir);
  clearChallengeSchedulerCache(repoDir);

  return {
    repoDir,
    cleanup: () => {
      clearConfigCache(repoDir);
      clearChallengeSchedulerCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function makeDecision(overrides: Partial<WorkflowRouteDecision> = {}): WorkflowRouteDecision {
  return {
    planner: 'claude-sonnet-4-5-20250929',
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-5-20250929',
    planDepth: 'light',
    codeDepth: 'medium',
    reviewRecommended: 'llm',
    expectedSuccess: 0.82,
    confidence: 0.82,
    expectedCostPlan: 1,
    expectedCostCode: 2,
    expectedCostReview: 1,
    reasoning: ['reason one', 'reason two'],
    signals: {
      taskType: 'feature',
      promptLength: 'medium',
      complexityScore: 2,
      fileTypes: ['.ts'],
      riskScore: 3,
    },
    ...overrides,
  };
}

function makeDenseSummary(overrides: Partial<EvalSummary> = {}): EvalSummary {
  return {
    totalRecords: 30,
    recordsByModel: {
      'claude-sonnet-4-5-20250929': 12,
      'gpt-5.4': 12,
      'gpt-5.3-codex': 12,
      ...(overrides.recordsByModel || {}),
    },
    recordsByStage: {
      plan: 12,
      implementation: 12,
      review: 12,
      ...(overrides.recordsByStage || {}),
    },
  };
}

console.log('\n--- challenge-scheduler Tests ---\n');

test('recommends challenge when confidence is below threshold', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ expectedSuccess: 0.9, confidence: 0.6 }),
      evalSummary: makeDenseSummary(),
      config: { enabled: true, confidenceThreshold: 0.7 },
      repoDir,
    });

    assert.equal(result.shouldChallenge, true);
    assert.equal(result.reason, 'low-confidence');
    assert.equal(result.defaultModel, 'gpt-5.4');
    assert.equal(result.challengerModel, 'claude-sonnet-4-5-20250929');
  } finally {
    cleanup();
  }
});

test('skips challenge when forceModel is set', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ expectedSuccess: 0.95, confidence: 0.2 }),
      evalSummary: makeDenseSummary({
        recordsByModel: {
          'claude-sonnet-4-5-20250929': 12,
          'gpt-5.4': 1,
          'gpt-5.3-codex': 0,
        },
        recordsByStage: {
          plan: 1,
          implementation: 1,
          review: 1,
        },
      }),
      config: { enabled: true, confidenceThreshold: 0.7, newModelChallengeCount: 5, minEvalRecordsPerStage: 10 },
      repoDir,
      forceModel: 'gpt-5.4',
    });

    assert.equal(result.shouldChallenge, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(result.priority, 0);
  } finally {
    cleanup();
  }
});

test('does not trigger low-confidence challenge at threshold', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ expectedSuccess: 0.2, confidence: 0.7 }),
      evalSummary: makeDenseSummary(),
      config: { enabled: true, confidenceThreshold: 0.7, newModelChallengeCount: 1, minEvalRecordsPerStage: 1 },
      repoDir,
    });

    assert.equal(result.shouldChallenge, false);
  } finally {
    cleanup();
  }
});

test('recommends new model challenge when a model has fewer records than threshold', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ coder: 'claude-sonnet-4-5-20250929' }),
      evalSummary: makeDenseSummary({
        recordsByModel: {
          'claude-sonnet-4-5-20250929': 12,
          'gpt-5.4': 0,
          'gpt-5.3-codex': 8,
        },
      }),
      config: { enabled: true, newModelChallengeCount: 5, confidenceThreshold: 0.2, minEvalRecordsPerStage: 1 },
      repoDir,
    });

    assert.equal(result.shouldChallenge, true);
    assert.equal(result.reason, 'new-model');
    assert.equal(result.defaultModel, 'claude-sonnet-4-5-20250929');
    assert.equal(result.challengerModel, 'gpt-5.4');
  } finally {
    cleanup();
  }
});

test('recommends stage-specific challenge when a stage lacks data', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({
        planner: 'claude-sonnet-4-5-20250929',
        coder: 'gpt-5.4',
        reviewer: 'claude-sonnet-4-5-20250929',
      }),
      evalSummary: makeDenseSummary({
        recordsByModel: {
          'claude-sonnet-4-5-20250929': 12,
          'gpt-5.4': 4,
          'gpt-5.3-codex': 1,
        },
        recordsByStage: {
          plan: 10,
          implementation: 2,
          review: 11,
        },
      }),
      config: { enabled: true, confidenceThreshold: 0.2, newModelChallengeCount: 1, minEvalRecordsPerStage: 5 },
      repoDir,
    });

    assert.equal(result.shouldChallenge, true);
    assert.equal(result.reason, 'low-data-stage');
    assert.equal(result.stage, 'implementation');
    assert.equal(result.defaultModel, 'gpt-5.4');
    assert.equal(result.challengerModel, 'claude-sonnet-4-5-20250929');
  } finally {
    cleanup();
  }
});

test('prioritizes low-confidence over new-model and low-data-stage triggers', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ expectedSuccess: 0.95, confidence: 0.3 }),
      evalSummary: makeDenseSummary({
        recordsByModel: {
          'claude-sonnet-4-5-20250929': 10,
          'gpt-5.4': 1,
          'gpt-5.3-codex': 0,
        },
        recordsByStage: {
          plan: 1,
          implementation: 1,
          review: 1,
        },
      }),
      config: { enabled: true, confidenceThreshold: 0.7, newModelChallengeCount: 5, minEvalRecordsPerStage: 10 },
      repoDir,
    });

    assert.equal(result.reason, 'low-confidence');
    assert.equal(result.priority, 300);
  } finally {
    cleanup();
  }
});

test('uses routing confidence instead of expected success as the low-confidence signal', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ expectedSuccess: 0.95, confidence: 0.4 }),
      evalSummary: makeDenseSummary(),
      config: { enabled: true, confidenceThreshold: 0.7, newModelChallengeCount: 5, minEvalRecordsPerStage: 10 },
      repoDir,
    });

    assert.equal(result.shouldChallenge, true);
    assert.equal(result.reason, 'low-confidence');
  } finally {
    cleanup();
  }
});

test('returns disabled recommendation when scheduler is disabled', () => {
  const result = evaluateChallenge({
    routingDecision: makeDecision({ expectedSuccess: 0.1 }),
    evalSummary: makeDenseSummary(),
    config: { enabled: false },
  });

  assert.equal(result.shouldChallenge, false);
  assert.equal(result.reason, 'disabled');
});

test('buildEvalSummary counts models and stages once per unique record', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const sharedRecord = {
      id: 'rec-1',
      modelId: 'gpt-5.4',
      timestamp: '2026-04-06T12:00:00.000Z',
      originalPrompt: 'Implement feature',
      taskDescriptor: {
        stages: {
          planner: { model: 'claude-sonnet-4-5-20250929' },
          coder: { model: 'gpt-5.4' },
          reviewer: { model: 'claude-sonnet-4-5-20250929' },
        },
      },
      metadata: {
        stageScores: {
          plan: { score: 0.9 },
          implementation: { score: 0.8 },
          review: { score: 0.85 },
        },
      },
    };

    writeFileSync(
      join(repoDir, '.wavemill', 'evals', 'one.jsonl'),
      `${JSON.stringify(sharedRecord)}\n`,
    );
    writeFileSync(
      join(repoDir, '.wavemill', 'evals', 'two.jsonl'),
      `${JSON.stringify(sharedRecord)}\n${JSON.stringify({
        id: 'rec-2',
        modelId: 'gpt-5.3-codex',
        timestamp: '2026-04-06T12:05:00.000Z',
        originalPrompt: 'Review change',
        stageOutcomes: {
          review: { score: 0.9, rationale: 'solid' },
        },
      })}\n`,
    );

    const summary = buildEvalSummary(repoDir);

    assert.equal(summary.totalRecords, 2);
    assert.equal(summary.recordsByModel['gpt-5.4'], 1);
    assert.equal(summary.recordsByModel['gpt-5.3-codex'], 1);
    assert.equal(summary.recordsByModel['claude-sonnet-4-5-20250929'], 1);
    assert.equal(summary.recordsByStage.plan, 1);
    assert.equal(summary.recordsByStage.implementation, 1);
    assert.equal(summary.recordsByStage.review, 2);
  } finally {
    cleanup();
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
