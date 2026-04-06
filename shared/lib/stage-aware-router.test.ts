/**
 * Tests for the stage-aware router.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvalRecord, TaskDescriptor } from './eval-schema.ts';
import {
  cosineSimilarity,
  findKNearest,
  rankModelsPerStage,
  routeStageAware,
  vectorizeDescriptor,
} from './stage-aware-router.ts';
import { clearConfigCache } from './config.ts';
import { routeWorkflowStageAware, summarizeWorkflowRoute } from './workflow-router.ts';

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

function makeDescriptor(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    schema_version: '1.0',
    signals: {
      heuristic: {
        task_type: 'feature',
        languages: ['typescript', 'sql'],
        framework_tags: [],
        files_touched: 6,
        repo_size_loc: 50_000,
        description_tokens: 250,
        is_greenfield: false,
        has_migration: false,
        has_ui: false,
        has_tests: true,
        cross_service: false,
      },
      learned: {
        complexity: 4,
        domain: 'backend',
        risk_flags: ['schema-migration'],
      },
    },
    constraints: {
      models_available: [],
      objective: 'balanced',
    },
    stages: {},
    ...overrides,
  };
}

function makeEvalRecord(id: string, modelId: string, stageScores: {
  plan: number;
  implementation: number;
  review: number;
}, overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id,
    schemaVersion: '1.0.0',
    originalPrompt: 'Implement a backend feature with tests',
    modelId,
    modelVersion: modelId,
    score: overrides.score ?? 0.8,
    scoreBand: 'good',
    timeSeconds: 120,
    timestamp: '2026-04-05T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'solid',
    metadata: {
      stageScores: {
        expansion: { score: 0.8, rationale: 'ok' },
        plan: { score: stageScores.plan, rationale: 'ok' },
        implementation: { score: stageScores.implementation, rationale: 'ok' },
        review: { score: stageScores.review, rationale: 'ok' },
      },
    },
    workflowCost: overrides.workflowCost ?? 9,
    workflowTokenUsage: overrides.workflowTokenUsage,
    taskDescriptor: overrides.taskDescriptor || makeDescriptor({
      stages: {
        planner: { model: modelId, cost_usd: 1.5 },
        coder: { model: modelId, cost_usd: 6 },
        reviewer: { model: modelId, cost_usd: 1.5 },
      },
    }),
    ...overrides,
  } as EvalRecord;
}

function makeRepoWithStageAwareData(records: EvalRecord[], configOverrides: Record<string, unknown> = {}) {
  const repoDir = mkdtempSync(join(tmpdir(), 'stage-aware-router-test-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });

  writeFileSync(
    join(repoDir, '.wavemill', 'evals', 'aggregated-evals.backfilled.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  writeFileSync(
    join(repoDir, '.wavemill', 'evals', 'evals.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 3,
      stageBlendWeight: 0.3,
      defaultAgent: 'claude',
      agentMap: {
        'claude-opus-4-6': 'claude',
        'claude-sonnet-4-5-20250929': 'claude',
        'claude-haiku-4-5-20251001': 'claude',
        'gpt-5.3-codex': 'codex',
      },
    },
    eval: {
      pricing: {
        'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
        'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
      },
    },
    ...configOverrides,
  }));

  clearConfigCache(repoDir);

  return {
    repoDir,
    cleanup: () => {
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

console.log('\n--- stage-aware-router Tests ---\n');

test('vectorizeDescriptor produces bounded fixed-length vectors', () => {
  const vector = vectorizeDescriptor(makeDescriptor());
  assert.equal(vector.length, 31);
  assert.ok(vector.every((value) => value >= 0 && value <= 1));
});

test('cosineSimilarity handles identical and orthogonal vectors', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('findKNearest sorts records by descriptor similarity', () => {
  const query = makeDescriptor();
  const exact = makeEvalRecord('1', 'claude-sonnet-4-5-20250929', { plan: 0.8, implementation: 0.8, review: 0.8 });
  const different = makeEvalRecord('2', 'gpt-5.3-codex', { plan: 0.7, implementation: 0.7, review: 0.7 }, {
    taskDescriptor: makeDescriptor({
      signals: {
        heuristic: {
          task_type: 'infra',
          languages: ['go'],
          framework_tags: [],
          files_touched: 20,
          repo_size_loc: 250_000,
          description_tokens: 1000,
          is_greenfield: true,
          has_migration: false,
          has_ui: false,
          has_tests: false,
          cross_service: true,
        },
        learned: {
          complexity: 5,
          domain: 'infrastructure',
          risk_flags: ['cross-service', 'large-scope-refactor'],
        },
      },
    }),
  });

  const neighbors = findKNearest(query, [different, exact], 2);
  assert.equal(neighbors[0].record.id, '1');
  assert.ok(neighbors[0].similarity >= neighbors[1].similarity);
});

test('rankModelsPerStage picks the best model combination under constraints', () => {
  const neighbors = [
    { record: makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.95, implementation: 0.82, review: 0.93 }), descriptor: makeDescriptor(), similarity: 0.99 },
    { record: makeEvalRecord('2', 'gpt-5.3-codex', { plan: 0.7, implementation: 0.96, review: 0.65 }), descriptor: makeDescriptor(), similarity: 0.98 },
    { record: makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.65, implementation: 0.6, review: 0.94 }), descriptor: makeDescriptor(), similarity: 0.97 },
  ];

  const unconstrained = rankModelsPerStage(neighbors);
  assert.equal(unconstrained.selection?.planner.modelId, 'claude-opus-4-6');
  assert.equal(unconstrained.selection?.coder.modelId, 'gpt-5.3-codex');
  assert.equal(unconstrained.selection?.reviewer.modelId, 'claude-haiku-4-5-20251001');

  const allowlist = rankModelsPerStage(neighbors, { modelsAvailable: ['claude-opus-4-6', 'gpt-5.3-codex'] });
  assert.equal(allowlist.selection?.reviewer.modelId, 'claude-opus-4-6');
});

test('routeStageAware returns a stage-aware decision from backfilled evals', () => {
  const records = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.3-codex', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records);

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', { repoDir });
    assert.ok(decision);
    assert.equal(decision?.routingMode, 'stage-aware');
    assert.equal(decision?.planner, 'claude-opus-4-6');
    assert.equal(decision?.coder, 'gpt-5.3-codex');
    assert.equal(decision?.reviewer, 'claude-haiku-4-5-20251001');
    assert.equal(decision?.neighborCount, 3);
    assert.ok((decision?.expectedCost || 0) > 0);
  } finally {
    cleanup();
  }
});

test('routeWorkflowStageAware falls back to heuristic when data is insufficient', () => {
  const records = [
    makeEvalRecord('1', 'claude-sonnet-4-5-20250929', { plan: 0.9, implementation: 0.9, review: 0.9 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 3,
      minModels: 2,
      defaultAgent: 'claude',
    },
  });

  try {
    const decision = routeWorkflowStageAware('Create a CLI command with JSON output.', { repoDir });
    assert.equal(decision.routingMode, 'heuristic-fallback');
    assert.equal(decision.neighborCount, 0);
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /Router:\s+heuristic-fallback/);
  } finally {
    cleanup();
  }
});

test('routeWorkflowStageAware attaches a challenge recommendation when policy triggers', () => {
  const records = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.3-codex', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 3,
      defaultModel: 'claude-sonnet-4-5-20250929',
      models: [
        'claude-opus-4-6',
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5-20251001',
        'gpt-5.3-codex',
      ],
      defaultAgent: 'claude',
    },
    challengeScheduler: {
      enabled: true,
      confidenceThreshold: 0.99,
      newModelChallengeCount: 1,
      minEvalRecordsPerStage: 1,
    },
  });

  try {
    const decision = routeWorkflowStageAware('Build a backend feature with tests and review.', { repoDir });
    assert.equal(decision.challengeRecommendation?.shouldChallenge, true);
    assert.equal(decision.challengeRecommendation?.reason, 'low-confidence');
    assert.match(summarizeWorkflowRoute(decision, repoDir), /Challenge:\s+low-confidence/);
  } finally {
    cleanup();
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
