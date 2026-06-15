/**
 * Tests for Hokusai router audit metrics.
 */

import assert from 'node:assert/strict';
import type { EvalRecord } from './eval-schema.ts';
import type {
  HokusaiModel30EstimatedComplexity,
  HokusaiModel30Request,
  HokusaiModel30TaskType,
} from './hokusai-schema.ts';
import {
  buildCalibration,
  buildGroupBreakdowns,
  buildLaunchPriorityCoverage,
  buildStageShares,
  classifyValidityViolations,
  computeRegret,
  effectiveModelCount,
  stratifiedSampleRecords,
  summarizeDeterminism,
  summarizeSensitivity,
  type AuditRecommendation,
} from './hokusai-router-audit.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function makeRecord(id: string, taskType: string, timestamp: string, score = 0.8): EvalRecord {
  return {
    id,
    schemaVersion: '1.0.0',
    originalPrompt: `${taskType} task`,
    modelId: 'gpt-5.5',
    modelVersion: 'gpt-5.5',
    score,
    scoreBand: 'good',
    timeSeconds: 100,
    timestamp,
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    repoContext: {
      repoId: id.startsWith('a') ? 'repo-a' : 'repo-b',
      repoVisibility: 'private',
      primaryLanguage: 'TypeScript',
      repoSize: { fileCount: 100, loc: 10_000, dependencyCount: 20 },
    },
    taskContext: {
      taskType: taskType as EvalRecord['taskContext']['taskType'],
      changeKind: 'modify',
      complexity: 0.5,
    },
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: taskType,
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 3,
          repo_size_loc: 10_000,
          description_tokens: 50,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
        learned: { complexity: 3, domain: 'backend', risk_flags: [] },
      },
      constraints: { models_available: ['gpt-5.5', 'gpt-5.4'], objective: 'balanced' },
      stages: {
        planner: { model: 'gpt-5.5' },
        coder: { model: 'gpt-5.5' },
        reviewer: { model: 'gpt-5.4' },
      },
    },
  } as EvalRecord;
}

function makeRequest(
  taskType: HokusaiModel30TaskType,
  complexity?: HokusaiModel30EstimatedComplexity,
  domain?: string,
): HokusaiModel30Request {
  return {
    inputs: {
      task: {
        description: 'test',
        task_type: taskType,
      },
      ...((complexity || domain)
        ? {
          context: {
            ...(complexity ? { estimated_complexity: complexity } : {}),
            ...(domain ? { domain } : {}),
          },
        }
        : {}),
    },
  };
}

function makeRecommendation(
  record: EvalRecord,
  models: { planner: string; coder: string; reviewer: string },
  estimated = 0.8,
  request: HokusaiModel30Request = makeRequest('feature'),
): AuditRecommendation {
  return {
    evalId: record.id,
    strategy: {
      planner_model: models.planner,
      coder_model: models.coder,
      reviewer_model: models.reviewer,
      estimated_success_under_budget: estimated,
    },
    request,
    candidatePools: {
      planner: ['gpt-5.5', 'gpt-5.4'],
      coder: ['gpt-5.5', 'gpt-5.4'],
      reviewer: ['gpt-5.5', 'gpt-5.4'],
    },
    originalRecord: record,
    actualScore: record.score,
    actualStageModels: {
      plan: record.taskDescriptor?.stages?.planner?.model,
      implementation: record.taskDescriptor?.stages?.coder?.model,
      review: record.taskDescriptor?.stages?.reviewer?.model,
    },
  };
}

console.log('\n--- hokusai-router-audit Tests ---\n');

test('effectiveModelCount returns one for a single-model distribution', () => {
  assert.equal(effectiveModelCount([{ model: 'gpt-5.5', count: 10, share: 1 }]), 1);
});

test('effectiveModelCount returns two for a balanced two-model distribution', () => {
  assert.equal(Math.round(effectiveModelCount([
    { model: 'gpt-5.5', count: 5, share: 0.5 },
    { model: 'gpt-5.4', count: 5, share: 0.5 },
  ]) * 100) / 100, 2);
});

