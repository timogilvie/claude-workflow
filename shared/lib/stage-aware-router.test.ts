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
  loadStageAwareEvalRecords,
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

function writeJsonl(repoDir: string, relativePath: string, records: EvalRecord[]) {
  writeFileSync(
    join(repoDir, relativePath),
    records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '',
  );
}

function makeRepoWithStageAwareData(
  recordsOrSources: EvalRecord[] | {
    local?: EvalRecord[];
    backfilled?: EvalRecord[];
    aggregated?: EvalRecord[];
  },
  configOverrides: Record<string, unknown> = {},
) {
  const repoDir = mkdtempSync(join(tmpdir(), 'stage-aware-router-test-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });

  const sources = Array.isArray(recordsOrSources)
    ? { local: recordsOrSources, backfilled: recordsOrSources, aggregated: [] }
    : recordsOrSources;

  writeJsonl(repoDir, '.wavemill/evals/aggregated-evals.backfilled.jsonl', sources.backfilled || []);
  writeJsonl(repoDir, '.wavemill/evals/aggregated-evals.jsonl', sources.aggregated || []);
  writeJsonl(repoDir, '.wavemill/evals/evals.jsonl', sources.local || []);
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

test('rankModelsPerStage supports per-stage model allowlists', () => {
  const neighbors = [
    { record: makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.95, implementation: 0.82, review: 0.93 }), descriptor: makeDescriptor(), similarity: 0.99 },
    { record: makeEvalRecord('2', 'gpt-5.3-codex', { plan: 0.7, implementation: 0.96, review: 0.65 }), descriptor: makeDescriptor(), similarity: 0.98 },
    { record: makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.65, implementation: 0.6, review: 0.94 }), descriptor: makeDescriptor(), similarity: 0.97 },
  ];

  const constrained = rankModelsPerStage(neighbors, {
    plannerModelsAvailable: ['gpt-5.3-codex'],
    coderModelsAvailable: ['claude-opus-4-6'],
    reviewerModelsAvailable: ['claude-opus-4-6', 'gpt-5.3-codex'],
  });

  assert.equal(constrained.selection?.planner.modelId, 'gpt-5.3-codex');
  assert.equal(constrained.selection?.coder.modelId, 'claude-opus-4-6');
  assert.equal(constrained.selection?.reviewer.modelId, 'claude-opus-4-6');
});

test('rankModelsPerStage gives runtime flat allowlist precedence over per-stage defaults', () => {
  const neighbors = [
    { record: makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.95, implementation: 0.82, review: 0.93 }), descriptor: makeDescriptor(), similarity: 0.99 },
    { record: makeEvalRecord('2', 'gpt-5.3-codex', { plan: 0.7, implementation: 0.96, review: 0.65 }), descriptor: makeDescriptor(), similarity: 0.98 },
    { record: makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.65, implementation: 0.6, review: 0.94 }), descriptor: makeDescriptor(), similarity: 0.97 },
  ];

  const constrained = rankModelsPerStage(neighbors, {
    modelsAvailable: ['claude-haiku-4-5-20251001'],
    plannerModelsAvailable: ['claude-opus-4-6'],
    coderModelsAvailable: ['gpt-5.3-codex'],
    reviewerModelsAvailable: ['claude-opus-4-6'],
  });

  assert.equal(constrained.selection?.planner.modelId, 'claude-haiku-4-5-20251001');
  assert.equal(constrained.selection?.coder.modelId, 'claude-haiku-4-5-20251001');
  assert.equal(constrained.selection?.reviewer.modelId, 'claude-haiku-4-5-20251001');
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
    assert.ok((decision?.confidence || 0) >= 0.6);
  } finally {
    cleanup();
  }
});

test('routeStageAware reads per-stage model constraints from router config', () => {
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
      models: ['claude-opus-4-6', 'gpt-5.3-codex', 'claude-haiku-4-5-20251001'],
      availableModels: {
        planner: ['gpt-5.3-codex'],
        coder: ['claude-opus-4-6'],
      },
      defaultAgent: 'claude',
    },
  });

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', { repoDir });
    assert.ok(decision);
    assert.equal(decision?.planner, 'gpt-5.3-codex');
    assert.equal(decision?.coder, 'claude-opus-4-6');
    assert.equal(decision?.reviewer, 'claude-haiku-4-5-20251001');
  } finally {
    cleanup();
  }
});

