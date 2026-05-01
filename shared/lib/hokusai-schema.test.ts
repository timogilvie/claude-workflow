/**
 * Unit tests for Hokusai schema adapters.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvalRecord, TaskDescriptor } from './eval-schema.ts';
import { redactHokusaiSubmission } from './hokusai-redaction.ts';
import {
  complexityToHokusaiScore,
  descriptionLengthToBucket,
  filesTouchedToBucket,
  type HokusaiSubmissionResult,
  type HokusaiSubmission,
  mapDomain,
  mapLanguage,
  mapTaskType,
  repoSizeToBucket,
  riskFlagsToBooleans,
  riskFlagsToLevel,
  toHokusaiSubmission,
  toHokusaiInput,
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

function expectSuccess(result: HokusaiSubmissionResult): HokusaiSubmission {
  assert.equal(result.ok, true);
  return result.submission;
}

function expectFailure(result: HokusaiSubmissionResult, reasons: string[]): void {
  assert.deepEqual(result, {
    ok: false,
    reasons,
  });
}

function makeRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-1',
    schemaVersion: '1.4.0',
    originalPrompt: 'Implement the requested change',
    modelId: 'gpt-5.3-codex',
    modelVersion: 'gpt-5.3-codex-2026-01-01',
    score: 0.8,
    scoreBand: 'Minor Feedback',
    timeSeconds: 1840,
    timestamp: '2026-04-13T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 1,
    interventionDetails: [],
    rationale: 'Looks good.',
    issueId: 'HOK-1237',
    workflowCost: 2.41,
    outcomes: {
      success: true,
      review: {
        humanReviewRequired: false,
        rounds: 0,
        approvals: 0,
        changeRequests: 0,
      },
      rework: {
        agentIterations: 1,
      },
      delivery: {
        prCreated: true,
        merged: false,
      },
    },
    taskDescriptor: makeDescriptor({
      constraints: {
        max_cost_usd: 3,
        models_available: ['planner-a', 'coder-a', 'reviewer-a'],
        objective: 'balanced',
      },
      stages: {
        planner: { model: 'planner-a' },
        coder: { model: 'coder-a' },
        reviewer: { model: 'reviewer-a' },
      },
    }),
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

    it('falls back stage-by-stage to a shared model list when some overrides are missing', () => {
      const result = toHokusaiInput(
        {} as Partial<TaskDescriptor>,
        undefined,
        {
          availableModels: ['shared-a', 'shared-b'],
          plannerModels: ['planner-a'],
          reviewerModels: [],
        },
        'task-2',
      );

      assert.deepEqual(result.available_models, {
        planner_models: ['planner-a'],
        coder_models: ['shared-a', 'shared-b'],
        reviewer_models: ['shared-a', 'shared-b'],
      });
    });

    it('uses descriptor constraints when no overrides are provided', () => {
      const result = toHokusaiInput(makeDescriptor({
        constraints: {
          max_cost_usd: 12.5,
          models_available: ['shared-from-descriptor'],
          objective: 'balanced',
        },
      }));

      assert.deepEqual(result.available_models, {
        planner_models: ['shared-from-descriptor'],
        coder_models: ['shared-from-descriptor'],
        reviewer_models: ['shared-from-descriptor'],
      });
    });
  });

  describe('toHokusaiSubmission', () => {
    it('maps a populated eval record into a valid submission', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord()));

      assert.deepEqual(result, {
        schema_version: '1.0',
        run_id: 'eval-1',
        task_id: 'HOK-1237',
        constraints: {
          max_cost_usd: 3,
        },
        route_taken: {
          planner_model: 'planner-a',
          coder_model: 'coder-a',
          reviewer_model: 'reviewer-a',
        },
        observed_outcomes: {
          completed_successfully: true,
          actual_cost_usd: 2.41,
          actual_time_seconds: 1840,
          intervention_count: 1,
        },
      });
    });

    it('emits rubric signals and schema version 1.1 when rubric features are present', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord({
        rubric_provenance: 'judge',
        rubricEval: {
          schema_version: '1.0',
          rubric_version: '2026-04',
          criteria: {
            completeness: { score: 0.9, rationale: 'internal text' },
            correctness: { score: 0.8, rationale: 'internal text' },
            code_quality: { score: 0.7, rationale: 'internal text' },
            intervention_impact: { score: 0.6, rationale: 'internal text' },
            autonomy: { score: 0.5, rationale: 'internal text' },
          },
          determinative_boundary: 'functional_bug',
        },
        taskDescriptor: makeDescriptor({
          constraints: {
            max_cost_usd: 3,
            models_available: ['planner-a', 'coder-a', 'reviewer-a'],
            objective: 'balanced',
          },
          stages: {
            planner: { model: 'planner-a' },
            coder: { model: 'coder-a' },
            reviewer: { model: 'reviewer-a' },
          },
          rubric: {
            has_rubric: true,
            criterion_count: 5,
            mean_score: 0.7,
            criteria_scores: {
              completeness: 0.9,
              correctness: 0.8,
              code_quality: 0.7,
              intervention_impact: 0.6,
              autonomy: 0.5,
            },
            determinative_boundary: 'functional_bug',
          },
        }),
      })));

      assert.equal(result.schema_version, '1.1');
      assert.deepEqual(result.rubric_signals, {
        rubric_version: '2026-04',
        criterion_count: 5,
        mean_score: 0.7,
        criteria_scores: {
          completeness: 0.9,
          correctness: 0.8,
          code_quality: 0.7,
          intervention_impact: 0.6,
          autonomy: 0.5,
        },
        determinative_boundary: 'functional_bug',
        rubric_provenance: 'judge',
      });
    });

    it('omits rubric signals and emits schema version 1.0 when rubric data is absent', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord()));

      assert.equal(result.schema_version, '1.0');
      assert.equal(result.rubric_signals, undefined);
    });

    it('omits rubric signals when descriptor explicitly says rubric is absent', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord({
        taskDescriptor: makeDescriptor({
          constraints: {
            max_cost_usd: 3,
            models_available: ['planner-a', 'coder-a', 'reviewer-a'],
            objective: 'balanced',
          },
          stages: {
            planner: { model: 'planner-a' },
            coder: { model: 'coder-a' },
            reviewer: { model: 'reviewer-a' },
          },
          rubric: {
            has_rubric: false,
            criterion_count: 0,
            mean_score: 0,
            criteria_scores: {
              completeness: 0,
              correctness: 0,
              code_quality: 0,
              intervention_impact: 0,
              autonomy: 0,
            },
          },
        }),
      })));

      assert.equal(result.schema_version, '1.0');
      assert.equal(result.rubric_signals, undefined);
    });

    it('uses taskDescriptor stage models when present', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord({
        routingDecision: {
          candidates: [
            { agentType: 'codex', modelId: 'fallback-model' },
          ],
          chosen: 0,
        },
      })));

      assert.deepEqual(result.route_taken, {
        planner_model: 'planner-a',
        coder_model: 'coder-a',
        reviewer_model: 'reviewer-a',
      });
    });

    it('falls back to a chosen routing candidate object when stages are missing', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord({
        taskDescriptor: undefined,
        routingDecision: {
          candidates: [
            { agentType: 'codex', modelId: 'gpt-5.4' },
          ],
          chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
        },
      })));

      assert.deepEqual(result.route_taken, {
        planner_model: 'gpt-5.4',
        coder_model: 'gpt-5.4',
        reviewer_model: 'gpt-5.4',
      });
    });

    it('falls back to a chosen routing candidate index when stages are missing', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord({
        taskDescriptor: undefined,
        routingDecision: {
          candidates: [
            { agentType: 'codex', modelId: 'candidate-a' },
            { agentType: 'codex', modelId: 'candidate-b' },
          ],
          chosen: 1,
        },
      })));

      assert.deepEqual(result.route_taken, {
        planner_model: 'candidate-b',
        coder_model: 'candidate-b',
        reviewer_model: 'candidate-b',
      });
    });

    it('returns eligibility failure when issueId is missing', () => {
      expectFailure(
        toHokusaiSubmission(makeRecord({ issueId: undefined })),
        ['missing_model_identity'],
      );
    });

    it('returns eligibility failure when workflowCost is missing', () => {
      expectFailure(
        toHokusaiSubmission(makeRecord({ workflowCost: undefined })),
        ['missing_cost'],
      );
    });

    it('accepts zero timeSeconds and zero workflowCost as valid observed outcomes', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord({
        workflowCost: 0,
        timeSeconds: 0,
      })));

      assert.equal(result.observed_outcomes.actual_cost_usd, 0);
      assert.equal(result.observed_outcomes.actual_time_seconds, 0);
    });

    it('returns eligibility failure when routing information is unavailable', () => {
      expectFailure(
        toHokusaiSubmission(makeRecord({
          taskDescriptor: undefined,
          routingDecision: undefined,
        })),
        ['missing_routing'],
      );
    });

    it('returns fallback routing diagnostics for an old-format record without attached eligibility metadata', () => {
      expectFailure(
        toHokusaiSubmission(makeRecord({
          taskDescriptor: undefined,
          routingDecision: undefined,
          outcomes: undefined,
          score: 0.3,
        })),
        ['missing_routing'],
      );
    });

    it('prefers EvalConstraints maxCostUsd over descriptor constraints', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord({
        constraints: { maxCostUsd: 1.25 },
      })));

      assert.equal(result.constraints.max_cost_usd, 1.25);
    });

    it('sets max_cost_usd to null when no budget constraint is available', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord({
        constraints: undefined,
        taskDescriptor: makeDescriptor({
          constraints: {
            models_available: ['planner-a'],
            objective: 'balanced',
          },
          stages: {
            planner: { model: 'planner-a' },
            coder: { model: 'coder-a' },
            reviewer: { model: 'reviewer-a' },
          },
        }),
      })));

      assert.equal(result.constraints.max_cost_usd, null);
    });

    it('uses outcomes.success when available', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord({
        score: 1,
        outcomes: {
          success: false,
          review: {
            humanReviewRequired: false,
            rounds: 0,
            approvals: 0,
            changeRequests: 0,
          },
          rework: {
            agentIterations: 1,
          },
          delivery: {
            prCreated: true,
            merged: false,
          },
        },
      })));

      assert.equal(result.observed_outcomes.completed_successfully, false);
    });

    it('falls back to score when outcomes are missing', () => {
      const success = expectSuccess(toHokusaiSubmission(makeRecord({
        trainingEligible: true,
        outcomes: undefined,
        score: 0.5,
      })));
      const failure = expectSuccess(toHokusaiSubmission(makeRecord({
        trainingEligible: true,
        outcomes: undefined,
        score: 0.4,
      })));

      assert.equal(success.observed_outcomes.completed_successfully, true);
      assert.equal(failure.observed_outcomes.completed_successfully, false);
    });

    it('defaults missing interventionCount to zero', () => {
      const result = expectSuccess(toHokusaiSubmission(makeRecord({
        interventionCount: undefined as unknown as number,
      })));

      assert.equal(result.observed_outcomes.intervention_count, 0);
    });

    it('prefers attached eligibility diagnostics when training is marked ineligible', () => {
      expectFailure(
        toHokusaiSubmission(makeRecord({
          trainingEligible: false,
          eligibilityErrors: ['missing_outcome', 'missing_routing'],
        })),
        ['missing_outcome', 'missing_routing'],
      );
    });

    it('does not leak eval eligibility metadata into redacted submissions', () => {
      const submission = expectSuccess(toHokusaiSubmission(makeRecord({
        eligibilityErrors: ['missing_routing'],
        trainingEligible: true,
      })));

      const redacted = redactHokusaiSubmission(submission, { salt: 'f'.repeat(64) }) as Record<string, unknown>;

      assert.equal('eligibilityErrors' in redacted, false);
    });
  });

  describe('validateHokusaiSubmission', () => {
    it('accepts a complete valid submission', () => {
      const submission = expectSuccess(toHokusaiSubmission(makeRecord()));

      assert.deepEqual(validateHokusaiSubmission(submission), {
        valid: true,
        errors: [],
      });
    });

    it('accepts valid rubric signals', () => {
      const submission = expectSuccess(toHokusaiSubmission(makeRecord({
        rubric_provenance: 'backfill_derived',
        rubricEval: {
          schema_version: '1.0',
          rubric_version: '2026-04',
          criteria: {
            completeness: { score: 1, rationale: '' },
            correctness: { score: 0.8, rationale: '' },
            code_quality: { score: 0.7, rationale: '' },
            intervention_impact: { score: 0.6, rationale: '' },
            autonomy: { score: 0.5, rationale: '' },
          },
        },
        taskDescriptor: makeDescriptor({
          constraints: {
            max_cost_usd: 3,
            models_available: ['planner-a', 'coder-a', 'reviewer-a'],
            objective: 'balanced',
          },
          stages: {
            planner: { model: 'planner-a' },
            coder: { model: 'coder-a' },
            reviewer: { model: 'reviewer-a' },
          },
          rubric: {
            has_rubric: true,
            criterion_count: 5,
            mean_score: 0.72,
            criteria_scores: {
              completeness: 1,
              correctness: 0.8,
              code_quality: 0.7,
              intervention_impact: 0.6,
              autonomy: 0.5,
            },
          },
        }),
      })));

      assert.deepEqual(validateHokusaiSubmission(submission), {
        valid: true,
        errors: [],
      });
    });

    it('accepts old-format submissions without schema version or rubric signals', () => {
      const submission = expectSuccess(toHokusaiSubmission(makeRecord()));
      delete submission.schema_version;

      assert.deepEqual(validateHokusaiSubmission(submission), {
        valid: true,
        errors: [],
      });
    });

    it('rejects malformed rubric signal numbers', () => {
      const submission = expectSuccess(toHokusaiSubmission(makeRecord()));
      submission.schema_version = '1.1';
      submission.rubric_signals = {
        rubric_version: '2026-04',
        criterion_count: 5,
        mean_score: -0.1,
        criteria_scores: {
          completeness: Number.NaN,
          correctness: 0.8,
          code_quality: 0.7,
          intervention_impact: 0.6,
          autonomy: 0.5,
        },
      };

      const result = validateHokusaiSubmission(submission);

      assert.equal(result.valid, false);
      assert.deepEqual(result.errors, [
        'rubric_signals.mean_score must be a non-negative number',
        'rubric_signals.criteria_scores.completeness must be a number between 0 and 1',
      ]);
    });

    it('rejects unsupported submission schema versions', () => {
      const submission = expectSuccess(toHokusaiSubmission(makeRecord()));
      submission.schema_version = '2.0';

      const result = validateHokusaiSubmission(submission);

      assert.equal(result.valid, false);
      assert.deepEqual(result.errors, [
        'schema_version must be "1.0" or "1.1"',
      ]);
    });

    it('reports an empty run_id', () => {
      const submission = expectSuccess(toHokusaiSubmission(makeRecord()));
      submission.run_id = '';

      const result = validateHokusaiSubmission(submission);

      assert.equal(result.valid, false);
      assert.deepEqual(result.errors, [
        'run_id must be a non-empty string',
      ]);
    });

    it('rejects negative costs', () => {
      const submission = expectSuccess(toHokusaiSubmission(makeRecord()));
      submission.observed_outcomes.actual_cost_usd = -1;

      const result = validateHokusaiSubmission(submission);

      assert.equal(result.valid, false);
      assert.deepEqual(result.errors, [
        'observed_outcomes.actual_cost_usd must be a non-negative number',
      ]);
    });

    it('reports multiple errors at once', () => {
      const submission = {
        run_id: '',
        task_id: '',
        constraints: {
          max_cost_usd: -1,
        },
        route_taken: {
          planner_model: '',
          coder_model: '',
          reviewer_model: '',
        },
        observed_outcomes: {
          completed_successfully: 'yes',
          actual_cost_usd: -1,
          actual_time_seconds: -2,
          intervention_count: 1.5,
        },
      } as unknown as HokusaiSubmission;

      const result = validateHokusaiSubmission(submission);

      assert.equal(result.valid, false);
      assert.deepEqual(result.errors, [
        'run_id must be a non-empty string',
        'task_id must be a non-empty string',
        'route_taken.planner_model must be a non-empty string',
        'route_taken.coder_model must be a non-empty string',
        'route_taken.reviewer_model must be a non-empty string',
        'observed_outcomes.completed_successfully must be a boolean',
        'observed_outcomes.actual_cost_usd must be a non-negative number',
        'observed_outcomes.actual_time_seconds must be a non-negative number',
        'observed_outcomes.intervention_count must be a non-negative integer',
        'constraints.max_cost_usd must be null or a non-negative number',
      ]);
    });
  });
});
