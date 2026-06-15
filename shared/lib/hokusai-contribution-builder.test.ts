import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSubmitDataContributionRow,
  buildTechnicalTaskRouterContributionRow,
  buildTechnicalTaskRouterContributionRowV2,
} from './hokusai-contribution-builder.ts';
import type {
  RedactedEvalContributionProjection,
  TechnicalTaskRouterV2ContributionProjection,
} from './hokusai-contribution-builder.ts';
import { TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2 } from './hokusai-contribution-schema.ts';

function makeProjection(
  overrides: Partial<RedactedEvalContributionProjection> = {},
): RedactedEvalContributionProjection {
  return {
    taskId: 'redacted-task',
    runId: 'redacted-run',
    harness: 'wavemill',
    observedAt: '2026-05-30T12:00:00.000Z',
    observedSuccess: true,
    budgetCompliant: true,
    actualCostUsd: 1.25,
    wallClockSeconds: 30,
    inputs: {
      route_family: 'balanced',
      retries: 2,
      flags: ['a', 'b'],
      nested: {
        compact: 'ok',
        dropped: { not: 'kept' },
      },
    },
    taskDescriptor: {
      task_type: 'feature',
      language: 'typescript',
      domain: 'frontend',
      complexity: 5,
      repo_size_bucket: 'medium',
      files_touched_bucket: '2_5',
      description_length_bucket: 'medium',
      is_greenfield: false,
      is_migration: false,
      requires_tests: true,
      cross_service: false,
      ui_heavy: true,
      risk_level: 'medium',
    },
    allowedModels: ['planner-a', 'coder-a', 'reviewer-a'],
    selectedModels: {
      planner: 'planner-a',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
    },
    budgetUsd: 10,
    scorerRef: 'router-benchmark/v1',
    ...overrides,
  };
}