test('routeStageAware falls back to router.models when a stage list is empty', () => {
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
      models: ['gpt-5.3-codex', 'claude-haiku-4-5-20251001'],
      availableModels: {
        planner: [],
      },
      defaultAgent: 'claude',
    },
  });

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', { repoDir });
    assert.ok(decision);
    assert.equal(decision?.planner, 'gpt-5.3-codex');
    assert.equal(decision?.coder, 'gpt-5.3-codex');
    assert.equal(decision?.reviewer, 'claude-haiku-4-5-20251001');
  } finally {
    cleanup();
  }
});

test('routeStageAware carries maxCostUsd through the decision', () => {
  const records = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.3-codex', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records);

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', {
      repoDir,
      maxCostUsd: 12,
    });
    assert.ok(decision);
    assert.deepEqual(decision?.constraints, { maxCostUsd: 12 });
  } finally {
    cleanup();
  }
});

test('loadStageAwareEvalRecords merges sources and prefers richer local duplicates', () => {
  const duplicateAggregate = makeEvalRecord('dup', 'claude-opus-4-6', { plan: 0.4, implementation: 0.4, review: 0.4 }, {
    taskDescriptor: undefined,
    metadata: undefined,
    workflowTokenUsage: undefined,
  });
  const duplicateLocal = makeEvalRecord('dup', 'gpt-5.3-codex', { plan: 0.9, implementation: 0.95, review: 0.92 }, {
    workflowTokenUsage: {
      'gpt-5.3-codex': { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 3.25 },
    },
  });
  const uniqueBackfilled = makeEvalRecord('unique', 'claude-haiku-4-5-20251001', { plan: 0.7, implementation: 0.72, review: 0.91 });
  const { repoDir, cleanup } = makeRepoWithStageAwareData({
    local: [duplicateLocal],
    backfilled: [uniqueBackfilled],
    aggregated: [duplicateAggregate],
  });

  try {
    const records = loadStageAwareEvalRecords({ repoDir });
    assert.equal(records.length, 2);
    const deduped = records.find((record) => record.id === 'dup');
    assert.equal(deduped?.modelId, 'gpt-5.3-codex');
    assert.ok(deduped?.workflowTokenUsage);
    assert.ok(records.some((record) => record.id === 'unique'));
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
    assert.ok(decision.confidence >= 0.1 && decision.confidence <= 0.85);
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /Router:\s+heuristic-fallback/);
  } finally {
    cleanup();
  }
});

test('routeStageAware uses fresh local evals even when aggregate history exists', () => {
  const aggregated = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.97, implementation: 0.61, review: 0.96 }),
    makeEvalRecord('2', 'claude-opus-4-6', { plan: 0.95, implementation: 0.62, review: 0.95 }),
    makeEvalRecord('3', 'claude-opus-4-6', { plan: 0.94, implementation: 0.63, review: 0.94 }),
  ];
  const local = [
    makeEvalRecord('4', 'gpt-5.3-codex', { plan: 0.7, implementation: 0.98, review: 0.68 }),
    makeEvalRecord('5', 'gpt-5.3-codex', { plan: 0.69, implementation: 0.97, review: 0.67 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData({ local, backfilled: aggregated });

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 5,
    });
    assert.ok(decision);
    assert.equal(decision?.coder, 'gpt-5.3-codex');
    assert.equal(decision?.planner, 'claude-opus-4-6');
  } finally {
    cleanup();
  }
});

