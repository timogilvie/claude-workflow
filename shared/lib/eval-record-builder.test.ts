/**
 * Tests for eval-record-builder module.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { EvalRecord } from './eval-schema.ts';
import {
  attachEligibility,
  attachAgentType,
  attachChallengeRouteContext,
  attachConstraints,
  attachDifficultyMetadata,
  attachFallbackEvent,
  attachRubricEval,
  attachStageOutcomes,
  attachTaskContextMetadata,
  attachRepoContextMetadata,
  attachWorkflowCostMetadata,
  computeEligibility,
  enrichEvalRecord,
} from './eval-record-builder.ts';
import type { RubricEval } from './eval-schema.ts';

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
      enrichEvalRecord(baseRecord, { constraints: { maxCostUsd: 10 } });
      expect(baseRecord.constraints).toEqual({ maxCostUsd: 10 });
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
});