test('stratifiedSampleRecords walks across task/time/repo buckets', () => {
  const records = [
    makeRecord('a1', 'feature', '2026-06-01T00:00:00Z'),
    makeRecord('a2', 'feature', '2026-06-02T00:00:00Z'),
    makeRecord('b1', 'bugfix', '2026-06-01T00:00:00Z'),
    makeRecord('b2', 'docs', '2026-05-01T00:00:00Z'),
  ];
  const sampled = stratifiedSampleRecords(records, 3);
  assert.equal(sampled.length, 3);
  assert.equal(new Set(sampled.map((record) => record.taskContext?.taskType)).size, 3);
});

test('buildStageShares counts recommendations by role', () => {
  const records = [makeRecord('a1', 'feature', '2026-06-01T00:00:00Z'), makeRecord('a2', 'feature', '2026-06-02T00:00:00Z')];
  const shares = buildStageShares([
    makeRecommendation(records[0], { planner: 'gpt-5.5', coder: 'gpt-5.5', reviewer: 'gpt-5.4' }),
    makeRecommendation(records[1], { planner: 'gpt-5.4', coder: 'gpt-5.5', reviewer: 'gpt-5.4' }),
  ]);
  assert.equal(shares.coder[0].model, 'gpt-5.5');
  assert.equal(shares.coder[0].share, 1);
  assert.equal(shares.planner.length, 2);
});

test('classifyValidityViolations flags models outside the sent pool', () => {
  const record = makeRecord('a1', 'feature', '2026-06-01T00:00:00Z');
  const violations = classifyValidityViolations([
    makeRecommendation(record, { planner: 'gpt-5.5', coder: 'not-a-model', reviewer: 'gpt-5.4' }),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].role, 'coder');
  assert.deepEqual(violations[0].reasons, ['not_in_candidate_pool', 'unknown_model']);
});

test('summarizeDeterminism and summarizeSensitivity detect constant output', () => {
  const strategy = { planner_model: 'gpt-5.5', coder_model: 'gpt-5.5', reviewer_model: 'gpt-5.4' };
  assert.deepEqual(summarizeDeterminism([[strategy, strategy]]), {
    attempted: 1,
    stablePairs: 1,
    allStable: true,
  });
  assert.deepEqual(summarizeSensitivity([strategy, strategy]), {
    attempted: 2,
    distinctRecommendationCount: 1,
    allIdentical: true,
  });
});

test('buildCalibration buckets exact route matches', () => {
  const records = [
    makeRecord('a1', 'feature', '2026-06-01T00:00:00Z', 0.2),
    makeRecord('a2', 'feature', '2026-06-02T00:00:00Z', 0.8),
  ];
  const calibration = buildCalibration([
    makeRecommendation(records[0], { planner: 'gpt-5.5', coder: 'gpt-5.5', reviewer: 'gpt-5.4' }, 0.3),
    makeRecommendation(records[1], { planner: 'gpt-5.5', coder: 'gpt-5.5', reviewer: 'gpt-5.4' }, 0.9),
  ]);
  assert.equal(calibration.length, 2);
  assert.equal(calibration[0].meanActualScore, 0.2);
  assert.equal(calibration[1].meanEstimatedSuccess, 0.9);
});

