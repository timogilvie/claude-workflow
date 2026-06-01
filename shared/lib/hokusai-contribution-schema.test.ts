import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  ContributionValidationError,
  validateContributionRow,
} from './hokusai-contribution-schema.ts';
import type { HokusaiTaskDescriptor } from './hokusai-schema.ts';

function makeTaskDescriptor(): HokusaiTaskDescriptor {
  return {
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
  };
}

describe('hokusai-contribution-schema', () => {
  it('validates a minimal submit-data row', () => {
    const row = validateContributionRow({ success_under_budget: true });
    assert.deepEqual(row, { success_under_budget: true });
  });

  it('validates a full submit-data row', () => {
    const row = validateContributionRow({
      success_under_budget: false,
      inputs: { route_family: 'balanced', retries: 2, dry_run: false },
      actual_cost_usd: 1.23,
      wall_clock_seconds: 45,
      task_id: 'redacted-abc',
      harness: 'wavemill',
    });
    assert.equal(row.actual_cost_usd, 1.23);
  });

  it('validates null actual cost for submit-data rows', () => {
    const row = validateContributionRow({
      success_under_budget: false,
      actual_cost_usd: null,
    });
    assert.equal(row.actual_cost_usd, null);
  });

  it('validates a benchmark row', () => {
    const row = validateContributionRow({
      schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
      task_descriptor: makeTaskDescriptor(),
      allowed_models: ['planner-a', 'coder-a', 'reviewer-a'],
      selected_models: {
        planner: 'planner-a',
        coder: 'coder-a',
        reviewer: 'reviewer-a',
      },
      budget_usd: 10,
      actual_cost_usd: 2.2,
      wall_clock_seconds: 120,
      success_under_budget: true,
      completion_result: 'success',
      scorer_ref: 'router-benchmark/v1',
      observed_at: '2026-05-30T12:00:00.000Z',
      task_id: 'redacted-task',
      harness: 'wavemill',
    });
    assert.equal(row.schema_version, TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION);
  });

  it('validates null actual cost for benchmark rows', () => {
    const row = validateContributionRow({
      schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
      task_descriptor: makeTaskDescriptor(),
      allowed_models: ['planner-a', 'coder-a', 'reviewer-a'],
      selected_models: {
        coder: 'coder-a',
        reviewer: 'reviewer-a',
      },
      actual_cost_usd: null,
      success_under_budget: false,
      completion_result: 'success',
      observed_at: '2026-05-30T12:00:00.000Z',
    });
    assert.equal(row.actual_cost_usd, null);
  });

  it('rejects rows missing success_under_budget', () => {
    assert.throws(
      () => validateContributionRow({ actual_cost_usd: 2 }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects nested forbidden keys', () => {
    assert.throws(
      () => validateContributionRow({
        success_under_budget: true,
        inputs: {
          nested: {
            prompt: 'secret',
          },
        },
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'forbidden_field',
    );
  });

  it('rejects raw EvalRecord-style fields', () => {
    assert.throws(
      () => validateContributionRow({
        success_under_budget: true,
        original_prompt: 'unsafe raw task text',
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'forbidden_field',
    );
  });
});
