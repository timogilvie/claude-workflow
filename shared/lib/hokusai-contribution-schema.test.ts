import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Ajv from 'ajv';
import {
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
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

function makeV2Row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
    task_descriptor: makeTaskDescriptor(),
    allowed_models: ['planner-a', 'qwen2.5-coder-32b', 'reviewer-a'],
    selected_models: {
      planner: 'planner-a',
      coder: 'qwen2.5-coder-32b',
      reviewer: 'reviewer-a',
    },
    available_models: {
      planner_models: ['planner-a'],
      coder_models: ['qwen2.5-coder-32b', 'deepseek-coder-v2'],
      reviewer_models: ['reviewer-a'],
    },
    budget_usd: 10,
    actual_cost_usd: 2.2,
    wall_clock_seconds: 120,
    success_under_budget: true,
    completion_result: 'success',
    outcome_labels: {
      budget_label: 'under_budget',
      cost_label: 'medium',
      time_label: 'fast',
      success_label: 'success',
    },
    candidate_pool: {
      scenario_id: 'challenger-qwen-vs-baseline',
      scenario_kind: 'challenger',
      pool_size: 2,
      baseline_model: 'gpt-5.4',
    },
    sparse_cell: {
      cell_id: 'frontend-medium-2_5',
      descriptor_signature: 'frontend|medium|2_5',
      observed_count: 3,
      is_sparse: true,
    },
    scorer_ref: 'technical_task_router.benchmark_score/v2',
    observed_at: '2026-05-30T12:00:00.000Z',
    task_id: 'redacted-task',
    harness: 'wavemill',
    ...overrides,
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

  it('validates a full v2 benchmark row', () => {
    const row = validateContributionRow(makeV2Row());
    assert.equal(row.schema_version, TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2);
    assert.equal('available_models' in row && row.available_models.coder_models[1], 'deepseek-coder-v2');
  });

  it('validates a minimal v2 benchmark row', () => {
    const row = validateContributionRow(makeV2Row({
      budget_usd: undefined,
      actual_cost_usd: null,
      wall_clock_seconds: undefined,
      selected_models: {
        coder: 'coder-a',
        reviewer: 'reviewer-a',
      },
      available_models: {
        planner_models: [],
        coder_models: ['coder-a'],
        reviewer_models: ['reviewer-a'],
      },
      outcome_labels: {
        budget_label: 'unknown',
        cost_label: 'unknown',
        time_label: 'unknown',
        success_label: 'success',
      },
      candidate_pool: {
        scenario_id: 'default',
        scenario_kind: 'fallback',
        pool_size: 1,
      },
      sparse_cell: {
        cell_id: 'default',
        descriptor_signature: 'default',
        observed_count: 0,
        is_sparse: false,
      },
    }));
    assert.equal(row.schema_version, TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2);
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

  it('rejects forbidden keys nested in v2 metadata', () => {
    assert.throws(
      () => validateContributionRow(makeV2Row({
        candidate_pool: {
          scenario_id: 'a',
          scenario_kind: 'challenger',
          pool_size: 2,
          prompt: 'secret',
        },
      })),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'forbidden_field',
    );
  });

  it('rejects v2 rows with missing required metadata', () => {
    const row = makeV2Row();
    delete row.sparse_cell;
    assert.throws(
      () => validateContributionRow(row),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 rows with invalid outcome labels', () => {
    assert.throws(
      () => validateContributionRow(makeV2Row({
        outcome_labels: {
          budget_label: 'under_budget',
          cost_label: 'tiny',
          time_label: 'fast',
          success_label: 'success',
        },
      })),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 rows with negative candidate pool size', () => {
    assert.throws(
      () => validateContributionRow(makeV2Row({
        candidate_pool: {
          scenario_id: 'challenger',
          scenario_kind: 'challenger',
          pool_size: -1,
        },
      })),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 rows with non-ISO observed_at', () => {
    assert.throws(
      () => validateContributionRow(makeV2Row({
        observed_at: 'not-a-date',
      })),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('matches the JSON schema fixture for v2 rows', () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dirname, 'hokusai-contribution-schema.json'), 'utf-8'),
    ) as object;
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);

    assert.equal(validate(makeV2Row()), true, JSON.stringify(validate.errors));
  });
});
