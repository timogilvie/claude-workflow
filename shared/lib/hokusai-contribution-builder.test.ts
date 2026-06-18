import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSubmitDataContributionRow,
  buildTechnicalTaskRouterContributionRow,
  buildTechnicalTaskRouterContributionRowV2,
  deriveOutcomeLabels,
} from './hokusai-contribution-builder.ts';
import type {
  RedactedEvalContributionProjection,
  RedactedEvalContributionProjectionV2,
} from './hokusai-contribution-builder.ts';

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

function makeProjectionV2(
  overrides: Partial<RedactedEvalContributionProjectionV2> = {},
): RedactedEvalContributionProjectionV2 {
  return {
    ...makeProjection(),
    availableModels: {
      planner_models: ['planner-a'],
      coder_models: ['coder-a', 'deepseek-coder-v2'],
      reviewer_models: ['reviewer-a'],
    },
    candidatePool: {
      scenario_id: 'challenger-qwen',
      scenario_kind: 'challenger',
      pool_size: 2,
      baseline_model: 'gpt-5.4',
    },
    sparseCell: {
      cell_id: 'frontend-medium-2_5',
      descriptor_signature: 'frontend|medium|2_5',
      observed_count: 2,
      is_sparse: true,
    },
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

  it('builds a full v2 benchmark row', () => {
    const row = buildTechnicalTaskRouterContributionRowV2(makeProjectionV2());

    assert.equal(row.schema_version, 'technical_task_router_row/v2');
    assert.equal(row.available_models.coder_models[1], 'deepseek-coder-v2');
    assert.equal(row.candidate_pool.baseline_model, 'gpt-5.4');
    assert.equal(row.sparse_cell.is_sparse, true);
  });

  it('supports challenger rows with Qwen coder ids', () => {
    const row = buildTechnicalTaskRouterContributionRowV2(makeProjectionV2({
      selectedModels: {
        planner: 'planner-a',
        coder: 'qwen2.5-coder-32b',
        reviewer: 'reviewer-a',
      },
      availableModels: {
        planner_models: ['planner-a'],
        coder_models: ['qwen2.5-coder-32b', 'deepseek-coder-v2'],
        reviewer_models: ['reviewer-a'],
      },
    }));

    assert.equal(row.selected_models.coder, 'qwen2.5-coder-32b');
    assert.equal(row.candidate_pool.scenario_kind, 'challenger');
  });

  it('derives outcome labels from observed cost and time', () => {
    const labels = deriveOutcomeLabels(makeProjectionV2({
      budgetUsd: 2,
      actualCostUsd: 6,
      wallClockSeconds: 3600,
      observedSuccess: false,
    }));

    assert.deepEqual(labels, {
      budget_label: 'over_budget',
      cost_label: 'high',
      time_label: 'slow',
      success_label: 'failure',
    });
  });

  it('applies role-pool fallback when role-specific pools are missing', () => {
    const row = buildTechnicalTaskRouterContributionRowV2(makeProjectionV2({
      availableModels: undefined,
      selectedModels: {
        coder: 'coder-a',
        reviewer: 'reviewer-a',
      },
    }));

    assert.deepEqual(row.available_models, {
      planner_models: [],
      coder_models: ['planner-a', 'coder-a', 'reviewer-a'],
      reviewer_models: ['planner-a', 'coder-a', 'reviewer-a'],
    });
  });

  it('fills default v2 metadata when optional scenario fields are absent', () => {
    const row = buildTechnicalTaskRouterContributionRowV2(makeProjectionV2({
      candidatePool: undefined,
      sparseCell: undefined,
      actualCostUsd: null,
      wallClockSeconds: undefined,
      budgetUsd: undefined,
    }));

    assert.deepEqual(row.candidate_pool, {
      scenario_id: 'unknown',
      scenario_kind: 'unknown',
      pool_size: 3,
    });
    assert.deepEqual(row.sparse_cell, {
      cell_id: 'unknown',
      descriptor_signature: 'unknown',
      observed_count: 0,
      is_sparse: false,
    });
    assert.deepEqual(row.outcome_labels, {
      budget_label: 'unknown',
      cost_label: 'unknown',
      time_label: 'unknown',
      success_label: 'success',
    });
  });
});
