import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateContributionRow,
  TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
} from './hokusai-contribution-schema.ts';
import { buildTechnicalTaskRouterContributionRowV2 } from './hokusai-contribution-builder.ts';
import type { TechnicalTaskRouterV2ContributionProjection } from './hokusai-contribution-builder.ts';

describe('hokusai-contribution-v2', () => {
  it('validates a golden row from Hokusai fixture', () => {
    const goldenFixture = {
      schema_version: 'technical_task_router_row/v2',
      row_id: 'golden-prod-backend-001',
      benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      eval_id: 'technical-task-router-v2-golden',
      model_id: 'model-30-router-candidate',
      scenario: 'production_pool',
      candidate_pool_id: 'production-2026-06',
      task_descriptor: {
        task_type: 'feature',
        domain: 'backend',
        complexity: 'medium',
        tags: ['api', 'database'],
      },
      allowed_models: [
        'gpt-5.4',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
        'qwen3-coder-plus',
      ],
      selected_models: [
        'gpt-5.4',
        'gpt-5.4',
        'claude-sonnet-4-6',
      ],
      selected_strategy: {
        planner_model: 'gpt-5.4',
        coder_model: 'gpt-5.4',
        reviewer_model: 'claude-sonnet-4-6',
        routing_objective: 'highest_reliability',
      },
      max_cost_usd: 0.1,
      actual_cost_usd: 0.04,
      estimated_cost_usd: 0.045,
      actual_time_seconds: 640,
      estimated_duration_seconds: 700,
      estimated_success_under_budget: 0.82,
      completed_successfully: true,
      scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      observed_at: '2026-06-15T00:00:00Z',
    };

    const row = validateContributionRow(goldenFixture);
    assert.deepEqual(row, goldenFixture);
  });

  it('validates a challenger_present scenario row', () => {
    const challengerRow = {
      schema_version: 'technical_task_router_row/v2',
      row_id: 'golden-qwen-frontend-001',
      benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      eval_id: 'technical-task-router-v2-golden',
      model_id: 'model-30-router-candidate',
      scenario: 'challenger_present',
      candidate_pool_id: 'qwen-challenger-2026-06',
      task_descriptor: {
        task_type: 'bugfix',
        domain: 'frontend',
        complexity: 'medium',
        tags: ['react', 'routing'],
      },
      allowed_models: [
        'gpt-5.4',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
        'qwen3-coder-plus',
      ],
      selected_models: [
        'claude-sonnet-4-6',
        'qwen3-coder-plus',
        'claude-haiku-4-5-20251001',
      ],
      selected_strategy: {
        planner_model: 'claude-sonnet-4-6',
        coder_model: 'qwen3-coder-plus',
        reviewer_model: 'claude-haiku-4-5-20251001',
        routing_objective: 'lowest_cost',
      },
      max_cost_usd: 0.08,
      actual_cost_usd: 0.012,
      estimated_cost_usd: 0.014,
      actual_time_seconds: 520,
      estimated_duration_seconds: 560,
      estimated_success_under_budget: 0.76,
      completed_successfully: true,
      scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      observed_at: '2026-06-15T00:00:00Z',
    };

    const row = validateContributionRow(challengerRow);
    assert.equal(row.scenario, 'challenger_present');
    assert.deepEqual((row as any).selected_models, ['claude-sonnet-4-6', 'qwen3-coder-plus', 'claude-haiku-4-5-20251001']);
  });

  it('builds a v2 row from Wavemill data matching golden structure', () => {
    const projection: TechnicalTaskRouterV2ContributionProjection = {
      rowId: 'wavemill-test-001',
      evalId: 'wavemill-eval-001',
      modelId: 'wavemill-router-v2',
      scenario: 'production_pool',
      candidatePoolId: 'prod-2026-06',
      taskDescriptor: {
        task_type: 'feature',
        language: 'typescript',
        domain: 'backend',
        complexity: 5,
        repo_size_bucket: 'medium',
        files_touched_bucket: '2_5',
        description_length_bucket: 'medium',
        is_greenfield: false,
        is_migration: false,
        requires_tests: true,
        cross_service: false,
        ui_heavy: false,
        risk_level: 'medium',
      },
      allowedModels: ['gpt-5.4', 'claude-sonnet-4-6', 'qwen3-coder-plus'],
      selectedModels: ['gpt-5.4', 'gpt-5.4', 'claude-sonnet-4-6'],
      selectedStrategy: {
        planner_model: 'gpt-5.4',
        coder_model: 'gpt-5.4',
        reviewer_model: 'claude-sonnet-4-6',
        routing_objective: 'highest_reliability',
      },
      maxCostUsd: 0.1,
      actualCostUsd: 0.04,
      estimatedCostUsd: 0.045,
      actualTimeSeconds: 640,
      estimatedDurationSeconds: 700,
      estimatedSuccessUnderBudget: 0.82,
      completedSuccessfully: true,
      observedAt: '2026-06-15T00:00:00Z',
    };

    const row = buildTechnicalTaskRouterContributionRowV2(projection);

    assert.equal(row.schema_version, 'technical_task_router_row/v2');
    assert.equal(row.benchmark_spec_id, TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2);
    assert.equal(row.scenario, 'production_pool');
    assert.deepEqual(row.selected_models, ['gpt-5.4', 'gpt-5.4', 'claude-sonnet-4-6']);
    assert.equal(row.actual_cost_usd, 0.04);
  });

  it('preserves role-specific model pools in metadata', () => {
    const projection: TechnicalTaskRouterV2ContributionProjection = {
      rowId: 'test-metadata-001',
      evalId: 'eval-001',
      modelId: 'model-001',
      scenario: 'challenger_present',
      candidatePoolId: 'pool-001',
      taskDescriptor: {
        task_type: 'feature',
        language: 'typescript',
        domain: 'backend',
        complexity: 5,
        repo_size_bucket: 'medium',
        files_touched_bucket: '2_5',
        description_length_bucket: 'medium',
        is_greenfield: false,
        is_migration: false,
        requires_tests: true,
        cross_service: false,
        ui_heavy: false,
        risk_level: 'medium',
      },
      allowedModels: ['gpt-5.4', 'claude-sonnet-4-6', 'qwen3-coder-plus'],
      selectedModels: ['gpt-5.4', 'qwen3-coder-plus', 'claude-sonnet-4-6'],
      maxCostUsd: 0.08,
      actualCostUsd: 0.02,
      completedSuccessfully: true,
      observedAt: '2026-06-15T00:00:00Z',
      availablePlannerModels: ['gpt-5.4', 'claude-opus-4-7'],
      availableCoderModels: ['gpt-5.4', 'claude-sonnet-4-6', 'qwen3-coder-plus'],
      availableReviewerModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
    };

    const row = buildTechnicalTaskRouterContributionRowV2(projection);

    assert(row.metadata);
    assert.deepEqual(row.metadata.available_planner_models, ['gpt-5.4', 'claude-opus-4-7']);
    assert.deepEqual(row.metadata.available_coder_models, ['gpt-5.4', 'claude-sonnet-4-6', 'qwen3-coder-plus']);
    assert.deepEqual(row.metadata.available_reviewer_models, ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);
  });

  it('includes sparse_cell metadata when present', () => {
    const projection: TechnicalTaskRouterV2ContributionProjection = {
      rowId: 'sparse-test-001',
      evalId: 'eval-001',
      modelId: 'model-001',
      scenario: 'sparse_cell',
      candidatePoolId: 'sparse-infra-2026-06',
      taskDescriptor: {
        task_type: 'refactor',
        language: 'terraform',
        domain: 'infrastructure',
        complexity: 5,
        repo_size_bucket: 'large',
        files_touched_bucket: '5_10',
        description_length_bucket: 'long',
        is_greenfield: false,
        is_migration: true,
        requires_tests: true,
        cross_service: true,
        ui_heavy: false,
        risk_level: 'high',
      },
      allowedModels: ['gpt-5.4', 'claude-sonnet-4-6'],
      selectedModels: ['claude-sonnet-4-6'],
      maxCostUsd: 0.05,
      actualCostUsd: 0.025,
      completedSuccessfully: true,
      observedAt: '2026-06-15T00:00:00Z',
      metadata: {
        sparse_infra: true,
        sparse_reason: 'limited_terraform_examples',
        generalization_risk: 'high',
      },
    };

    const row = buildTechnicalTaskRouterContributionRowV2(projection);

    assert.equal(row.scenario, 'sparse_cell');
    assert(row.metadata);
    assert.equal(row.metadata.sparse_infra, true);
    assert.equal(row.metadata.sparse_reason, 'limited_terraform_examples');
  });

  it('allows all benchmark scenarios to be validated', () => {
    const scenarios: Array<'production_pool' | 'challenger_present' | 'dominant_model_removed' | 'low_budget' | 'sparse_cell'> = [
      'production_pool',
      'challenger_present',
      'dominant_model_removed',
      'low_budget',
      'sparse_cell',
    ];

    for (const scenario of scenarios) {
      const projection: TechnicalTaskRouterV2ContributionProjection = {
        rowId: `test-${scenario}`,
        evalId: 'eval-001',
        modelId: 'model-001',
        scenario,
        candidatePoolId: `pool-${scenario}`,
        taskDescriptor: {
          task_type: 'feature',
          language: 'typescript',
          domain: 'backend',
          complexity: 5,
          repo_size_bucket: 'medium',
          files_touched_bucket: '2_5',
          description_length_bucket: 'medium',
          is_greenfield: false,
          is_migration: false,
          requires_tests: true,
          cross_service: false,
          ui_heavy: false,
          risk_level: 'medium',
        },
        allowedModels: ['gpt-5.4', 'claude-sonnet-4-6'],
        selectedModels: ['gpt-5.4'],
        maxCostUsd: 0.1,
        actualCostUsd: 0.05,
        completedSuccessfully: true,
        observedAt: '2026-06-15T00:00:00Z',
      };

      const row = buildTechnicalTaskRouterContributionRowV2(projection);
      assert.equal(row.scenario, scenario);
    }
  });

  it('handles all routing objectives in selected_strategy', () => {
    const objectives: Array<'lowest_cost' | 'fastest_completion' | 'highest_reliability'> = [
      'lowest_cost',
      'fastest_completion',
      'highest_reliability',
    ];

    for (const objective of objectives) {
      const projection: TechnicalTaskRouterV2ContributionProjection = {
        rowId: `test-${objective}`,
        evalId: 'eval-001',
        modelId: 'model-001',
        scenario: 'production_pool',
        candidatePoolId: 'pool-001',
        taskDescriptor: {
          task_type: 'feature',
          language: 'typescript',
          domain: 'backend',
          complexity: 5,
          repo_size_bucket: 'medium',
          files_touched_bucket: '2_5',
          description_length_bucket: 'medium',
          is_greenfield: false,
          is_migration: false,
          requires_tests: true,
          cross_service: false,
          ui_heavy: false,
          risk_level: 'medium',
        },
        allowedModels: ['gpt-5.4', 'claude-sonnet-4-6'],
        selectedModels: ['gpt-5.4'],
        selectedStrategy: {
          planner_model: 'gpt-5.4',
          coder_model: 'gpt-5.4',
          reviewer_model: 'claude-sonnet-4-6',
          routing_objective: objective,
        },
        maxCostUsd: 0.1,
        actualCostUsd: 0.05,
        completedSuccessfully: true,
        observedAt: '2026-06-15T00:00:00Z',
      };

      const row = buildTechnicalTaskRouterContributionRowV2(projection);
      assert.equal(row.selected_strategy?.routing_objective, objective);
    }
  });

  it('validates rows with various model combinations including Qwen/DeepSeek', () => {
    const modelCombinations = [
      ['gpt-5.4', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
      ['qwen3-coder-plus', 'deepseek-v3', 'claude-opus-4-7'],
      ['gpt-5.4', 'qwen3-coder-plus', 'claude-sonnet-4-6'],
      ['deepseek-r1', 'gpt-5.4', 'claude-haiku-4-5-20251001'],
    ];

    for (const models of modelCombinations) {
      const row = validateContributionRow({
        schema_version: 'technical_task_router_row/v2',
        row_id: `test-models-${models[0]}`,
        benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        eval_id: 'eval-001',
        model_id: 'model-001',
        scenario: 'production_pool',
        candidate_pool_id: 'pool-001',
        task_descriptor: { task_type: 'feature', domain: 'backend' },
        allowed_models: models,
        selected_models: [models[0]],
        max_cost_usd: 0.1,
        actual_cost_usd: 0.05,
        completed_successfully: true,
        scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
        observed_at: '2026-06-15T00:00:00Z',
      });
      assert.deepEqual((row as any).allowed_models, models);
    }
  });

  it('validates row with no selected_strategy (optional field)', () => {
    const projection: TechnicalTaskRouterV2ContributionProjection = {
      rowId: 'minimal-strategy-001',
      evalId: 'eval-001',
      modelId: 'model-001',
      scenario: 'production_pool',
      candidatePoolId: 'pool-001',
      taskDescriptor: {
        task_type: 'feature',
        language: 'typescript',
        domain: 'backend',
        complexity: 5,
        repo_size_bucket: 'medium',
        files_touched_bucket: '2_5',
        description_length_bucket: 'medium',
        is_greenfield: false,
        is_migration: false,
        requires_tests: true,
        cross_service: false,
        ui_heavy: false,
        risk_level: 'medium',
      },
      allowedModels: ['gpt-5.4'],
      selectedModels: ['gpt-5.4'],
      maxCostUsd: 0.1,
      actualCostUsd: 0.05,
      completedSuccessfully: true,
      observedAt: '2026-06-15T00:00:00Z',
    };

    const row = buildTechnicalTaskRouterContributionRowV2(projection);
    assert(!row.selected_strategy);
  });
});
