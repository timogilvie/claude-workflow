/**
 * Tests for Hokusai router audit metrics.
 */

import assert from 'node:assert/strict';
import type { EvalRecord } from './eval-schema.ts';
import {
  buildCalibration,
  buildCandidateEvidence,
  buildGroupBreakdowns,
  buildScenarioShares,
  buildStageShares,
  buildV2ConformanceCheck,
  classifyValidityViolations,
  computeRegret,
  effectiveModelCount,
  stratifiedSampleRecords,
  summarizeDeterminism,
  summarizeSensitivity,
  V2_SCENARIOS,
  type AuditRecommendation,
  type AuditRequestRecord,
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

function makeRecommendation(record: EvalRecord, models: { planner: string; coder: string; reviewer: string }, estimated = 0.8): AuditRecommendation {
  return {
    evalId: record.id,
    strategy: {
      planner_model: models.planner,
      coder_model: models.coder,
      reviewer_model: models.reviewer,
      estimated_success_under_budget: estimated,
    },
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
    makeRecommendation(feature, { planner: 'gpt-5.5', coder: 'gpt-5.5', reviewer: 'gpt-5.4' }),
    makeRecommendation(docs, { planner: 'gpt-5.4', coder: 'gpt-5.4', reviewer: 'gpt-5.5' }),
  ]);
  assert.equal(breakdowns.taskType.length, 2);
  const docsBreakdown = breakdowns.taskType.find((entry) => entry.group === 'docs');
  assert.equal(docsBreakdown?.stageShares.coder[0].model, 'gpt-5.4');
  assert.equal(docsBreakdown?.effectiveModelCounts.coder, 1);
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

// V2 scenario tests

test('buildScenarioShares includes all five v2 scenarios', () => {
  const record = makeRecord('a1', 'feature', '2026-06-01T00:00:00Z');
  const pools = { planner: ['gpt-5.5'], coder: ['gpt-5.5'], reviewer: ['gpt-5.5'] };
  const scenarioRequests = new Map<any, AuditRequestRecord[]>();
  const scenarioRecommendations = new Map<any, AuditRecommendation[]>();

  for (const scenario of V2_SCENARIOS) {
    scenarioRequests.set(scenario, [{
      evalId: `test-${scenario}`,
      request: { inputs: { task: { description: 'test', task_type: 'feature' } } } as any,
      descriptor: record.taskDescriptor!,
      originalRecord: record,
      candidatePools: pools,
      scenario,
    }]);
    scenarioRecommendations.set(scenario, [makeRecommendation(record, pools)]);
  }

  const shares = buildScenarioShares(scenarioRequests, scenarioRecommendations);
  assert.equal(shares.length, 5);
  assert.equal(shares[0].scenario, 'production_pool');
  assert.equal(shares[4].scenario, 'sparse_cell');
});

test('buildCandidateEvidence reports zero-evidence candidates', () => {
  const record = makeRecord('a1', 'feature', '2026-06-01T00:00:00Z');
  record.taskDescriptor!.stages!.planner!.model = 'gpt-5.5';
  const corpus = [record];
  const pools = { planner: ['gpt-5.5', 'gpt-5.4'], coder: ['gpt-5.5'], reviewer: ['gpt-5.5'] };

  const evidence = buildCandidateEvidence(corpus, pools, 10);
  assert.equal(evidence.threshold, 10);

  const zeroEvidence = evidence.entries.filter((e) => e.isZeroEvidence);
  assert.ok(zeroEvidence.length > 0, 'Should have zero-evidence entries');
  assert.ok(zeroEvidence.some((e) => e.model === 'gpt-5.4'), 'gpt-5.4 should have zero evidence');
});

test('buildV2ConformanceCheck validates scenario coverage', () => {
  const scenarioShares = [
    { scenario: 'production_pool' as const, count: 10, stageShares: {} as any, effectiveModelCounts: {} as any, candidatePools: {} as any },
    { scenario: 'sparse_cell' as const, count: 5, stageShares: {} as any, effectiveModelCounts: {} as any, candidatePools: {} as any },
  ];

  const conformance = buildV2ConformanceCheck(scenarioShares, 0.01);
  assert.equal(conformance.benchmarkSpecId, 'technical_task_router/v2');
  assert.equal(conformance.primaryMetric, 'technical_task_router.benchmark_score/v2');
  assert.equal(conformance.scenarioCoverage.total, 2);
  assert.ok(conformance.scenarioCoverage.missingScenarios.length > 0, 'Should flag missing scenarios');
  assert.ok(!conformance.ok, 'Should fail when scenarios are missing');
});

test('buildV2ConformanceCheck passes with all scenarios and low violation rate', () => {
  const scenarioShares = V2_SCENARIOS.map((scenario) => ({
    scenario,
    count: 10,
    stageShares: {} as any,
    effectiveModelCounts: {} as any,
    candidatePools: {} as any,
  }));

  const conformance = buildV2ConformanceCheck(scenarioShares, 0.005);
  assert.equal(conformance.scenarioCoverage.missingScenarios.length, 0);
  assert.ok(conformance.guardrailChecks.passed, 'Guardrails should pass with 0.5% violation rate');
  assert.ok(conformance.ok, 'Should pass with all scenarios and low violations');
});

if (failed > 0) {
  console.log(`\n${failed} hokusai-router-audit tests failed (${passed} passed)\n`);
  process.exit(1);
}

console.log(`\n${passed} hokusai-router-audit tests passed\n`);
