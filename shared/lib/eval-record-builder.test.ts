/**
 * Tests for eval-record-builder module.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { EvalRecord } from './eval-schema.ts';
import {
  attachAgentType,
  attachConstraints,
  attachDifficultyMetadata,
  attachFallbackEvent,
  attachTaskContextMetadata,
  attachRepoContextMetadata,
  attachWorkflowCostMetadata,
  enrichEvalRecord,
} from './eval-record-builder.ts';

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
});
