/**
 * Unit tests for Hokusai schema adapters.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvalRecord, TaskDescriptor } from './eval-schema.ts';
import {
  complexityToHokusaiScore,
  descriptionLengthToBucket,
  filesTouchedToBucket,
  mapDomain,
  mapLanguage,
  mapTaskType,
  repoSizeToBucket,
  riskFlagsToBooleans,
  riskFlagsToLevel,
  toHokusaiInput,
  toHokusaiSubmission,
  validateHokusaiSubmission,
} from './hokusai-schema.ts';

function makeDescriptor(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    schema_version: '1.0',
    signals: {
      heuristic: {
        task_type: 'feature',
        languages: ['typescript'],
        framework_tags: ['react'],
        files_touched: 4,
        repo_size_loc: 42_000,
        description_tokens: 120,
        is_greenfield: true,
        has_migration: false,
        has_ui: true,
        has_tests: true,
        cross_service: false,
      },
      learned: {
        complexity: 4,
        domain: 'frontend',
        risk_flags: [],
      },
    },
    constraints: {
      max_cost_usd: 12.5,
      models_available: ['gpt-5.4', 'gpt-5.3-codex'],
      objective: 'balanced',
    },
    stages: {},
    ...overrides,
  };
}

describe('hokusai-schema', () => {
  describe('complexityToHokusaiScore', () => {
    it('maps wavemill complexity bands to odd-numbered Hokusai scores', () => {
      assert.equal(complexityToHokusaiScore(1), 1);
      assert.equal(complexityToHokusaiScore(2), 3);
      assert.equal(complexityToHokusaiScore(3), 5);
      assert.equal(complexityToHokusaiScore(4), 7);
      assert.equal(complexityToHokusaiScore(5), 9);
    });

    it('defaults invalid complexity values to medium', () => {
      assert.equal(complexityToHokusaiScore(undefined), 5);
      assert.equal(complexityToHokusaiScore(0), 5);
      assert.equal(complexityToHokusaiScore(999), 5);
    });
  });

  describe('repoSizeToBucket', () => {
    it('buckets repository LOC at the expected boundaries', () => {
      assert.equal(repoSizeToBucket(4_999), 'small');
      assert.equal(repoSizeToBucket(5_000), 'medium');
      assert.equal(repoSizeToBucket(49_999), 'medium');
      assert.equal(repoSizeToBucket(50_000), 'large');
      assert.equal(repoSizeToBucket(499_999), 'large');
      assert.equal(repoSizeToBucket(500_000), 'xlarge');
    });

    it('defaults missing repo size to medium', () => {
      assert.equal(repoSizeToBucket(undefined), 'medium');
    });
  });

  describe('filesTouchedToBucket', () => {
    it('buckets file counts correctly', () => {
      assert.equal(filesTouchedToBucket(1), '1');
      assert.equal(filesTouchedToBucket(2), '2_5');
      assert.equal(filesTouchedToBucket(5), '2_5');
      assert.equal(filesTouchedToBucket(6), '6_15');
      assert.equal(filesTouchedToBucket(15), '6_15');
      assert.equal(filesTouchedToBucket(16), '16_plus');
    });

    it('defaults missing file counts to 2_5', () => {
      assert.equal(filesTouchedToBucket(undefined), '2_5');
      assert.equal(filesTouchedToBucket(0), '2_5');
    });
  });

  describe('descriptionLengthToBucket', () => {
    it('accepts token counts and raw text', () => {
      assert.equal(descriptionLengthToBucket(49), 'short');
      assert.equal(descriptionLengthToBucket(50), 'medium');
      assert.equal(descriptionLengthToBucket(199), 'medium');
      assert.equal(descriptionLengthToBucket(200), 'long');
      assert.equal(descriptionLengthToBucket('x'.repeat(40)), 'short');
      assert.equal(descriptionLengthToBucket('x'.repeat(400)), 'medium');
      assert.equal(descriptionLengthToBucket('x'.repeat(900)), 'long');
    });

    it('defaults missing length to medium', () => {
      assert.equal(descriptionLengthToBucket(undefined), 'medium');
    });
  });

  describe('risk mappings', () => {
    it('maps risk flags to risk levels', () => {
      assert.equal(riskFlagsToLevel(undefined), 'low');
      assert.equal(riskFlagsToLevel(['rsc-serialization']), 'low');
      assert.equal(riskFlagsToLevel(['schema-migration']), 'medium');
      assert.equal(
        riskFlagsToLevel(['schema-migration', 'cross-service']),
        'high',
      );
    });

    it('maps risk flags to fallback booleans', () => {
      assert.deepEqual(
        riskFlagsToBooleans([
          'schema-migration',
          'cross-service',
          'test-infrastructure',
          'rsc-serialization',
        ]),
        {
          is_greenfield: false,
          is_migration: true,
          requires_tests: true,
          cross_service: true,
          ui_heavy: true,
        },
      );
    });
  });

  describe('enum mappings', () => {
    it('maps task types, domains, and languages into Hokusai enums', () => {
      assert.equal(mapTaskType('test'), 'tests');
      assert.equal(mapTaskType('chore'), 'unknown');
      assert.equal(mapTaskType('feature', { hasMigration: true }), 'migration');

      assert.equal(mapDomain('full-stack'), 'fullstack');
      assert.equal(mapDomain('infrastructure'), 'devops');
      assert.equal(mapDomain('data-pipeline'), 'data');
      assert.equal(mapDomain('something-else'), 'unknown');

      assert.equal(mapLanguage(['TypeScript']), 'typescript');
      assert.equal(mapLanguage(['TypeScript', 'Python']), 'multi');
      assert.equal(mapLanguage(undefined, 'Bash'), 'bash');
      assert.equal(mapLanguage(['SQL']), 'unknown');
    });
  });

  describe('toHokusaiInput', () => {
    it('maps a populated descriptor into a complete Hokusai input', () => {
      const descriptor = makeDescriptor({
        signals: {
          heuristic: {
            task_type: 'feature',
            languages: ['typescript', 'javascript'],
            framework_tags: ['react'],
            files_touched: 8,
            repo_size_loc: 600_000,
            description_tokens: 250,
            is_greenfield: false,
            has_migration: true,
            has_ui: true,
            has_tests: true,
            cross_service: true,
          },
          learned: {
            complexity: 5,
            domain: 'full-stack',
            risk_flags: ['schema-migration', 'cross-service'],
          },
        },
      });

      const result = toHokusaiInput(
        descriptor,
        {
          repoId: 'repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          repoSize: { fileCount: 120, loc: 600_000, dependencyCount: 25 },
        },
        {
          plannerModels: ['planner-a'],
          coderModels: ['coder-a'],
          reviewerModels: ['reviewer-a'],
        },
        'HOK-1235',
      );

      assert.deepEqual(result, {
        schema_version: '1.0',
        task_id: 'HOK-1235',
        task_descriptor: {
          task_type: 'migration',
          language: 'multi',
          domain: 'fullstack',
          complexity: 9,
          repo_size_bucket: 'xlarge',
          files_touched_bucket: '6_15',
          description_length_bucket: 'long',
          is_greenfield: false,
          is_migration: true,
          requires_tests: true,
          cross_service: true,
          ui_heavy: true,
          risk_level: 'high',
        },
        constraints: {
          max_cost_usd: 12.5,
        },
        available_models: {
          planner_models: ['planner-a'],
          coder_models: ['coder-a'],
          reviewer_models: ['reviewer-a'],
        },
      });
    });

    it('fills sensible defaults for minimal or partial descriptors', () => {
      const result = toHokusaiInput(
        {
          schema_version: '1.0',
          signals: {
            heuristic: {
              task_type: 'chore',
              languages: [],
              framework_tags: [],
              files_touched: 0,
              repo_size_loc: 0,
              description_tokens: 0,
              is_greenfield: false,
              has_migration: false,
              has_ui: false,
              has_tests: false,
              cross_service: false,
            },
            learned: {
              complexity: 99,
              domain: 'mystery',
              risk_flags: [],
            },
          },
          constraints: {
            models_available: [],
            objective: 'balanced',
          },
          stages: {},
        },
        undefined,
        undefined,
        'task-1',
      );

      assert.deepEqual(result, {
        schema_version: '1.0',
        task_id: 'task-1',
        task_descriptor: {
          task_type: 'unknown',
          language: 'unknown',
          domain: 'unknown',
          complexity: 5,
          repo_size_bucket: 'small',
          files_touched_bucket: '2_5',
          description_length_bucket: 'short',
          is_greenfield: false,
          is_migration: false,
          requires_tests: false,
          cross_service: false,
          ui_heavy: false,
          risk_level: 'low',
        },
        constraints: {
          max_cost_usd: 0,
        },
        available_models: {
          planner_models: [],
          coder_models: [],
          reviewer_models: [],
        },
      });
    });

    it('handles an effectively empty descriptor without throwing', () => {
      const result = toHokusaiInput(
        {} as Partial<TaskDescriptor>,
        {
          repoId: 'repo',
          repoVisibility: 'private',
          primaryLanguage: 'Python',
          repoSize: { fileCount: 5, loc: 2_000, dependencyCount: 1 },
        },
        {
          maxCostUsd: 3,
          availableModels: ['gpt-5.4'],
        },
      );

      assert.equal(result.task_descriptor.language, 'python');
      assert.equal(result.task_descriptor.repo_size_bucket, 'small');
      assert.equal(result.constraints.max_cost_usd, 3);
      assert.deepEqual(result.available_models, {
        planner_models: ['gpt-5.4'],
        coder_models: ['gpt-5.4'],
        reviewer_models: ['gpt-5.4'],
      });
    });
  });

  describe('toHokusaiSubmission', () => {
    function makeEvalRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
      return {
        id: 'run-123',
        schemaVersion: '1.4.0',
        originalPrompt: 'Test prompt',
        modelId: 'claude-opus-4-6',
        modelVersion: '1.0',
        score: 0.9,
        scoreBand: 'Minor Feedback',
        timeSeconds: 1840,
        timestamp: '2026-04-13T00:00:00Z',
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'Test rationale',
        issueId: 'HOK-1237',
        workflowCost: 2.41,
        ...overrides,
      };
    }

    it('converts complete record with taskDescriptor.stages to submission', () => {
      const record = makeEvalRecord({
        taskDescriptor: {
          schema_version: '1.0',
          signals: {
            heuristic: {
              task_type: 'feature',
              languages: ['typescript'],
              framework_tags: [],
              files_touched: 3,
              repo_size_loc: 50000,
              description_tokens: 100,
              is_greenfield: false,
              has_migration: false,
              has_ui: false,
              has_tests: true,
              cross_service: false,
            },
            learned: {
              complexity: 3,
              domain: 'backend',
              risk_flags: [],
            },
          },
          constraints: {
            max_cost_usd: 5.0,
            models_available: ['claude-opus-4-6'],
            objective: 'balanced',
          },
          stages: {
            planner: { model: 'claude-opus-4-6' },
            coder: { model: 'claude-opus-4-6' },
            reviewer: { model: 'claude-opus-4-6' },
          },
        },
      });

      const submission = toHokusaiSubmission(record);
      assert.ok(submission);
      assert.equal(submission.run_id, 'run-123');
      assert.equal(submission.task_id, 'HOK-1237');
      assert.equal(submission.route_taken.planner_model, 'claude-opus-4-6');
      assert.equal(submission.route_taken.coder_model, 'claude-opus-4-6');
      assert.equal(submission.route_taken.reviewer_model, 'claude-opus-4-6');
      assert.equal(submission.observed_outcomes.actual_cost_usd, 2.41);
      assert.equal(submission.observed_outcomes.actual_time_seconds, 1840);
      assert.equal(submission.observed_outcomes.intervention_count, 0);
      assert.equal(submission.observed_outcomes.completed_successfully, true);
      assert.equal(submission.constraints.max_cost_usd, 5.0);
    });

    it('uses taskDescriptor.stages over routingDecision', () => {
      const record = makeEvalRecord({
        taskDescriptor: {
          schema_version: '1.0',
          signals: {
            heuristic: {
              task_type: 'feature',
              languages: ['typescript'],
              framework_tags: [],
              files_touched: 3,
              repo_size_loc: 50000,
              description_tokens: 100,
              is_greenfield: false,
              has_migration: false,
              has_ui: false,
              has_tests: true,
              cross_service: false,
            },
            learned: {
              complexity: 3,
              domain: 'backend',
              risk_flags: [],
            },
          },
          constraints: {
            max_cost_usd: undefined,
            models_available: [],
            objective: 'balanced',
          },
          stages: {
            planner: { model: 'opus-stages' },
            coder: { model: 'opus-stages' },
            reviewer: { model: 'opus-stages' },
          },
        },
        routingDecision: {
          candidates: [
            { agentType: 'claude', modelId: 'sonnet-routing' },
          ],
          chosen: { agentType: 'claude', modelId: 'sonnet-routing' },
          decisionPolicyVersion: 'baseline',
        },
      });

      const submission = toHokusaiSubmission(record);
      assert.ok(submission);
      // Should prefer stages over routingDecision
      assert.equal(submission.route_taken.planner_model, 'opus-stages');
      assert.equal(submission.route_taken.coder_model, 'opus-stages');
      assert.equal(submission.route_taken.reviewer_model, 'opus-stages');
    });

    it('falls back to routingDecision.chosen when no stages', () => {
      const record = makeEvalRecord({
        routingDecision: {
          candidates: [
            { agentType: 'claude', modelId: 'opus-chosen' },
          ],
          chosen: { agentType: 'claude', modelId: 'opus-chosen' },
          decisionPolicyVersion: 'router-v1',
        },
      });

      const submission = toHokusaiSubmission(record);
      assert.ok(submission);
      // All stages use the single chosen modelId
      assert.equal(submission.route_taken.planner_model, 'opus-chosen');
      assert.equal(submission.route_taken.coder_model, 'opus-chosen');
      assert.equal(submission.route_taken.reviewer_model, 'opus-chosen');
    });

    it('resolves routingDecision.chosen when it is an index', () => {
      const record = makeEvalRecord({
        routingDecision: {
          candidates: [
            { agentType: 'claude', modelId: 'model-0' },
            { agentType: 'claude', modelId: 'model-1' },
            { agentType: 'claude', modelId: 'model-2' },
          ],
          chosen: 1, // Index into candidates array
          decisionPolicyVersion: 'router-v2',
        },
      });

      const submission = toHokusaiSubmission(record);
      assert.ok(submission);
      // Should resolve index 1 to model-1
      assert.equal(submission.route_taken.planner_model, 'model-1');
      assert.equal(submission.route_taken.coder_model, 'model-1');
      assert.equal(submission.route_taken.reviewer_model, 'model-1');
    });

    it('returns null when issueId missing', () => {
      const record = makeEvalRecord({ issueId: undefined });
      const submission = toHokusaiSubmission(record);
      assert.equal(submission, null);
    });

    it('returns null when run_id (id) missing', () => {
      const record = makeEvalRecord({ id: '' });
      const submission = toHokusaiSubmission(record);
      assert.equal(submission, null);
    });

    it('returns null when workflowCost is undefined', () => {
      const record = makeEvalRecord({ workflowCost: undefined });
      const submission = toHokusaiSubmission(record);
      assert.equal(submission, null);
    });

    it('returns null when workflowCost is null', () => {
      const record = makeEvalRecord({ workflowCost: null });
      const submission = toHokusaiSubmission(record);
      assert.equal(submission, null);
    });

    it('returns valid submission when workflowCost is 0', () => {
      const record = makeEvalRecord({
        workflowCost: 0,
        routingDecision: {
          candidates: [{ agentType: 'claude', modelId: 'opus' }],
          chosen: { agentType: 'claude', modelId: 'opus' },
          decisionPolicyVersion: 'baseline',
        },
      });

      const submission = toHokusaiSubmission(record);
      assert.ok(submission);
      assert.equal(submission.observed_outcomes.actual_cost_usd, 0);
    });

    it('returns null when neither stages nor routingDecision available', () => {
      const record = makeEvalRecord({});
      const submission = toHokusaiSubmission(record);
      assert.equal(submission, null);
    });

    it('derives completed_successfully from score when outcomes.success unavailable', () => {
      const recordSuccess = makeEvalRecord({
        score: 0.5,
        routingDecision: {
          candidates: [{ agentType: 'claude', modelId: 'opus' }],
          chosen: { agentType: 'claude', modelId: 'opus' },
          decisionPolicyVersion: 'baseline',
        },
      });

      const submissionSuccess = toHokusaiSubmission(recordSuccess);
      assert.ok(submissionSuccess);
      assert.equal(submissionSuccess.observed_outcomes.completed_successfully, true);

      const recordFailure = makeEvalRecord({
        score: 0,
        routingDecision: {
          candidates: [{ agentType: 'claude', modelId: 'opus' }],
          chosen: { agentType: 'claude', modelId: 'opus' },
          decisionPolicyVersion: 'baseline',
        },
      });

      const submissionFailure = toHokusaiSubmission(recordFailure);
      assert.ok(submissionFailure);
      assert.equal(submissionFailure.observed_outcomes.completed_successfully, false);
    });

    it('prefers outcomes.success over score for completed_successfully', () => {
      const record = makeEvalRecord({
        score: 0, // score is 0 (would mean failure)
        outcomes: { success: true }, // but outcomes says success
        routingDecision: {
          candidates: [{ agentType: 'claude', modelId: 'opus' }],
          chosen: { agentType: 'claude', modelId: 'opus' },
          decisionPolicyVersion: 'baseline',
        },
      });

      const submission = toHokusaiSubmission(record);
      assert.ok(submission);
      // Should use outcomes.success, not score
      assert.equal(submission.observed_outcomes.completed_successfully, true);
    });

    it('extracts max_cost_usd from record.constraints', () => {
      const record = makeEvalRecord({
        constraints: { maxCostUsd: 3.5 },
        routingDecision: {
          candidates: [{ agentType: 'claude', modelId: 'opus' }],
          chosen: { agentType: 'claude', modelId: 'opus' },
          decisionPolicyVersion: 'baseline',
        },
      });

      const submission = toHokusaiSubmission(record);
      assert.ok(submission);
      assert.equal(submission.constraints.max_cost_usd, 3.5);
    });

    it('falls back to taskDescriptor.constraints.max_cost_usd', () => {
      const record = makeEvalRecord({
        taskDescriptor: {
          schema_version: '1.0',
          signals: {
            heuristic: {
              task_type: 'feature',
              languages: ['typescript'],
              framework_tags: [],
              files_touched: 3,
              repo_size_loc: 50000,
              description_tokens: 100,
              is_greenfield: false,
              has_migration: false,
              has_ui: false,
              has_tests: true,
              cross_service: false,
            },
            learned: {
              complexity: 3,
              domain: 'backend',
              risk_flags: [],
            },
          },
          constraints: {
            max_cost_usd: 2.75,
            models_available: [],
            objective: 'balanced',
          },
          stages: {
            planner: { model: 'opus' },
            coder: { model: 'opus' },
            reviewer: { model: 'opus' },
          },
        },
      });

      const submission = toHokusaiSubmission(record);
      assert.ok(submission);
      assert.equal(submission.constraints.max_cost_usd, 2.75);
    });

    it('sets max_cost_usd to null when both sources unavailable', () => {
      const record = makeEvalRecord({
        routingDecision: {
          candidates: [{ agentType: 'claude', modelId: 'opus' }],
          chosen: { agentType: 'claude', modelId: 'opus' },
          decisionPolicyVersion: 'baseline',
        },
      });

      const submission = toHokusaiSubmission(record);
      assert.ok(submission);
      assert.equal(submission.constraints.max_cost_usd, null);
    });

    it('prioritizes record.constraints over taskDescriptor.constraints', () => {
      const record = makeEvalRecord({
        constraints: { maxCostUsd: 10.0 },
        taskDescriptor: {
          schema_version: '1.0',
          signals: {
            heuristic: {
              task_type: 'feature',
              languages: ['typescript'],
              framework_tags: [],
              files_touched: 3,
              repo_size_loc: 50000,
              description_tokens: 100,
              is_greenfield: false,
              has_migration: false,
              has_ui: false,
              has_tests: true,
              cross_service: false,
            },
            learned: {
              complexity: 3,
              domain: 'backend',
              risk_flags: [],
            },
          },
          constraints: {
            max_cost_usd: 5.0, // This should be ignored
            models_available: [],
            objective: 'balanced',
          },
          stages: {
            planner: { model: 'opus' },
            coder: { model: 'opus' },
            reviewer: { model: 'opus' },
          },
        },
      });

      const submission = toHokusaiSubmission(record);
      assert.ok(submission);
      assert.equal(submission.constraints.max_cost_usd, 10.0);
    });
  });

  describe('validateHokusaiSubmission', () => {
    function makeSubmission(overrides: any = {}) {
      return {
        run_id: 'run-123',
        task_id: 'HOK-1237',
        constraints: {
          max_cost_usd: 5.0,
        },
        route_taken: {
          planner_model: 'claude-opus-4-6',
          coder_model: 'claude-opus-4-6',
          reviewer_model: 'claude-opus-4-6',
        },
        observed_outcomes: {
          completed_successfully: true,
          actual_cost_usd: 2.41,
          actual_time_seconds: 1840,
          intervention_count: 0,
        },
        ...overrides,
      };
    }

    it('validates a correct submission', () => {
      const submission = makeSubmission();
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it('rejects empty run_id', () => {
      const submission = makeSubmission({ run_id: '' });
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('run_id')));
    });

    it('rejects empty task_id', () => {
      const submission = makeSubmission({ task_id: '' });
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('task_id')));
    });

    it('rejects empty planner_model', () => {
      const submission = makeSubmission({
        route_taken: {
          planner_model: '',
          coder_model: 'opus',
          reviewer_model: 'opus',
        },
      });
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('planner_model')));
    });

    it('rejects empty coder_model', () => {
      const submission = makeSubmission({
        route_taken: {
          planner_model: 'opus',
          coder_model: '',
          reviewer_model: 'opus',
        },
      });
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('coder_model')));
    });

    it('rejects empty reviewer_model', () => {
      const submission = makeSubmission({
        route_taken: {
          planner_model: 'opus',
          coder_model: 'opus',
          reviewer_model: '',
        },
      });
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('reviewer_model')));
    });

    it('rejects negative actual_cost_usd', () => {
      const submission = makeSubmission({
        observed_outcomes: {
          completed_successfully: true,
          actual_cost_usd: -1,
          actual_time_seconds: 1840,
          intervention_count: 0,
        },
      });
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('actual_cost_usd')));
    });

    it('rejects negative actual_time_seconds', () => {
      const submission = makeSubmission({
        observed_outcomes: {
          completed_successfully: true,
          actual_cost_usd: 2.41,
          actual_time_seconds: -100,
          intervention_count: 0,
        },
      });
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('actual_time_seconds')));
    });

    it('rejects negative intervention_count', () => {
      const submission = makeSubmission({
        observed_outcomes: {
          completed_successfully: true,
          actual_cost_usd: 2.41,
          actual_time_seconds: 1840,
          intervention_count: -1,
        },
      });
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('intervention_count')));
    });

    it('allows max_cost_usd to be null', () => {
      const submission = makeSubmission({
        constraints: { max_cost_usd: null },
      });
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, true);
    });

    it('accumulates multiple errors', () => {
      const submission = makeSubmission({
        run_id: '',
        task_id: '',
        route_taken: {
          planner_model: '',
          coder_model: '',
          reviewer_model: '',
        },
      });
      const result = validateHokusaiSubmission(submission);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length >= 5); // run_id, task_id, planner, coder, reviewer
    });
  });
});
