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
      enabled: true,
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
    assert.equal(result.reason, 'new-model');
    assert.equal(result.defaultModel, 'claude-fable-5');
    assert.ok(result.challengerModel);
    assert.notEqual(result.challengerModel, result.defaultModel);
  } finally {
    cleanup();
  }
});

test('limits recommendations to the configured challenge pool', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ coder: 'gpt-5.4' }),
      evalSummary: makeDenseSummary({
        recordsByModel: {
          'claude-sonnet-4-5-20250929': 100,
          'gpt-5.4': 100,
          'gpt-5.3-codex': 0,
          'glm-5.2': 0,
          'kimi-k2.7-code': 0,
        },
      }),
      config: { enabled: true, confidenceThreshold: 0, newModelChallengeCount: 25, minEvalRecordsPerStage: 1 },
      challengeModels: ['glm-5.2', 'kimi-k2.7-code'],
      repoDir,
    });

    assert.equal(result.shouldChallenge, true);
    assert.equal(result.reason, 'new-model');
    assert.ok(['glm-5.2', 'kimi-k2.7-code'].includes(result.challengerModel || ''));
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

    assert.equal(result.shouldChallenge, true);
    assert.equal(result.reason, 'new-model');
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
    assert.equal(result.defaultModel, 'claude-fable-5');
    assert.equal(result.challengerModel, 'claude-haiku-4-5');
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
    assert.equal(result.reason, 'new-model');
  } finally {
    cleanup();
  }
});

test('prioritizes exploration coverage over low-confidence triggers', () => {
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

    assert.equal(result.reason, 'new-model');
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
    assert.equal(result.reason, 'new-model');
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


test('buildEvalSummary computes the model x stage cross product', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    writeFileSync(
      join(repoDir, '.wavemill', 'evals', 'records.jsonl'),
      [
        JSON.stringify({
          id: 'cp-1',
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
        }),
        JSON.stringify({
          id: 'cp-2',
          modelId: 'gpt-5.4',
          timestamp: '2026-04-06T12:05:00.000Z',
          originalPrompt: 'Implement another feature',
          taskDescriptor: {
            stages: {
              planner: { model: 'claude-sonnet-4-5-20250929' },
              coder: { model: 'gpt-5.4' },
              reviewer: { model: 'gpt-5.3-codex' },
            },
          },
        }),
        // Legacy record without per-stage attribution: only the coder
        // (modelId) is attributable
        JSON.stringify({
          id: 'cp-3',
          modelId: 'gpt-5.3-codex',
          timestamp: '2026-04-06T12:10:00.000Z',
          originalPrompt: 'Fix a bug',
        }),
      ].join('\n') + '\n',
    );

    const summary = buildEvalSummary(repoDir);

    assert.equal(summary.recordsByModelStage?.['claude-sonnet-4-5-20250929']?.plan, 2);
    assert.equal(summary.recordsByModelStage?.['claude-sonnet-4-5-20250929']?.review, 1);
    assert.equal(summary.recordsByModelStage?.['claude-sonnet-4-5-20250929']?.implementation, undefined);
    assert.equal(summary.recordsByModelStage?.['gpt-5.4']?.implementation, 2);
    assert.equal(summary.recordsByModelStage?.['gpt-5.3-codex']?.review, 1);
    // Legacy record falls back to modelId for the implementation stage only
    assert.equal(summary.recordsByModelStage?.['gpt-5.3-codex']?.implementation, 1);
    assert.equal(summary.recordsByModelStage?.['gpt-5.3-codex']?.plan, undefined);
  } finally {
    cleanup();
  }
});

test('new-model recommendation targets the least-covered (model, stage) cell', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ confidence: 0.95 }),
      // Pinned pool: without it the recommendation is drawn from the whole
      // registry, where some unrelated zero-coverage model wins and the cell
      // logic under test never decides anything.
      challengeModels: ['claude-sonnet-4-5-20250929', 'gpt-5.4'],
      evalSummary: {
        totalRecords: 60,
        recordsByModel: { 'claude-sonnet-4-5-20250929': 40, 'gpt-5.4': 20 },
        recordsByStage: { plan: 60, implementation: 60, review: 60 },
        recordsByModelStage: {
          'claude-sonnet-4-5-20250929': { plan: 40, implementation: 40, review: 40 },
          // Plenty of plan/coder records but zero review coverage
          'gpt-5.4': { plan: 20, implementation: 20 },
        },
      },
      config: { enabled: true, confidenceThreshold: 0.5, newModelChallengeCount: 5, minEvalRecordsPerStage: 1 },
      repoDir,
    });

    assert.equal(result.shouldChallenge, true);
    assert.equal(result.reason, 'new-model');
    assert.equal(result.challengerModel, 'gpt-5.4');
    assert.equal(result.stage, 'review');
  } finally {
    cleanup();
  }
});