describe('hokusai-contribution-builder', () => {
  it('builds a minimal submit-data row', () => {
    const row = buildSubmitDataContributionRow(makeProjection({
      actualCostUsd: undefined,
      wallClockSeconds: undefined,
      inputs: undefined,
      harness: undefined,
      taskId: undefined,
    }));

    assert.deepEqual(row, {
      success_under_budget: true,
    });
  });

  it('builds a full submit-data row and compacts inputs', () => {
    const row = buildSubmitDataContributionRow(makeProjection());

    assert.equal(row.success_under_budget, true);
    assert.deepEqual(row.inputs, {
      route_family: 'balanced',
      retries: 2,
      flags: ['a', 'b'],
      nested: { compact: 'ok' },
    });
  });

  it('preserves null actual cost in submit-data rows', () => {
    const row = buildSubmitDataContributionRow(makeProjection({
      actualCostUsd: null,
      budgetCompliant: false,
    }));

    assert.equal(row.actual_cost_usd, null);
    assert.equal(row.success_under_budget, false);
  });

  it('builds a benchmark row', () => {
    const row = buildTechnicalTaskRouterContributionRow(makeProjection());
    assert.equal(row.completion_result, 'success');
    assert.equal(row.success_under_budget, true);
    assert.equal(row.selected_models.coder, 'coder-a');
  });

  it('preserves null actual cost in benchmark rows', () => {
    const row = buildTechnicalTaskRouterContributionRow(makeProjection({
      actualCostUsd: null,
      budgetCompliant: false,
    }));

    assert.equal(row.actual_cost_usd, null);
    assert.equal(row.success_under_budget, false);
  });

  it('uses observed success plus budget compliance for success_under_budget', () => {
    const row = buildSubmitDataContributionRow(makeProjection({
      observedSuccess: true,
      budgetCompliant: false,
    }));
    assert.equal(row.success_under_budget, false);
  });

  it('omits unknown raw text fields from inputs', () => {
    const row = buildSubmitDataContributionRow(makeProjection({
      inputs: {
        safe: 'kept',
        large_blob: { body: { deeper: 'dropped' } },
      },
    }));

    assert.deepEqual(row.inputs, {
      safe: 'kept',
    });
  });

  it('builds a minimal v2 row', () => {
    const projection: TechnicalTaskRouterV2ContributionProjection = {
      rowId: 'test-row-1',
      evalId: 'eval-1',
      modelId: 'model-1',
      scenario: 'production_pool',
      candidatePoolId: 'pool-1',
      taskDescriptor: {
        task_type: 'feature',
        language: 'typescript',
        domain: 'frontend',
        complexity: 5,
        repo_size_bucket: 'medium',
        files_touched_bucket: '2_5',
        description_length_bucket: 'medium',
        is_greenfield: false,
        is_migration: false,
        requires_tests: true,
        cross_service: false,
        ui_heavy: true,
        risk_level: 'medium',
      },
      allowedModels: ['claude-sonnet-4-6', 'gpt-5.4'],
      selectedModels: ['claude-sonnet-4-6'],
      maxCostUsd: 0.1,
      actualCostUsd: 0.05,
      completedSuccessfully: true,
      observedAt: '2026-06-15T00:00:00Z',
    };

    const row = buildTechnicalTaskRouterContributionRowV2(projection);
    assert.equal(row.schema_version, TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2);
    assert.equal(row.row_id, 'test-row-1');
    assert.deepEqual(row.allowed_models, ['claude-sonnet-4-6', 'gpt-5.4']);
  });

  it('builds a full v2 row with all optional fields', () => {
    const projection: TechnicalTaskRouterV2ContributionProjection = {
      rowId: 'test-row-2',
      evalId: 'eval-2',
      modelId: 'model-2',
      scenario: 'challenger_present',
      candidatePoolId: 'qwen-pool',
      taskDescriptor: {
        task_type: 'feature',
        language: 'typescript',
        domain: 'frontend',
        complexity: 5,
        repo_size_bucket: 'medium',
        files_touched_bucket: '2_5',
        description_length_bucket: 'medium',
        is_greenfield: false,
        is_migration: false,
        requires_tests: true,
        cross_service: false,
        ui_heavy: true,
        risk_level: 'medium',
      },
      allowedModels: ['gpt-5.4', 'claude-sonnet-4-6', 'qwen3-coder-plus'],
      selectedModels: ['gpt-5.4', 'qwen3-coder-plus', 'claude-sonnet-4-6'],
      selectedStrategy: {
        planner_model: 'gpt-5.4',
        coder_model: 'qwen3-coder-plus',
        reviewer_model: 'claude-sonnet-4-6',
        routing_objective: 'lowest_cost',
      },
      maxCostUsd: 0.08,
      actualCostUsd: 0.02,
      estimatedCostUsd: 0.022,
      actualTimeSeconds: 520,
      estimatedDurationSeconds: 560,
      estimatedSuccessUnderBudget: 0.75,
      completedSuccessfully: true,
      observedAt: '2026-06-15T00:00:00Z',
      availablePlannerModels: ['gpt-5.4', 'claude-opus-4-7'],
      availableCoderModels: ['gpt-5.4', 'claude-sonnet-4-6', 'qwen3-coder-plus'],
      availableReviewerModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
      metadata: {
        sparse_infra: true,
        candidate_pool_robustness: 'high',
      },
    };

    const row = buildTechnicalTaskRouterContributionRowV2(projection);
    assert.equal(row.scenario, 'challenger_present');
    assert.equal(row.selected_strategy?.routing_objective, 'lowest_cost');
    assert.equal(row.estimated_cost_usd, 0.022);
    assert.equal(row.actual_time_seconds, 520);
    assert.equal(row.metadata?.available_planner_models?.length, 2);
  });

  it('deduplicates allowed_models in v2 row', () => {
    const projection: TechnicalTaskRouterV2ContributionProjection = {
      rowId: 'test-row-3',
      evalId: 'eval-3',
      modelId: 'model-3',
      scenario: 'production_pool',
      candidatePoolId: 'pool-3',
      taskDescriptor: {
        task_type: 'feature',
        language: 'typescript',
        domain: 'frontend',
        complexity: 5,
        repo_size_bucket: 'medium',
        files_touched_bucket: '2_5',
        description_length_bucket: 'medium',
        is_greenfield: false,
        is_migration: false,
        requires_tests: true,
        cross_service: false,
        ui_heavy: true,
        risk_level: 'medium',
      },
      allowedModels: ['claude-sonnet-4-6', 'gpt-5.4', 'claude-sonnet-4-6'],
      selectedModels: ['claude-sonnet-4-6'],
      maxCostUsd: 0.1,
      actualCostUsd: 0.05,
      completedSuccessfully: true,
      observedAt: '2026-06-15T00:00:00Z',
    };

    const row = buildTechnicalTaskRouterContributionRowV2(projection);
    assert.deepEqual(row.allowed_models, ['claude-sonnet-4-6', 'gpt-5.4']);
  });

  it('allows null actual_time_seconds in v2 row', () => {
    const projection: TechnicalTaskRouterV2ContributionProjection = {
      rowId: 'test-row-4',
      evalId: 'eval-4',
      modelId: 'model-4',
      scenario: 'sparse_cell',
      candidatePoolId: 'pool-4',
      taskDescriptor: {
        task_type: 'feature',
        language: 'typescript',
        domain: 'frontend',
        complexity: 5,
        repo_size_bucket: 'medium',
        files_touched_bucket: '2_5',
        description_length_bucket: 'medium',
        is_greenfield: false,
        is_migration: false,
        requires_tests: true,
        cross_service: false,
        ui_heavy: true,
        risk_level: 'medium',
      },
      allowedModels: ['claude-sonnet-4-6'],
      selectedModels: ['claude-sonnet-4-6'],
      maxCostUsd: 0.1,
      actualCostUsd: 0.05,
      actualTimeSeconds: null,
      completedSuccessfully: true,
      observedAt: '2026-06-15T00:00:00Z',
    };

    const row = buildTechnicalTaskRouterContributionRowV2(projection);
    assert.equal(row.actual_time_seconds, null);
  });

  it('rejects v2 row with zero max_cost_usd', () => {
    const projection: TechnicalTaskRouterV2ContributionProjection = {
      rowId: 'test-row-bad',
      evalId: 'eval-bad',
      modelId: 'model-bad',
      scenario: 'production_pool',
      candidatePoolId: 'pool-bad',
      taskDescriptor: {
        task_type: 'feature',
        language: 'typescript',
        domain: 'frontend',
        complexity: 5,
        repo_size_bucket: 'medium',
        files_touched_bucket: '2_5',
        description_length_bucket: 'medium',
        is_greenfield: false,
        is_migration: false,
        requires_tests: true,
        cross_service: false,
        ui_heavy: true,
        risk_level: 'medium',
      },
      allowedModels: ['claude-sonnet-4-6'],
      selectedModels: ['claude-sonnet-4-6'],
      maxCostUsd: 0,
      actualCostUsd: 0.05,
      completedSuccessfully: true,
      observedAt: '2026-06-15T00:00:00Z',
    };

    assert.throws(
      () => buildTechnicalTaskRouterContributionRowV2(projection),
      (error: unknown) => error instanceof Error && error.message.includes('maxCostUsd'),
    );
  });

  it('rejects v2 row with negative actual_cost_usd', () => {
    const projection: TechnicalTaskRouterV2ContributionProjection = {
      rowId: 'test-row-bad',
      evalId: 'eval-bad',
      modelId: 'model-bad',
      scenario: 'production_pool',
      candidatePoolId: 'pool-bad',
      taskDescriptor: {
        task_type: 'feature',
        language: 'typescript',
        domain: 'frontend',
        complexity: 5,
        repo_size_bucket: 'medium',
        files_touched_bucket: '2_5',
        description_length_bucket: 'medium',
        is_greenfield: false,
        is_migration: false,
        requires_tests: true,
        cross_service: false,
        ui_heavy: true,
        risk_level: 'medium',
      },
      allowedModels: ['claude-sonnet-4-6'],
      selectedModels: ['claude-sonnet-4-6'],
      maxCostUsd: 0.1,
      actualCostUsd: -0.01,
      completedSuccessfully: true,
      observedAt: '2026-06-15T00:00:00Z',
    };

    assert.throws(
      () => buildTechnicalTaskRouterContributionRowV2(projection),
      (error: unknown) => error instanceof Error && error.message.includes('actualCostUsd'),
    );
  });
});
