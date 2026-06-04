import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSubmitDataContributionRow,
  buildTechnicalTaskRouterContributionRow,
} from './hokusai-contribution-builder.ts';
import type { RedactedEvalContributionProjection } from './hokusai-contribution-builder.ts';

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
});