test('low-data-stage recommendation picks the least-tested model for that stage', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ confidence: 0.95, coder: 'claude-haiku-4-5-20251001' }),
      // Pinned pool: every model here already clears newModelChallengeCount, so
      // the low-data-stage rule is what decides. Left unpinned, the registry
      // supplies zero-coverage models and the higher-priority new-model rule
      // pre-empts the behaviour this test is named for.
      challengeModels: ['claude-sonnet-4-5-20250929', 'gpt-5.4', 'claude-haiku-4-5-20251001'],
      evalSummary: {
        totalRecords: 44,
        recordsByModel: { 'claude-sonnet-4-5-20250929': 40, 'gpt-5.4': 31, 'claude-haiku-4-5-20251001': 10 },
        recordsByStage: { plan: 4, implementation: 40, review: 40 },
        recordsByModelStage: {
          'claude-sonnet-4-5-20250929': { plan: 5, implementation: 30, review: 30 },
          // haiku has fewer records overall, but MORE plan records than
          // gpt-5.4; per-stage selection must pick gpt-5.4 for the starved
          // plan stage (the overall-count heuristic would pick haiku)
          'gpt-5.4': { plan: 1, implementation: 30, review: 30 },
          'claude-haiku-4-5-20251001': { plan: 3, implementation: 3, review: 4 },
        },
      },
      config: { enabled: true, confidenceThreshold: 0.5, newModelChallengeCount: 1, minEvalRecordsPerStage: 10 },
      repoDir,
    });

    assert.equal(result.shouldChallenge, true);
    assert.equal(result.reason, 'low-data-stage');
    assert.equal(result.stage, 'plan');
    assert.equal(result.challengerModel, 'gpt-5.4');
  } finally {
    cleanup();
  }
});



test('new-model recommendation uses the global registry release metadata', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ confidence: 0.95 }),
      // All incumbents, so the launch-priority preference is a no-op here and
      // recency is the only thing that can decide: claude-sonnet-5 must win
      // despite gpt-5.4 having strictly fewer records in every stage.
      challengeModels: ['claude-sonnet-4-5-20250929', 'gpt-5.4', 'claude-sonnet-5'],
      evalSummary: {
        totalRecords: 100,
        recordsByModel: { 'claude-sonnet-4-5-20250929': 90, 'gpt-5.4': 0, 'claude-sonnet-5': 9 },
        recordsByStage: { plan: 100, implementation: 100, review: 100 },
        recordsByModelStage: {
          'claude-sonnet-4-5-20250929': { plan: 90, implementation: 90, review: 90 },
          'gpt-5.4': {},
          'claude-sonnet-5': { plan: 3, implementation: 3, review: 3 },
        },
      },
      config: { enabled: true, confidenceThreshold: 0.5, newModelChallengeCount: 5, minEvalRecordsPerStage: 1 },
      repoDir,
    });

    assert.equal(result.shouldChallenge, true);
    assert.equal(result.reason, 'new-model');
    assert.equal(result.challengerModel, 'claude-sonnet-5');
    assert.equal(result.stage, 'plan');
  } finally {
    cleanup();
  }
});

test('exploration recommendations prefer non-incumbent families over recency', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ confidence: 0.95 }),
      challengeModels: ['claude-sonnet-5', 'glm-5.2'],
      evalSummary: {
        totalRecords: 20,
        recordsByModel: { 'claude-sonnet-5': 0, 'glm-5.2': 0 },
        recordsByStage: { plan: 20, implementation: 20, review: 20 },
        // Both fully uncovered. claude-sonnet-5 is inside the recency window
        // and sorts first alphabetically, so it used to win every cell; the
        // launch-priority preference must hand exploration to glm-5.2 instead.
        recordsByModelStage: { 'claude-sonnet-5': {}, 'glm-5.2': {} },
      },
      config: { enabled: true, confidenceThreshold: 0.5, newModelChallengeCount: 5, minEvalRecordsPerStage: 1 },
      repoDir,
    });

    assert.equal(result.shouldChallenge, true);
    assert.equal(result.reason, 'new-model');
    assert.equal(result.challengerModel, 'glm-5.2');
  } finally {
    cleanup();
  }
});

test('exploration recommendations skip stages a model cannot serve', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = evaluateChallenge({
      routingDecision: makeDecision({ confidence: 0.95 }),
      // qwen-3-coder is role-ineligible as a planner, so its uncovered plan
      // cell must not be recommended even though it sorts first on count.
      challengeModels: ['qwen-3-coder'],
      evalSummary: {
        totalRecords: 20,
        recordsByModel: { 'qwen-3-coder': 0 },
        recordsByStage: { plan: 20, implementation: 20, review: 20 },
        recordsByModelStage: { 'qwen-3-coder': {} },
      },
      config: { enabled: true, confidenceThreshold: 0.5, newModelChallengeCount: 5, minEvalRecordsPerStage: 1 },
      repoDir,
    });

    assert.equal(result.challengerModel, 'qwen-3-coder');
    assert.notEqual(result.stage, 'plan');
  } finally {
    cleanup();
  }
});


console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
