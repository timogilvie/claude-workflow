import { describe, it, expect } from '@jest/globals';
import { projectForExport, redactVerificationTelemetry } from '../shared/lib/verification-telemetry-export.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';

describe('Verification Telemetry Export and Redaction', () => {
  describe('redactVerificationTelemetry', () => {
    it('should preserve contract metadata', () => {
      const telemetry = {
        contractSource: 'github-enforced',
        contractVersion: '1.0.0',
      };

      const redacted = redactVerificationTelemetry(telemetry);

      expect(redacted.contractSource).toBe('github-enforced');
      expect(redacted.contractVersion).toBe('1.0.0');
    });

    it('should preserve SHAs', () => {
      const telemetry = {
        verifiedHeadSha: 'a'.repeat(40),
        verifiedBaseSha: 'b'.repeat(40),
      };

      const redacted = redactVerificationTelemetry(telemetry);

      expect(redacted.verifiedHeadSha).toBe('a'.repeat(40));
      expect(redacted.verifiedBaseSha).toBe('b'.repeat(40));
    });

    it('should preserve timestamps', () => {
      const telemetry = {
        startedAt: '2024-01-01T12:00:00Z',
        completedAt: '2024-01-01T12:05:00Z',
      };

      const redacted = redactVerificationTelemetry(telemetry);

      expect(redacted.startedAt).toBe('2024-01-01T12:00:00Z');
      expect(redacted.completedAt).toBe('2024-01-01T12:05:00Z');
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

      expect(redacted.commands?.[0]?.commandName).toBe('[redacted]');
      expect(redacted.commands?.[0]?.durationMs).toBe(2000);
      expect(redacted.commands?.[0]?.failureReason).toBeUndefined();
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

      expect(redacted.summary?.totalCommands).toBe(3);
      expect(redacted.summary?.passedCommands).toBe(2);
      expect(redacted.summary?.failedCommands).toBe(1);
      expect(redacted.summary?.overallStatus).toBe('fail');
      expect(redacted.summary?.wasOverridden).toBeUndefined();
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

      expect(redacted.firstCiVerdict?.status).toBe('pass');
      expect(redacted.firstCiVerdict?.timeToVerdictSeconds).toBe(600);
      expect(redacted.firstCiVerdict?.workflowRunId).toBeUndefined();
      expect(redacted.firstCiVerdict?.ciLogsUrl).toBeUndefined();
    });

    it('should preserve failure category and fingerprint', () => {
      const telemetry = {
        failedCheckFingerprint: 'abc123def456',
        failureCategory: 'lint_error',
        remoteOnlyFailure: false,
      };

      const redacted = redactVerificationTelemetry(telemetry);

      expect(redacted.failedCheckFingerprint).toBe('abc123def456');
      expect(redacted.failureCategory).toBe('lint_error');
      expect(redacted.remoteOnlyFailure).toBe(false);
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

      expect(redacted.remediation?.[0]?.attemptNumber).toBe(1);
      expect(redacted.remediation?.[0]?.description).toBe('[redacted]');
      expect(redacted.remediation?.[0]?.outcome).toBe('still_failing');
      expect(redacted.remediation?.[0]?.delaySeconds).toBe(60);
      expect(redacted.remediation?.[0]?.durationSeconds).toBe(300);
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

      expect(redacted.operatorOverride).toBeUndefined();
    });
  });

  describe('projectForExport', () => {
    it('should include redacted telemetry in projection', () => {
      const record: EvalRecord = {
        id: 'test-1',
        schemaVersion: '1.37.0',
        originalPrompt: 'Test',
        modelId: 'claude-opus-4',
        modelVersion: '2024',
        score: 0.8,
        scoreBand: 'Full Success',
        timeSeconds: 100,
        timestamp: new Date().toISOString(),
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'Good',
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

      expect(projected.verificationTelemetry).toBeDefined();
      expect(projected.verificationTelemetry?.contractSource).toBe('github-enforced');
      expect((projected.verificationTelemetry as any)?.summary).toBeDefined();
      expect((projected.verificationTelemetry as any)?.summary?.totalCommands).toBe(2);
      // Verify redaction happened
      expect((projected.verificationTelemetry as any)?.commands?.[0]?.commandName).toBe('[redacted]');
      expect((projected.verificationTelemetry as any)?.summary?.wasOverridden).toBeUndefined();
    });

    it('should handle records without verificationTelemetry', () => {
      const record: EvalRecord = {
        id: 'test-2',
        schemaVersion: '1.35.0',
        originalPrompt: 'Test',
        modelId: 'claude-opus-4',
        modelVersion: '2024',
        score: 0.7,
        scoreBand: 'Assisted Success',
        timeSeconds: 100,
        timestamp: new Date().toISOString(),
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'OK',
      };

      const projected = projectForExport(record);

      expect(projected.verificationTelemetry).toBeUndefined();
      expect(projected.id).toBe('test-2');
      expect(projected.score).toBe(0.7);
    });

    it('should include all core record fields', () => {
      const record: EvalRecord = {
        id: 'test-3',
        schemaVersion: '1.37.0',
        originalPrompt: 'Test prompt',
        modelId: 'claude-opus-4',
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
      };

      const projected = projectForExport(record);

      expect(projected.id).toBe('test-3');
      expect(projected.schemaVersion).toBe('1.37.0');
      expect(projected.originalPrompt).toBe('Test prompt');
      expect(projected.modelId).toBe('claude-opus-4');
      expect(projected.score).toBe(0.9);
      expect(projected.scoreBand).toBe('Minor Feedback');
      expect(projected.issueId).toBe('HOK-123');
      expect(projected.prUrl).toBe('https://github.com/pr/456');
    });
  });
});