test('buildGroupBreakdowns exposes task-type-specific top recommendations', () => {
  const feature = makeRecord('a1', 'feature', '2026-06-01T00:00:00Z');
  const docs = makeRecord('b1', 'docs', '2026-06-02T00:00:00Z');
  const breakdowns = buildGroupBreakdowns([
    makeRecommendation(
      feature,
      { planner: 'gpt-5.5', coder: 'gpt-5.5', reviewer: 'gpt-5.4' },
      0.8,
      makeRequest('feature', 'high', 'backend'),
    ),
    makeRecommendation(
      docs,
      { planner: 'gpt-5.4', coder: 'gpt-5.4', reviewer: 'gpt-5.5' },
      0.8,
      makeRequest('maintenance', 'low', 'devops'),
    ),
  ]);
  assert.equal(breakdowns.taskType.length, 2);
  assert.deepEqual(breakdowns.taskType.map((entry) => entry.group).sort(), ['feature', 'maintenance']);
  assert.deepEqual(breakdowns.complexity.map((entry) => entry.group).sort(), ['high', 'low']);
  assert.deepEqual(breakdowns.domain.map((entry) => entry.group).sort(), ['backend', 'devops']);
  const maintenanceBreakdown = breakdowns.taskType.find((entry) => entry.group === 'maintenance');
  assert.equal(maintenanceBreakdown?.stageShares.coder[0].model, 'gpt-5.4');
  assert.equal(maintenanceBreakdown?.effectiveModelCounts.coder, 1);
});

test('buildGroupBreakdowns exposes request-normalized and descriptor-derived task types separately', () => {
  const docs = makeRecord('b1', 'docs', '2026-06-02T00:00:00Z');
  docs.originalPrompt = 'Update documentation for the CLI and add examples.';
  const breakdowns = buildGroupBreakdowns([
    makeRecommendation(
      docs,
      { planner: 'gpt-5.4', coder: 'gpt-5.4', reviewer: 'gpt-5.5' },
      0.8,
      makeRequest('maintenance', 'low', 'devops'),
    ),
  ]);
  assert.deepEqual(breakdowns.taskType.map((entry) => entry.group), ['maintenance']);
  assert.equal(breakdowns.taskType_descriptor.length, 1);
  assert.notEqual(breakdowns.taskType_descriptor[0]?.group, breakdowns.taskType[0]?.group);
});

test('buildLaunchPriorityCoverage reports zero-evidence models and candidate-pool blockers', () => {
  const record = makeRecord('a1', 'feature', '2026-06-01T00:00:00Z');
  record.taskDescriptor!.stages!.planner!.model = 'kimi-k2';
  const coverage = buildLaunchPriorityCoverage(
    [makeRecommendation(record, { planner: 'kimi-k2', coder: 'qwen-3-coder', reviewer: 'gpt-5.5' })],
    ['kimi-k2', 'qwen-3-coder', 'gpt-5.5'],
  );

  const kimi = coverage.models.find((entry) => entry.wavemillAlias === 'kimi-k2');
  const devstral = coverage.models.find((entry) => entry.wavemillAlias === 'devstral-small');
  assert.ok(kimi);
  assert.equal(kimi?.evidenceCount, 1);
  assert.equal(kimi?.inCandidatePool, true);
  assert.ok(devstral);
  assert.equal(devstral?.evidenceCount, 0);
  assert.equal(devstral?.blocker, 'not_in_candidate_pool');
});

test('computeRegret reports zero regret for best historical model', () => {
  const strong = makeRecord('a1', 'feature', '2026-06-01T00:00:00Z', 0.9);
  const weak = makeRecord('a2', 'feature', '2026-06-02T00:00:00Z', 0.2);
  weak.modelId = 'gpt-5.4';
  weak.taskDescriptor!.stages!.planner!.model = 'gpt-5.4';
  weak.taskDescriptor!.stages!.coder!.model = 'gpt-5.4';
  weak.taskDescriptor!.stages!.reviewer!.model = 'gpt-5.4';
  const regret = computeRegret([
    makeRecommendation(strong, { planner: 'gpt-5.5', coder: 'gpt-5.5', reviewer: 'gpt-5.4' }),
  ], [strong, weak], 2);
  assert.equal(regret.planner.meanRegret, 0);
  assert.equal(regret.coder.meanRegret, 0);
});

if (failed > 0) {
  console.log(`\n${failed} hokusai-router-audit tests failed (${passed} passed)\n`);
  process.exit(1);
}

console.log(`\n${passed} hokusai-router-audit tests passed\n`);
