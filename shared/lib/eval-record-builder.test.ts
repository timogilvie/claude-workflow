/**
 * Tests for eval-record-builder module.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import {
  attachEligibility,
  attachAgentType,
  attachBudgetMetadata,
  attachRouteCalibration,
  attachRoutePrediction,
  attachChallengeRouteContext,
  attachConstraints,
  attachDifficultyMetadata,
  attachFallbackEvent,
  attachPromptSizeDiagnostics,
  attachRouteProvenance,
  attachRouterPolicyMetadata,
  attachProviderMetadata,
  attachNonRewardReason,
  attachRubricEval,
  attachStageOutcomes,
  attachTaskContextMetadata,
  attachRepoContextMetadata,
  attachWorkflowCostMetadata,
  computeRouteCalibration,
  computeEligibility,
  enrichEvalRecord,
  enrichTrainingMetadata,
} from './eval-record-builder.ts';
import type { RubricEval } from './eval-schema.ts';

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      assert.equal(actual, expected);
    },
    toEqual(expected: unknown) {
      assert.deepEqual(actual, expected);
    },
    toBeUndefined() {
      assert.equal(actual, undefined);
    },
    toContain(expected: unknown) {
      if (Array.isArray(actual)) {
        assert.ok(actual.includes(expected));
        return;
      }
      if (typeof actual === 'string') {
        assert.ok(actual.includes(String(expected)));
        return;
      }
      assert.fail('expected value to be an array or string');
    },
    not: {
      toThrow() {
        assert.equal(typeof actual, 'function');
        assert.doesNotThrow(actual as () => void);
      },
      toHaveProperty(property: string) {
        assert.equal(actual !== null && typeof actual === 'object', true);
        assert.equal(Object.prototype.hasOwnProperty.call(actual, property), false);
      },
    },
  };
}

describe('eval-record-builder', () => {
  let baseRecord: EvalRecord;

  beforeEach(() => {
    // Create a minimal eval record
    baseRecord = {
      id: 'test-id',
      timestamp: '2026-03-02T12:00:00Z',
      score: 0.85,
      scoreBand: 'good',
      reasoning: 'Test reasoning',
      taskPrompt: 'Test task',
      prReviewOutput: 'Test PR',
      schemaVersion: '1.0.0',
    } as EvalRecord;
  });

  describe('attachAgentType', () => {
    it('should set agent type when provided', () => {
      attachAgentType(baseRecord, 'codex');
      expect(baseRecord.agentType).toBe('codex');
    });

    it('should default to "claude" when not provided', () => {
      attachAgentType(baseRecord, undefined);
      expect(baseRecord.agentType).toBe('claude');
    });

    it('should default to "claude" when empty string', () => {
      attachAgentType(baseRecord, '');
      expect(baseRecord.agentType).toBe('claude');
    });
  });

  describe('attachDifficultyMetadata', () => {
    it('should attach difficulty data when provided', () => {
      const difficultyData = {
        difficultyBand: 'medium' as const,
        difficultySignals: {
          locTouched: 150,
          filesTouched: 5,
          diffUncertain: false,
        },
        stratum: 'stratum-2' as const,
      };

      attachDifficultyMetadata(baseRecord, difficultyData);

      expect(baseRecord.difficultyBand).toBe('medium');
      expect(baseRecord.difficultySignals).toEqual(difficultyData.difficultySignals);
      expect(baseRecord.stratum).toBe('stratum-2');
    });

    it('should not modify record when difficultyData is null', () => {
      const before = { ...baseRecord };
      attachDifficultyMetadata(baseRecord, null);
      expect(baseRecord).toEqual(before);
    });
  });

  describe('attachProviderMetadata', () => {
    it('should attach provider metadata when present', () => {
      attachProviderMetadata(baseRecord, 'deepseek', 'https://api.deepseek.com/anthropic');
      expect(baseRecord.provider).toBe('deepseek');
      expect(baseRecord.endpoint).toBe('https://api.deepseek.com/anthropic');
    });

    it('should no-op when provider metadata is absent', () => {
      attachProviderMetadata(baseRecord, undefined, undefined);
      expect(baseRecord.provider).toBeUndefined();
      expect(baseRecord.endpoint).toBeUndefined();
    });
  });

  describe('attachTaskContextMetadata', () => {
    it('should attach task context when provided', () => {
      const taskContext = {
        taskType: 'feature' as const,
        changeKind: 'create_new' as const,
        complexity: 'm' as const,
      };

      attachTaskContextMetadata(baseRecord, taskContext);

      expect(baseRecord.taskContext).toEqual(taskContext);
    });

    it('should not modify record when taskContextData is null', () => {
      const before = { ...baseRecord };
      attachTaskContextMetadata(baseRecord, null);
      expect(baseRecord).toEqual(before);
    });
  });

  describe('attachRepoContextMetadata', () => {
    it('should attach repo context when provided', () => {
      const repoContext = {
        repoId: 'test-repo',
        primaryLanguage: 'TypeScript',
        repoVisibility: 'private' as const,
        repoSize: {
          fileCount: 100,
          locCount: 10000,
        },
      };

      attachRepoContextMetadata(baseRecord, repoContext);

      expect(baseRecord.repoContext).toEqual(repoContext);
    });

    it('should not modify record when repoContextData is null', () => {
      const before = { ...baseRecord };
      attachRepoContextMetadata(baseRecord, null);
      expect(baseRecord).toEqual(before);
    });
  });

  describe('attachWorkflowCostMetadata', () => {
    it('should attach workflow cost on success', () => {
      const costOutcome = {
        status: 'success' as const,
        totalCostUsd: 0.1234,
        models: {
          'claude-sonnet-4-5': {
            inputTokens: 1000,
            cacheCreationTokens: 500,
            cacheReadTokens: 2000,
            outputTokens: 500,
            costUsd: 0.1234,
          },
        },
        sessionCount: 2,
        turnCount: 10,
      };

      attachWorkflowCostMetadata(baseRecord, costOutcome);

      expect(baseRecord.workflowCost).toBe(0.1234);
      expect(baseRecord.workflowTokenUsage).toEqual(costOutcome.models);
      expect(baseRecord.workflowCostStatus).toBe('success');
    });

    it('should attach diagnostics on failure', () => {
      const costOutcome = {
        status: 'no_sessions' as const,
        reason: 'No session files found',
        diagnostics: {
          worktreePath: '/path/to/worktree',
          branchName: 'feature-branch',
          agentType: 'claude',
          sessionFilesFound: 0,
        },
      };

      attachWorkflowCostMetadata(baseRecord, costOutcome);

      expect(baseRecord.workflowCostStatus).toBe('no_sessions');
      expect(baseRecord.workflowCostDiagnostics).toEqual({
        reason: 'No session files found',
        worktreePath: '/path/to/worktree',
        branchName: 'feature-branch',
        agentType: 'claude',
        sessionFilesFound: 0,
      });
      expect(baseRecord.workflowCost).toBeUndefined();
    });

    it('should not modify record when costOutcome is null', () => {
      const before = { ...baseRecord };
      attachWorkflowCostMetadata(baseRecord, null);
      expect(baseRecord).toEqual(before);
    });
  });

  describe('attachPromptSizeDiagnostics', () => {
    it('attaches prompt-size diagnostics defensively', () => {
      const componentBytes = { pr_review_output: 1200 };
      const truncationSummary = { pr_review_output: 400 };

      attachPromptSizeDiagnostics(baseRecord, {
        prompt_bytes: 2048,
        prompt_component_bytes: componentBytes,
        prompt_truncated: true,
        prompt_truncation_summary: truncationSummary,
        prompt_size_limit_bytes: 4096,
        prompt_soft_limit_bytes: 3072,
      });

      expect(baseRecord.prompt_bytes).toBe(2048);
      expect(baseRecord.prompt_component_bytes).toEqual(componentBytes);
      expect(baseRecord.prompt_truncated).toBe(true);
      expect(baseRecord.prompt_truncation_summary).toEqual(truncationSummary);
      expect(baseRecord.prompt_size_limit_bytes).toBe(4096);
      expect(baseRecord.prompt_soft_limit_bytes).toBe(3072);

      componentBytes.pr_review_output = 1;
      truncationSummary.pr_review_output = 1;
      expect(baseRecord.prompt_component_bytes?.pr_review_output).toBe(1200);
      expect(baseRecord.prompt_truncation_summary?.pr_review_output).toBe(400);
    });

    it('no-ops when record or diagnostics are absent', () => {
      const before = { ...baseRecord };
      attachPromptSizeDiagnostics(baseRecord, undefined);
      attachPromptSizeDiagnostics(null, {
        prompt_bytes: 1,
      });
      expect(baseRecord).toEqual(before);
    });
  });

  describe('enrichTrainingMetadata', () => {
    it('attaches training metadata without warnings when all expected fields are present', () => {
      const warn = mock.method(console, 'warn', () => undefined);
      const routingDecision = {
        candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
        chosen: 0,
      };
      const descriptor = {
        schema_version: '1.0',
        signals: {
          heuristic: {
            task_type: 'feature',
            languages: ['typescript'],
            framework_tags: ['react'],
            files_touched: 2,
            repo_size_loc: 5000,
            description_tokens: 40,
            is_greenfield: false,
            has_migration: false,
            has_ui: false,
            has_tests: true,
            cross_service: false,
          },
          learned: {
            complexity: 0.4,
            domain: 'backend',
            risk_flags: [],
          },
        },
      };

      baseRecord.modelId = 'gpt-5.4';
      baseRecord.modelVersion = 'gpt-5.4';
      baseRecord.routingDecision = routingDecision as EvalRecord['routingDecision'];
      baseRecord.outcomes = {
        success: true,
        review: { humanReviewRequired: false, rounds: 0, approvals: 1, changeRequests: 0 },
        rework: { agentIterations: 1 },
        delivery: { prCreated: true, merged: false },
      };

      enrichTrainingMetadata(baseRecord, {
        agentType: 'codex',
        workflowCost: {
          status: 'success',
          totalCostUsd: 1.25,
          models: {
            'gpt-5.4': {
              inputTokens: 10,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 5,
              costUsd: 1.25,
            },
          },
          sessionCount: 1,
          turnCount: 2,
          pricingUsed: {},
        },
        taskDescriptor: descriptor as EvalRecord['taskDescriptor'],
        constraints: { maxCostUsd: 5 },
        difficulty: {
          difficultyBand: 'medium',
          difficultySignals: { locTouched: 10, filesTouched: 2 },
          stratum: 'ts_express_med',
        },
        taskContext: {
          taskType: 'feature',
          changeKind: 'modify_existing',
          complexity: 'm',
        },
        repoContext: {
          repoId: 'repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          languages: { TypeScript: 100 },
          frameworks: ['React'],
          repoSize: { fileCount: 10, loc: 5000, dependencyCount: 4 },
        },
        routeProvenance: {
          activeRoute: {
            coder: 'codex',
            codeDepth: 'deep',
            reviewer: 'codex',
            reviewMode: 'full',
            source: 'expanded',
            routingMode: 'stage-aware',
            routerMode: 'normal',
          },
          routeChanged: false,
          decisionSource: 'bootstrap',
          routingMode: 'stage-aware',
          routerMode: 'normal',
        },
      });

      expect(baseRecord.workflowCost).toBe(1.25);
      expect(baseRecord.trainingEligible).toBe(true);
      expect(baseRecord.routingDecision).toEqual({
        candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
        chosen: 0,
        decisionPolicyVersion: 'stage-aware',
        routeArtifactSchemaVersion: '1.0',
        policyResolverVersion: '1.0.0',
        routeMode: 'stage-aware',
        operatingModeDependency: 'normal',
      });
      expect(baseRecord.enrichmentDiagnostics).toBeUndefined();
      expect(warn.mock.calls.length).toBe(0);
    });

    it('warns when workflow cost remains missing after enrichment', () => {
      const warn = mock.method(console, 'warn', () => undefined);

      enrichTrainingMetadata(baseRecord, {
        workflowCost: {
          status: 'skipped',
          reason: 'Required parameters missing: worktreePath',
          diagnostics: {
            branchName: 'task/example',
            agentType: 'codex',
          },
        },
        taskDescriptor: {
          schema_version: '1.0',
          signals: {
            heuristic: {
              task_type: 'feature',
              languages: ['typescript'],
              framework_tags: [],
              files_touched: 1,
              repo_size_loc: 100,
              description_tokens: 4,
              is_greenfield: false,
              has_migration: false,
              has_ui: false,
              has_tests: false,
              cross_service: false,
            },
          },
        } as EvalRecord['taskDescriptor'],
        constraints: { maxCostUsd: 2 },
        routeProvenance: {
          activeRoute: {
            coder: 'codex',
            codeDepth: 'deep',
            reviewer: 'codex',
            reviewMode: 'full',
          },
        },
      });

      expect(baseRecord.workflowCostStatus).toBe('skipped');
      expect(baseRecord.enrichmentDiagnostics).toContain('workflowCost');
      expect(warn.mock.calls.length).toBe(1);
      expect(String(warn.mock.calls[0].arguments[0])).toContain('workflowCost');
    });

    it('warns when task descriptor is missing and does not crash on null inputs', () => {
      const warn = mock.method(console, 'warn', () => undefined);

      expect(() =>
        enrichTrainingMetadata(baseRecord, {
          workflowCost: null,
          taskDescriptor: null,
          constraints: null,
          difficulty: null,
          taskContext: null,
          repoContext: null,
          routeProvenance: null,
        })
      ).not.toThrow();

      expect(baseRecord.taskDescriptor).toBeUndefined();
      expect(baseRecord.enrichmentDiagnostics).toContain('taskDescriptor');
      expect(warn.mock.calls.length).toBe(1);
      expect(String(warn.mock.calls[0].arguments[0])).toContain('taskDescriptor');
    });
  });

  describe('eligibility', () => {
    function makeEligibleRecord(): EvalRecord {
      return {
        ...baseRecord,
        modelId: 'gpt-5.4',
        routingDecision: {
          candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
          chosen: 0,
        },
        taskDescriptor: {
          schema_version: '1.0',
          signals: {
            heuristic: {
              task_type: 'feature',
              languages: ['typescript'],
              framework_tags: ['react'],
              files_touched: 2,
              repo_size_loc: 10_000,
              description_tokens: 50,
              is_greenfield: false,
              has_migration: false,
              has_ui: true,
              has_tests: true,
              cross_service: false,
            },
            learned: {
              complexity: 3,
              domain: 'frontend',
              risk_flags: [],
            },
          },
          constraints: {
            max_cost_usd: 5,
            models_available: ['gpt-5.4'],
            objective: 'balanced',
          },
          stages: {
            planner: { model: 'gpt-5.4' },
          },
        },
        workflowCost: 1.25,
        outcomes: {
          success: true,
          review: {
            humanReviewRequired: false,
            rounds: 0,
            approvals: 1,
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
        constraints: {
          maxCostUsd: 5,
        },
      } as EvalRecord;
    }

    it('computes eligible flags for a complete record', () => {
      expect(computeEligibility(makeEligibleRecord())).toEqual({
        trainingEligible: true,
        budgetEvalEligible: true,
        eligibilityErrors: [],
      });
    });

    it('marks missing routing as a shared ineligibility reason', () => {
      const result = computeEligibility({
        ...makeEligibleRecord(),
        routingDecision: undefined,
      });

      expect(result.trainingEligible).toBe(false);
      expect(result.budgetEvalEligible).toBe(false);
      expect(result.eligibilityErrors).toContain('missing_routing');
    });

    it('marks missing workflowCost as budget eval ineligible', () => {
      const result = computeEligibility({
        ...makeEligibleRecord(),
        workflowCost: undefined,
      });

      expect(result.trainingEligible).toBe(true);
      expect(result.budgetEvalEligible).toBe(false);
      expect(result.eligibilityErrors).toContain('missing_cost');
    });

    it('sorts and deduplicates eligibility errors', () => {
      const record = {
        ...baseRecord,
        modelId: '',
      } as EvalRecord;

      expect(computeEligibility(record).eligibilityErrors).toEqual([
        'missing_budget',
        'missing_budget_snapshot',
        'missing_cost',
        'missing_model_identity',
        'missing_outcome',
        'missing_routing',
        'missing_task_descriptor',
      ]);
    });

    it('is a no-op for null records', () => {
      expect(() => attachEligibility(null)).not.toThrow();
    });

    it('is idempotent when attaching computed eligibility', () => {
      const record = makeEligibleRecord();

      attachEligibility(record);
      const once = {
        trainingEligible: record.trainingEligible,
        budgetEvalEligible: record.budgetEvalEligible,
        eligibilityErrors: record.eligibilityErrors,
      };

      attachEligibility(record);

      expect({
        trainingEligible: record.trainingEligible,
        budgetEvalEligible: record.budgetEvalEligible,
        eligibilityErrors: record.eligibilityErrors,
      }).toEqual(once);
    });
  });

  describe('attachConstraints', () => {
    it('should attach maxCostUsd when provided', () => {
      attachConstraints(baseRecord, { maxCostUsd: 7.5 });
      expect(baseRecord.constraints).toEqual({ maxCostUsd: 7.5 });
    });

    it('should not attach empty constraints', () => {
      attachConstraints(baseRecord, {});
      expect(baseRecord.constraints).toBeUndefined();
    });

    it('enrichEvalRecord attaches maxCostUsd from metadata constraints', () => {
      enrichEvalRecord(baseRecord, {
        constraints: { maxCostUsd: 10 },
        provider: 'deepseek',
        endpoint: 'https://api.deepseek.com/anthropic',
      });
      expect(baseRecord.constraints).toEqual({ maxCostUsd: 10 });
      expect(baseRecord.provider).toBe('deepseek');
      expect(baseRecord.endpoint).toBe('https://api.deepseek.com/anthropic');
    });

    it('attaches budget metadata to eval and descriptor constraints', () => {
      baseRecord.taskDescriptor = {
        schema_version: '1.0',
        signals: {
          heuristic: {
            task_type: 'feature',
            languages: ['typescript'],
            framework_tags: [],
            files_touched: 1,
            repo_size_loc: 100,
            description_tokens: 10,
            is_greenfield: false,
            has_migration: false,
            has_ui: false,
            has_tests: true,
            cross_service: false,
          },
          learned: {
            complexity: 1,
            domain: 'core',
            risk_flags: [],
          },
        },
        constraints: {
          objective: 'balanced',
        },
        stages: {},
      };

      attachBudgetMetadata(baseRecord, 0);

      expect(baseRecord.constraints).toEqual({ maxCostUsd: 0 });
      expect(baseRecord.taskDescriptor.constraints.max_cost_usd).toBe(0);
      expect(baseRecord.budgetEvalEligibilityError).toBe(undefined);
    });

    it('marks missing budget without writing constraints', () => {
      baseRecord.constraints = { maxCostUsd: 4 };
      baseRecord.taskDescriptor = {
        schema_version: '1.0',
        signals: {
          heuristic: {
            task_type: 'feature',
            languages: ['typescript'],
            framework_tags: [],
            files_touched: 1,
            repo_size_loc: 100,
            description_tokens: 10,
            is_greenfield: false,
            has_migration: false,
            has_ui: false,
            has_tests: true,
            cross_service: false,
          },
          learned: {
            complexity: 1,
            domain: 'core',
            risk_flags: [],
          },
        },
        constraints: {
          max_cost_usd: 4,
          objective: 'balanced',
        },
        stages: {},
      };

      attachBudgetMetadata(baseRecord, null);

      expect(baseRecord.constraints).toBe(undefined);
      expect(baseRecord.taskDescriptor.constraints.max_cost_usd).toBe(undefined);
      expect(baseRecord.budgetEvalEligible).toBe(false);
      expect(baseRecord.budgetEvalEligibilityError).toBe('missing_budget');
      expect(baseRecord.eligibilityErrors).toContain('missing_budget');
    });
  });

  describe('attachFallbackEvent', () => {
    it('should attach fallback telemetry when provided', () => {
      const fallbackEvent = {
        schema_version: '1.0' as const,
        preferred_model: 'model-a',
        fallback_model: 'model-b',
        task_type: 'coding' as const,
        difficulty: 'hard' as const,
        quota_snapshot: {
          snapshotAt: '2026-04-18T12:00:00Z',
          models: {
            'model-a': {
              status: 'exhausted' as const,
              resetAt: null,
              remainingEstimate: null,
              confidence: 0.9,
            },
          },
        },
        human_intervention: false,
        outcome: 'success' as const,
        latency_ms: 1234,
        cost_usd: 0.42,
        fallback_chain: [{ model: 'model-a', reason: 'quota' }],
      };

      attachFallbackEvent(baseRecord, fallbackEvent);
      expect(baseRecord.fallbackEvent).toEqual(fallbackEvent);
    });

    it('should not modify record when fallback event is null', () => {
      const before = { ...baseRecord };
      attachFallbackEvent(baseRecord, null);
      expect(baseRecord).toEqual(before);
    });
  });

  describe('enrichEvalRecord', () => {
    it('attaches planCritique to the normalized plan stage outcome', () => {
      baseRecord.metadata = {
        stageScores: {
          plan: {
            score: 0.81,
            rationale: 'The plan covered the right implementation areas.',
          },
        },
        planCritique: {
          component_boundaries: {
            score: 0.9,
            rationale: 'The plan identified the correct component boundary.',
          },
          invariant_coverage: {
            score: 0.7,
            rationale: 'It captured the main compatibility invariant.',
          },
          approach_soundness: {
            score: 0.8,
            rationale: 'The proposed approach was viable.',
          },
          missed_patches: {
            score: 0.78,
            rationale: 'Implementation needed only minor follow-up fixes.',
          },
          overall: {
            score: 0.8,
            rationale: 'Overall the plan was a useful guide.',
          },
        },
      };

      enrichEvalRecord(baseRecord, {});

      expect(baseRecord.stageOutcomes?.plan).toEqual({
        score: 0.81,
        rationale: 'The plan covered the right implementation areas.',
        planCritique: baseRecord.metadata.planCritique,
      });
    });

    it('should attach all metadata when provided', () => {
      const metadata = {
        agentType: 'codex',
        difficulty: {
          difficultyBand: 'medium' as const,
          difficultySignals: {
            locTouched: 150,
            filesTouched: 5,
            diffUncertain: false,
          },
          stratum: 'stratum-2' as const,
        },
        taskContext: {
          taskType: 'feature' as const,
          changeKind: 'create_new' as const,
          complexity: 'm' as const,
        },
        repoContext: {
          repoId: 'test-repo',
          primaryLanguage: 'TypeScript',
          repoVisibility: 'private' as const,
        },
        workflowCost: {
          status: 'success' as const,
          totalCostUsd: 0.1234,
          models: {},
          sessionCount: 1,
          turnCount: 5,
        },
        fallbackEvent: {
          schema_version: '1.0' as const,
          preferred_model: 'model-a',
          fallback_model: 'model-b',
          task_type: 'coding' as const,
          difficulty: 'medium' as const,
          quota_snapshot: {
            snapshotAt: '2026-04-18T12:00:00Z',
            models: {},
          },
          human_intervention: false,
          outcome: 'success' as const,
          latency_ms: 900,
          cost_usd: 0.1234,
          fallback_chain: [{ model: 'model-a', reason: 'quota' }],
        },
        constraints: {
          maxCostUsd: 5,
        },
      };

      enrichEvalRecord(baseRecord, metadata);

      expect(baseRecord.agentType).toBe('codex');
      expect(baseRecord.difficultyBand).toBe('medium');
      expect(baseRecord.taskContext).toEqual(metadata.taskContext);
      expect(baseRecord.repoContext).toEqual(metadata.repoContext);
      expect(baseRecord.workflowCost).toBe(0.1234);
      expect(baseRecord.workflowCostStatus).toBe('success');
      expect(baseRecord.fallbackEvent).toEqual(metadata.fallbackEvent);
      expect(baseRecord.constraints).toEqual({ maxCostUsd: 5 });
    });

    it('should handle partial metadata gracefully', () => {
      const metadata = {
        agentType: 'claude',
        difficulty: null,
        taskContext: null,
        repoContext: null,
        workflowCost: null,
      };

      enrichEvalRecord(baseRecord, metadata);

      expect(baseRecord.agentType).toBe('claude');
      expect(baseRecord.difficultyBand).toBeUndefined();
      expect(baseRecord.taskContext).toBeUndefined();
      expect(baseRecord.repoContext).toBeUndefined();
      expect(baseRecord.workflowCost).toBeUndefined();
    });

    it('should handle empty metadata object', () => {
      const before = { ...baseRecord };
      enrichEvalRecord(baseRecord, {});

      // Only agentType gets set (defaults to 'claude')
      expect(baseRecord.agentType).toBe('claude');
      // Everything else unchanged
      expect(baseRecord.difficultyBand).toBeUndefined();
      expect(baseRecord.taskContext).toBeUndefined();
    });
  });

  describe('attachStageOutcomes rubricCriteria', () => {
    it('propagates rubricCriteria to stageOutcomes', () => {
      attachStageOutcomes(baseRecord, {
        expansion: {
          score: 0.88,
          rationale: 'Expansion was strong.',
          rubricCriteria: [
            {
              criterion: 'requirement_coverage',
              score: 0.9,
              notes: 'Requirements were covered.',
            },
          ],
        },
      });

      expect(baseRecord.stageOutcomes?.expansion?.rubricCriteria).toEqual([
        {
          criterion: 'requirement_coverage',
          score: 0.9,
          notes: 'Requirements were covered.',
        },
      ]);
    });

    it('treats undefined, null, and empty rubricCriteria as no-op', () => {
      attachStageOutcomes(baseRecord, {
        expansion: {
          score: 0.8,
          rationale: 'Undefined criteria.',
          rubricCriteria: undefined,
        },
        plan: {
          score: 0.79,
          rationale: 'Null criteria.',
          rubricCriteria: null,
        },
        implementation: {
          score: 0.82,
          rationale: 'Empty criteria.',
          rubricCriteria: [],
        },
      });

      expect(baseRecord.stageOutcomes?.expansion).not.toHaveProperty('rubricCriteria');
      expect(baseRecord.stageOutcomes?.plan).not.toHaveProperty('rubricCriteria');
      expect(baseRecord.stageOutcomes?.implementation).not.toHaveProperty('rubricCriteria');
    });

    it('enrichEvalRecord propagates rubricCriteria from metadata stageScores', () => {
      baseRecord.metadata = {
        stageScores: {
          review: {
            score: 0.84,
            rationale: 'Review checked the important risks.',
            rubricCriteria: [
              {
                criterion: 'issue_detection',
                score: 0.86,
                notes: 'Review found the relevant issue class.',
              },
            ],
          },
        },
      };

      enrichEvalRecord(baseRecord, {});

      expect(baseRecord.stageOutcomes?.review?.rubricCriteria).toEqual([
        {
          criterion: 'issue_detection',
          score: 0.86,
          notes: 'Review found the relevant issue class.',
        },
      ]);
    });
  });

  describe('attachRubricEval (HOK-1406)', () => {
    const validRubricEval: RubricEval = {
      schema_version: '1.0',
      rubric_version: '1.0',
      criteria: {
        completeness: { score: 0.9, rationale: 'All requirements met.' },
        correctness: { score: 0.95, rationale: 'No bugs found.' },
        code_quality: { score: 0.85, rationale: 'Clean code.' },
        intervention_impact: { score: 0.7, rationale: 'One fix needed.' },
        autonomy: { score: 0.75, rationale: 'Mostly autonomous.' },
      },
      determinative_boundary: 'functional_bug',
    };

    it('is a no-op when rubricEval is undefined', () => {
      const before = { ...baseRecord };
      attachRubricEval(baseRecord, undefined);
      expect(baseRecord.rubricEval).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('sets record.rubricEval when provided', () => {
      attachRubricEval(baseRecord, validRubricEval);
      expect(baseRecord.rubricEval).toEqual(validRubricEval);
      expect(baseRecord.rubric_provenance).toBe('judge');
    });

    it('enrichEvalRecord leaves rubricEval undefined when not in metadata', () => {
      enrichEvalRecord(baseRecord, {});
      expect(baseRecord.rubricEval).toBeUndefined();
    });

    it('enrichEvalRecord attaches rubricEval when passed in metadata', () => {
      enrichEvalRecord(baseRecord, { rubricEval: validRubricEval });
      expect(baseRecord.rubricEval).toEqual(validRubricEval);
      expect(baseRecord.rubric_provenance).toBe('judge');
    });
  });

  describe('attachNonRewardReason', () => {
    it('is a no-op when reason is undefined or null', () => {
      attachNonRewardReason(baseRecord, undefined);
      expect(baseRecord.nonRewardReason).toBeUndefined();

      attachNonRewardReason(baseRecord, null);
      expect(baseRecord.nonRewardReason).toBeUndefined();
    });

    it('sets the nonRewardReason field when provided', () => {
      attachNonRewardReason(baseRecord, {
        code: 'INELIGIBLE_REWARD_NO_JUDGE',
        message: 'Reward not paid: record has no judge evaluation result.',
      });

      expect(baseRecord.nonRewardReason).toEqual({
        code: 'INELIGIBLE_REWARD_NO_JUDGE',
        message: 'Reward not paid: record has no judge evaluation result.',
      });
    });
  });

  describe('attachChallengeRouteContext (HOK-1515)', () => {
    const routeContext = {
      decisionSource: 'expanded' as const,
      bootstrapRoute: {
        coder: 'claude-sonnet-4-6',
        codeDepth: 'medium',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'llm',
        planner: 'gpt-5.4',
      },
      expandedRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'static',
      },
      refreshRationale: 'coder class changed',
    };

    it('is a no-op when context is undefined', () => {
      const before = { ...baseRecord };
      attachChallengeRouteContext(baseRecord, undefined);
      expect(baseRecord.challengeRouteContext).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('is a no-op when context is null', () => {
      const before = { ...baseRecord };
      attachChallengeRouteContext(baseRecord, null);
      expect(baseRecord.challengeRouteContext).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('attaches normalized challenge route context when provided', () => {
      attachChallengeRouteContext(baseRecord, routeContext);
      expect(baseRecord.challengeRouteContext).toEqual({
        decisionSource: 'expanded',
        bootstrapRoute: {
          coder: 'claude-sonnet-4-6',
          codeDepth: 'medium',
          reviewer: 'claude-opus-4-6',
          reviewMode: 'llm',
        },
        expandedRoute: {
          coder: 'gpt-5.4',
          codeDepth: 'deep',
          reviewer: 'claude-opus-4-6',
          reviewMode: 'static',
        },
        refreshRationale: 'coder class changed',
      });
    });

    it('attaches partial context when only bootstrap route is available', () => {
      attachChallengeRouteContext(baseRecord, {
        decisionSource: 'bootstrap',
        bootstrapRoute: routeContext.bootstrapRoute,
      });
      expect(baseRecord.challengeRouteContext).toEqual({
        decisionSource: 'bootstrap',
        bootstrapRoute: {
          coder: 'claude-sonnet-4-6',
          codeDepth: 'medium',
          reviewer: 'claude-opus-4-6',
          reviewMode: 'llm',
        },
      });
    });
  });

  describe('attachRouteProvenance (HOK-1517)', () => {
    const routeProvenance = {
      decisionSource: 'expanded' as const,
      bootstrapRoute: {
        coder: 'claude-sonnet-4-6',
        codeDepth: 'medium',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'llm',
      },
      expandedRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-sonnet-4-6',
        reviewMode: 'static',
        source: 'expanded' as const,
        routerMode: 'survival' as const,
        routingMode: 'stage-aware',
      },
      activeRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-sonnet-4-6',
        reviewMode: 'static',
        source: 'expanded' as const,
        routerMode: 'survival' as const,
        routingMode: 'stage-aware',
      },
      routeChanged: true,
      expandedCacheHit: true,
      packetHash: 'a'.repeat(64),
      routeSource: 'cache' as const,
      routerMode: 'survival' as const,
      routingMode: 'stage-aware',
    };

    it('is a no-op when provenance is undefined', () => {
      const before = { ...baseRecord };
      attachRouteProvenance(baseRecord, undefined);
      expect(baseRecord.routeProvenance).toBeUndefined();
      expect(baseRecord).toEqual(before);
    });

    it('attaches route provenance when provided', () => {
      attachRouteProvenance(baseRecord, routeProvenance);
      expect(baseRecord.routeProvenance).toEqual(routeProvenance);
    });

    it('attaches route provenance through enrichEvalRecord', () => {
      enrichEvalRecord(baseRecord, { routeProvenance });
      expect(baseRecord.routeProvenance).toEqual(routeProvenance);
    });

    it('derives routingDecision policy metadata from route provenance', () => {
      baseRecord.routingDecision = {
        candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
        chosen: 0,
        decisionPolicyVersion: 'baseline',
      };

      attachRouterPolicyMetadata(baseRecord, routeProvenance);

      expect(baseRecord.routingDecision).toEqual({
        candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
        chosen: 0,
        decisionPolicyVersion: 'stage-aware',
        routeArtifactSchemaVersion: '1.0',
        policyResolverVersion: '1.0.0',
        routeMode: 'stage-aware',
        operatingModeDependency: 'survival',
      });
    });
  });

  describe('route prediction and calibration', () => {
    it('attaches route prediction and calibration helpers', () => {
      attachRoutePrediction(baseRecord, {
        expectedSuccess: 0.8,
        expectedCostUsd: 4.25,
        confidence: 0.7,
        riskScore: 1.5,
        taskType: 'feature',
        taskDifficulty: 'medium',
        topFeatures: ['risk', 'cost'],
        rationaleSummary: 'balanced route',
      });

      const calibration = computeRouteCalibration({
        workflowCost: 3.5,
        outcomes: { success: true },
        timeSeconds: 12,
        interventionCount: 1,
      } as EvalRecord, baseRecord.routePrediction);
      attachRouteCalibration(baseRecord, calibration);

      expect(baseRecord.routePrediction).toEqual({
        expectedSuccess: 0.8,
        expectedCostUsd: 4.25,
        confidence: 0.7,
        riskScore: 1.5,
        taskType: 'feature',
        taskDifficulty: 'medium',
        topFeatures: ['risk', 'cost'],
        rationaleSummary: 'balanced route',
      });
      expect(baseRecord.routeCalibration).toEqual({
        predictedSuccess: 0.8,
        actualSuccess: true,
        predictedCostUsd: 4.25,
        actualCostUsd: 3.5,
        interventionCount: 1,
        durationMs: 12000,
        successDelta: 0.2,
        costErrorUsd: 0.75,
      });
    });

    it('leaves existing prediction unchanged on empty helper input', () => {
      baseRecord.routePrediction = { expectedSuccess: 0.5 };
      attachRoutePrediction(baseRecord, undefined);
      expect(baseRecord.routePrediction).toEqual({ expectedSuccess: 0.5 });
    });
  });
});