test('routeStageAware does not overweight duplicate records across sources', () => {
  const opus = makeEvalRecord('opus-1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.82, review: 0.93 });
  const codex = makeEvalRecord('codex-1', 'gpt-5.3-codex', { plan: 0.74, implementation: 0.97, review: 0.7 });
  const haiku = makeEvalRecord('haiku-1', 'claude-haiku-4-5-20251001', { plan: 0.68, implementation: 0.62, review: 0.95 });
  const { repoDir, cleanup } = makeRepoWithStageAwareData({
    local: [codex],
    backfilled: [opus, codex, haiku],
  });

  try {
    const records = loadStageAwareEvalRecords({ repoDir });
    assert.equal(records.length, 3);
    assert.equal(records.filter((record) => record.id === 'codex-1').length, 1);

    const decision = routeStageAware('Build a backend feature with tests and review.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 5,
    });
    assert.ok(decision);
    assert.equal(decision?.coder, 'gpt-5.3-codex');
    assert.equal(decision?.neighborCount, 3);
  } finally {
    cleanup();
  }
});

test('routeStageAware still uses aggregate history when local evals are empty', () => {
  const backfilled = [
    makeEvalRecord('1', 'claude-opus-4-6', { plan: 0.96, implementation: 0.83, review: 0.91 }),
    makeEvalRecord('2', 'gpt-5.3-codex', { plan: 0.72, implementation: 0.97, review: 0.68 }),
    makeEvalRecord('3', 'claude-haiku-4-5-20251001', { plan: 0.66, implementation: 0.63, review: 0.95 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData({ local: [], backfilled });

  try {
    const decision = routeStageAware('Build a backend feature with tests and review.', { repoDir });
    assert.ok(decision);
    assert.equal(decision?.routingMode, 'stage-aware');
    assert.equal(decision?.neighborCount, 3);
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

test('routeWorkflowStageAware uses partial routing when neighbors lack model diversity', () => {
  // All records are the same model — enough data, but no model diversity in neighbors
  const records = [
    makeEvalRecord('1', 'claude-sonnet-4-5-20250929', { plan: 0.9, implementation: 0.85, review: 0.88 }),
    makeEvalRecord('2', 'claude-sonnet-4-5-20250929', { plan: 0.88, implementation: 0.82, review: 0.9 }),
    makeEvalRecord('3', 'claude-sonnet-4-5-20250929', { plan: 0.92, implementation: 0.87, review: 0.86 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records, {
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 2,
      minModels: 2,
      kNeighbors: 3,
      defaultAgent: 'claude',
    },
  });

  try {
    const decision = routeWorkflowStageAware('Build a backend feature with tests.', { repoDir });
    assert.equal(decision.routingMode, 'stage-aware-partial');
    assert.ok(decision.neighborCount > 0, 'should have neighbors');
    // Model selection comes from heuristic, not from the single-model neighbors
    assert.ok(decision.planner, 'should have a planner model');
    assert.ok(decision.coder, 'should have a coder model');
    // Stage calibration comes from neighbors — verify depths are set
    assert.ok(['light', 'deep'].includes(decision.planDepth));
    assert.ok(['light', 'medium', 'deep'].includes(decision.codeDepth));
    assert.ok(decision.confidence >= 0.1 && decision.confidence < 0.8);
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /Router:\s+stage-aware-partial/);
  } finally {
    cleanup();
  }
});

test('routeStageAware returns stage-aware-partial when neighbors have single model', () => {
  const records = [
    makeEvalRecord('1', 'claude-sonnet-4-5-20250929', { plan: 0.9, implementation: 0.85, review: 0.88 }),
    makeEvalRecord('2', 'claude-sonnet-4-5-20250929', { plan: 0.88, implementation: 0.82, review: 0.9 }),
    makeEvalRecord('3', 'claude-sonnet-4-5-20250929', { plan: 0.92, implementation: 0.87, review: 0.86 }),
  ];
  const { repoDir, cleanup } = makeRepoWithStageAwareData(records);

  try {
    const decision = routeStageAware('Build a backend feature with tests.', {
      repoDir,
      minRecords: 2,
      minModels: 2,
      kNeighbors: 3,
    });
    assert.ok(decision);
    assert.equal(decision?.routingMode, 'stage-aware-partial');
    assert.equal(decision?.neighborCount, 3);
    assert.ok((decision?.confidence || 0) < 0.8);
  } finally {
    cleanup();
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
