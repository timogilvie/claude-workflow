import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V1,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
  TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
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

  it('validates a minimal v2 row', () => {
    const row = validateContributionRow({
      schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
      row_id: 'test-row-1',
      benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      eval_id: 'eval-1',
      model_id: 'model-1',
      scenario: 'production_pool',
      candidate_pool_id: 'pool-1',
      task_descriptor: makeTaskDescriptor(),
      allowed_models: ['model-a', 'model-b'],
      selected_models: ['model-a'],
      max_cost_usd: 0.1,
      actual_cost_usd: 0.05,
      completed_successfully: true,
      scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      observed_at: '2026-06-15T00:00:00Z',
    });
    assert.equal(row.schema_version, TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2);
  });

  it('validates a full v2 row with optional fields', () => {
    const row = validateContributionRow({
      schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
      row_id: 'test-row-2',
      benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      eval_id: 'eval-2',
      model_id: 'model-2',
      scenario: 'challenger_present',
      candidate_pool_id: 'pool-2',
      task_descriptor: makeTaskDescriptor(),
      allowed_models: ['gpt-5.4', 'claude-sonnet-4-6', 'qwen3-coder-plus'],
      selected_models: ['gpt-5.4', 'qwen3-coder-plus', 'claude-sonnet-4-6'],
      selected_strategy: {
        planner_model: 'gpt-5.4',
        coder_model: 'qwen3-coder-plus',
        reviewer_model: 'claude-sonnet-4-6',
        routing_objective: 'lowest_cost',
      },
      max_cost_usd: 0.08,
      actual_cost_usd: 0.02,
      estimated_cost_usd: 0.022,
      actual_time_seconds: 520,
      estimated_duration_seconds: 560,
      estimated_success_under_budget: 0.75,
      completed_successfully: true,
      scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      observed_at: '2026-06-15T00:00:00Z',
      metadata: {
        sparse_infra: true,
        candidate_pool_robustness: 'high',
      },
    });
    assert.equal(row.scenario, 'challenger_present');
    assert.equal(row.selected_strategy?.routing_objective, 'lowest_cost');
  });

  it('validates v2 with all scenarios', () => {
    const scenarios: Array<'production_pool' | 'challenger_present' | 'dominant_model_removed' | 'low_budget' | 'sparse_cell'> = [
      'production_pool',
      'challenger_present',
      'dominant_model_removed',
      'low_budget',
      'sparse_cell',
    ];

    for (const scenario of scenarios) {
      const row = validateContributionRow({
        schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
        row_id: `test-${scenario}`,
        benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        eval_id: 'eval-test',
        model_id: 'model-test',
        scenario,
        candidate_pool_id: 'pool-test',
        task_descriptor: makeTaskDescriptor(),
        allowed_models: ['model-a'],
        selected_models: ['model-a'],
        max_cost_usd: 0.1,
        actual_cost_usd: 0.05,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
      });
      assert.equal(row.scenario, scenario);
    }
  });

  it('rejects v2 row with missing required field (row_id)', () => {
    assert.throws(
      () => validateContributionRow({
        schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
        benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        eval_id: 'eval-1',
        model_id: 'model-1',
        scenario: 'production_pool',
        candidate_pool_id: 'pool-1',
        task_descriptor: makeTaskDescriptor(),
        allowed_models: ['model-a'],
        selected_models: ['model-a'],
        max_cost_usd: 0.1,
        actual_cost_usd: 0.05,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 row with zero max_cost_usd', () => {
    assert.throws(
      () => validateContributionRow({
        schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
        row_id: 'test-row',
        benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        eval_id: 'eval-1',
        model_id: 'model-1',
        scenario: 'production_pool',
        candidate_pool_id: 'pool-1',
        task_descriptor: makeTaskDescriptor(),
        allowed_models: ['model-a'],
        selected_models: ['model-a'],
        max_cost_usd: 0,
        actual_cost_usd: 0.05,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 row with negative actual_cost_usd', () => {
    assert.throws(
      () => validateContributionRow({
        schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
        row_id: 'test-row',
        benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        eval_id: 'eval-1',
        model_id: 'model-1',
        scenario: 'production_pool',
        candidate_pool_id: 'pool-1',
        task_descriptor: makeTaskDescriptor(),
        allowed_models: ['model-a'],
        selected_models: ['model-a'],
        max_cost_usd: 0.1,
        actual_cost_usd: -0.01,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 row with duplicate allowed_models', () => {
    assert.throws(
      () => validateContributionRow({
        schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
        row_id: 'test-row',
        benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        eval_id: 'eval-1',
        model_id: 'model-1',
        scenario: 'production_pool',
        candidate_pool_id: 'pool-1',
        task_descriptor: makeTaskDescriptor(),
        allowed_models: ['model-a', 'model-a'],
        selected_models: ['model-a'],
        max_cost_usd: 0.1,
        actual_cost_usd: 0.05,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 row with empty allowed_models', () => {
    assert.throws(
      () => validateContributionRow({
        schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
        row_id: 'test-row',
        benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        eval_id: 'eval-1',
        model_id: 'model-1',
        scenario: 'production_pool',
        candidate_pool_id: 'pool-1',
        task_descriptor: makeTaskDescriptor(),
        allowed_models: [],
        selected_models: [],
        max_cost_usd: 0.1,
        actual_cost_usd: 0.05,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 row with out-of-range estimated_success_under_budget', () => {
    assert.throws(
      () => validateContributionRow({
        schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
        row_id: 'test-row',
        benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        eval_id: 'eval-1',
        model_id: 'model-1',
        scenario: 'production_pool',
        candidate_pool_id: 'pool-1',
        task_descriptor: makeTaskDescriptor(),
        allowed_models: ['model-a'],
        selected_models: ['model-a'],
        max_cost_usd: 0.1,
        actual_cost_usd: 0.05,
        estimated_success_under_budget: 1.5,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 row with invalid scenario', () => {
    assert.throws(
      () => validateContributionRow({
        schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
        row_id: 'test-row',
        benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        eval_id: 'eval-1',
        model_id: 'model-1',
        scenario: 'invalid_scenario' as unknown as 'production_pool',
        candidate_pool_id: 'pool-1',
        task_descriptor: makeTaskDescriptor(),
        allowed_models: ['model-a'],
        selected_models: ['model-a'],
        max_cost_usd: 0.1,
        actual_cost_usd: 0.05,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 row with wrong benchmark_spec_id', () => {
    assert.throws(
      () => validateContributionRow({
        schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
        row_id: 'test-row',
        benchmark_spec_id: 'wrong-spec-id' as unknown as 'technical_task_router.benchmark_score/v2',
        eval_id: 'eval-1',
        model_id: 'model-1',
        scenario: 'production_pool',
        candidate_pool_id: 'pool-1',
        task_descriptor: makeTaskDescriptor(),
        allowed_models: ['model-a'],
        selected_models: ['model-a'],
        max_cost_usd: 0.1,
        actual_cost_usd: 0.05,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'schema_validation_failed',
    );
  });

  it('rejects v2 row with forbidden fields in metadata', () => {
    assert.throws(
      () => validateContributionRow({
        schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
        row_id: 'test-row',
        benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        eval_id: 'eval-1',
        model_id: 'model-1',
        scenario: 'production_pool',
        candidate_pool_id: 'pool-1',
        task_descriptor: makeTaskDescriptor(),
        allowed_models: ['model-a'],
        selected_models: ['model-a'],
        max_cost_usd: 0.1,
        actual_cost_usd: 0.05,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
        metadata: {
          prompt: 'secret data',
        },
      }),
      (error: unknown) =>
        error instanceof ContributionValidationError
        && error.code === 'forbidden_field',
    );
  });

  it('backward-compatible alias references v1', () => {
    assert.equal(TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION, TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V1);
  });
});
