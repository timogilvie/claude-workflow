import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectForExport, redactVerificationTelemetry } from '../shared/lib/verification-telemetry-export.ts';
import type { EvalRecord, TaskDescriptor } from '../shared/lib/eval-schema.ts';

function baseTaskDescriptor(): TaskDescriptor {
  return {
    schema_version: '1.0',
    signals: {
      heuristic: {
        task_type: 'feature',
        languages: ['typescript'],
        framework_tags: [],
        files_touched: 3,
        repo_size_loc: 5000,
        description_tokens: 120,
        is_greenfield: false,
        has_migration: false,
        has_ui: false,
        has_tests: true,
        cross_service: false,
      },
      learned: {
        complexity: 2,
        domain: 'backend',
        risk_flags: [],
      },
    },
    constraints: {
      models_available: ['claude-sonnet-4-5-20250929'],
      objective: 'balanced',
    },
    stages: {
      planner: { model: 'claude-sonnet-4-5-20250929' },
      coder: { model: 'claude-sonnet-4-5-20250929' },
    },
  };
}

describe('Verification Telemetry Export and Redaction', () => {
  describe('redactVerificationTelemetry', () => {
    it('should preserve contract metadata', () => {
      const telemetry = {
        contractSource: 'github-enforced',
        contractVersion: '1.0.0',
      };

      const redacted = redactVerificationTelemetry(telemetry);

      assert.equal(redacted.contractSource, 'github-enforced');
      assert.equal(redacted.contractVersion, '1.0.0');
    });

    it('should preserve SHAs', () => {
      const telemetry = {
        verifiedHeadSha: 'a'.repeat(40),
        verifiedBaseSha: 'b'.repeat(40),
      };

      const redacted = redactVerificationTelemetry(telemetry);

      assert.equal(redacted.verifiedHeadSha, 'a'.repeat(40));
      assert.equal(redacted.verifiedBaseSha, 'b'.repeat(40));
    });

    it('should preserve timestamps', () => {
      const telemetry = {
        startedAt: '2024-01-01T12:00:00Z',
        completedAt: '2024-01-01T12:05:00Z',
      };

      const redacted = redactVerificationTelemetry(telemetry);

      assert.equal(redacted.startedAt, '2024-01-01T12:00:00Z');
      assert.equal(redacted.completedAt, '2024-01-01T12:05:00Z');
    });

    it('should redact command names but preserve durations', () => {
      const telemetry = {
        commands: [
          {
            index: 1,
            commandName: 'npm run test',
            status: 'pass' as const,
            durationMs: 2000,
          },
        ],
      };

      const redacted = redactVerificationTelemetry(telemetry);

      assert.equal(redacted.commands?.[0]?.commandName, '[redacted]');
      assert.equal(redacted.commands?.[0]?.durationMs, 2000);
      assert.equal(redacted.commands?.[0]?.failureReason, undefined);
    });

    it('should preserve summary stats but redact override flag', () => {
      const telemetry = {
        summary: {
          totalCommands: 3,
          passedCommands: 2,
          failedCommands: 1,
          timeoutCommands: 0,
          overallStatus: 'fail' as const,
          totalTimeSeconds: 10,
          wasOverridden: true,
        },
      };

      const redacted = redactVerificationTelemetry(telemetry);

      assert.equal(redacted.summary?.totalCommands, 3);
      assert.equal(redacted.summary?.passedCommands, 2);
      assert.equal(redacted.summary?.failedCommands, 1);
      assert.equal(redacted.summary?.overallStatus, 'fail');
      assert.equal(redacted.summary?.wasOverridden, undefined);
    });

    it('should preserve CI verdict status and timing but redact run IDs', () => {
      const telemetry = {
        firstCiVerdict: {
          status: 'pass' as const,
          timeToVerdictSeconds: 600,
          workflowRunId: 'run_12345',
          ciLogsUrl: 'https://github.com/logs',
        },
      };

      const redacted = redactVerificationTelemetry(telemetry);

      assert.equal(redacted.firstCiVerdict?.status, 'pass');
      assert.equal(redacted.firstCiVerdict?.timeToVerdictSeconds, 600);
      assert.equal(redacted.firstCiVerdict?.workflowRunId, undefined);
      assert.equal(redacted.firstCiVerdict?.ciLogsUrl, undefined);
    });

    it('should preserve failure category and fingerprint', () => {
      const telemetry = {
        failedCheckFingerprint: 'abc123def456',
        failureCategory: 'lint_error',
        remoteOnlyFailure: false,
      };

      const redacted = redactVerificationTelemetry(telemetry);

      assert.equal(redacted.failedCheckFingerprint, 'abc123def456');
      assert.equal(redacted.failureCategory, 'lint_error');
      assert.equal(redacted.remoteOnlyFailure, false);
    });

    it('should preserve remediation attempts but redact descriptions', () => {
      const telemetry = {
        remediation: [
          {
            attemptNumber: 1,
            description: 'Fixed lint errors',
            outcome: 'still_failing' as const,
            delaySeconds: 60,
            durationSeconds: 300,
          },
        ],
      };

      const redacted = redactVerificationTelemetry(telemetry);

      assert.equal(redacted.remediation?.[0]?.attemptNumber, 1);
      assert.equal(redacted.remediation?.[0]?.description, '[redacted]');
      assert.equal(redacted.remediation?.[0]?.outcome, 'still_failing');
      assert.equal(redacted.remediation?.[0]?.delaySeconds, 60);
      assert.equal(redacted.remediation?.[0]?.durationSeconds, 300);
    });

    it('should completely redact operator override', () => {
      const telemetry = {
        operatorOverride: {
          reason: 'Force skip verification',
          operator: 'alice@example.com',
          timestamp: '2024-01-01T12:00:00Z',
        },
      };

      const redacted = redactVerificationTelemetry(telemetry);

      assert.equal(redacted.operatorOverride, undefined);
    });
  });

  describe('projectForExport', () => {
    it('should include redacted telemetry in projection', () => {
      const record: EvalRecord = {
        id: 'test-1',
        schemaVersion: '1.37.0',
        originalPrompt: 'Test',
        modelId: 'claude-sonnet-4-5-20250929',
        modelVersion: '2024',
        score: 0.8,
        scoreBand: 'Full Success',
        timeSeconds: 100,
        timestamp: new Date().toISOString(),
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'Good',
        taskDescriptor: baseTaskDescriptor(),
        verificationTelemetry: {
          contractSource: 'github-enforced',
          contractVersion: '1.0.0',
          summary: {
            totalCommands: 2,
            passedCommands: 2,
            failedCommands: 0,
            timeoutCommands: 0,
            overallStatus: 'pass',
            totalTimeSeconds: 5,
            wasOverridden: false,
          },
          commands: [
            {
              index: 1,
              commandName: 'npm run test',
              status: 'pass',
              durationMs: 2000,
            },
          ],
        },
      };

      const projected = projectForExport(record);

      assert.ok(projected.verificationTelemetry);
      assert.equal(projected.verificationTelemetry?.contractSource, 'github-enforced');
      assert.ok((projected.verificationTelemetry as any)?.summary);
      assert.equal((projected.verificationTelemetry as any)?.summary?.totalCommands, 2);
      assert.equal((projected.verificationTelemetry as any)?.commands?.[0]?.commandName, '[redacted]');
      assert.equal((projected.verificationTelemetry as any)?.summary?.wasOverridden, undefined);
    });

    it('should handle records without verificationTelemetry', () => {
      const record: EvalRecord = {
        id: 'test-2',
        schemaVersion: '1.35.0',
        originalPrompt: 'Test',
        modelId: 'claude-sonnet-4-5-20250929',
        modelVersion: '2024',
        score: 0.7,
        scoreBand: 'Assisted Success',
        timeSeconds: 100,
        timestamp: new Date().toISOString(),
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'OK',
        taskDescriptor: baseTaskDescriptor(),
      };

      const projected = projectForExport(record);

      assert.equal(projected.verificationTelemetry, undefined);
      assert.equal(projected.id, 'test-2');
      assert.equal(projected.score, 0.7);
    });

    it('should include all core record fields', () => {
      const record: EvalRecord = {
        id: 'test-3',
        schemaVersion: '1.37.0',
        originalPrompt: 'Test prompt',
        modelId: 'claude-sonnet-4-5-20250929',
        modelVersion: '2024-08-06',
        score: 0.9,
        scoreBand: 'Minor Feedback',
        timeSeconds: 150,
        timestamp: '2024-01-01T12:00:00Z',
        interventionRequired: true,
        interventionCount: 1,
        interventionDetails: ['Fixed typo'],
        rationale: 'Almost perfect',
        issueId: 'HOK-123',
        prUrl: 'https://github.com/pr/456',
        taskDescriptor: baseTaskDescriptor(),
      };

      const projected = projectForExport(record);

      assert.equal(projected.id, 'test-3');
      assert.equal(projected.schemaVersion, '1.37.0');
      assert.equal(projected.originalPrompt, 'Test prompt');
      assert.equal(projected.modelId, 'claude-sonnet-4-5-20250929');
      assert.equal(projected.score, 0.9);
      assert.equal(projected.scoreBand, 'Minor Feedback');
      assert.equal(projected.issueId, 'HOK-123');
      assert.equal(projected.prUrl, 'https://github.com/pr/456');
    });
  });
});
