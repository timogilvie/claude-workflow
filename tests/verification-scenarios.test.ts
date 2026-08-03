import { describe, it, expect } from '@jest/globals';
import { validateEvalRecord } from '../shared/lib/eval-validator.ts';
import { projectForExport } from '../shared/lib/verification-telemetry-export.ts';
import {
  createLocalFailureFixture,
  createRemoteOnlyFailureFixture,
  createSuccessfulFirstCiFixture,
} from './eval-record-fixtures.ts';

describe('Verification Scenarios', () => {
  describe('Scenario 1: Local Failure (PR blocked)', () => {
    it('should create valid eval record', () => {
      const record = createLocalFailureFixture();
      const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
      expect(errors).toHaveLength(0);
    });

    it('should have fail status in verification summary', () => {
      const record = createLocalFailureFixture();
      expect(record.verificationTelemetry?.summary?.overallStatus).toBe('fail');
    });

    it('should not have CI verdict (PR not created)', () => {
      const record = createLocalFailureFixture();
      expect(record.verificationTelemetry?.firstCiVerdict).toBeUndefined();
    });

    it('should export with telemetry redacted', () => {
      const record = createLocalFailureFixture();
      const projected = projectForExport(record);
      expect(projected.verificationTelemetry).toBeDefined();
      expect((projected.verificationTelemetry as any)?.failureCategory).toBe('lint_error');
    });
  });

  describe('Scenario 2: Remote-Only Failure (CI catches issue)', () => {
    it('should create valid eval record', () => {
      const record = createRemoteOnlyFailureFixture();
      const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
      expect(errors).toHaveLength(0);
    });

    it('should have pass status for local verification', () => {
      const record = createRemoteOnlyFailureFixture();
      expect(record.verificationTelemetry?.summary?.overallStatus).toBe('pass');
    });

    it('should have fail status for first CI verdict', () => {
      const record = createRemoteOnlyFailureFixture();
      expect(record.verificationTelemetry?.firstCiVerdict?.status).toBe('fail');
    });

    it('should mark as remote-only failure', () => {
      const record = createRemoteOnlyFailureFixture();
      expect(record.verificationTelemetry?.remoteOnlyFailure).toBe(true);
    });

    it('should include remediation attempts', () => {
      const record = createRemoteOnlyFailureFixture();
      expect(record.verificationTelemetry?.remediation).toHaveLength(2);
      expect(record.verificationTelemetry?.remediation?.[1]?.outcome).toBe('passed');
    });
  });

  describe('Scenario 3: Successful First CI (no issues)', () => {
    it('should create valid eval record', () => {
      const record = createSuccessfulFirstCiFixture();
      const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
      expect(errors).toHaveLength(0);
    });

    it('should have pass status for both local and CI', () => {
      const record = createSuccessfulFirstCiFixture();
      expect(record.verificationTelemetry?.summary?.overallStatus).toBe('pass');
      expect(record.verificationTelemetry?.firstCiVerdict?.status).toBe('pass');
    });

    it('should not be marked as remote-only failure', () => {
      const record = createSuccessfulFirstCiFixture();
      expect(record.verificationTelemetry?.remoteOnlyFailure).toBe(false);
    });

    it('should have reasonable CI timing', () => {
      const record = createSuccessfulFirstCiFixture();
      expect(record.verificationTelemetry?.firstCiVerdict?.timeToVerdictSeconds).toBe(600);
    });
  });

  describe('Metrics Calculation', () => {
    it('should compute first-green-CI rate correctly', () => {
      const records = [
        createSuccessfulFirstCiFixture(),
        createRemoteOnlyFailureFixture(),
        createLocalFailureFixture(),
      ];

      const withCiVerdict = records.filter((r) => r.verificationTelemetry?.firstCiVerdict);
      const passedCi = withCiVerdict.filter(
        (r) => r.verificationTelemetry?.firstCiVerdict?.status === 'pass'
      );

      const rate = passedCi.length / withCiVerdict.length;
      expect(rate).toBe(0.5);
    });

    it('should compute local-vs-remote detection rate', () => {
      const records = [
        createSuccessfulFirstCiFixture(),
        createRemoteOnlyFailureFixture(),
        createLocalFailureFixture(),
      ];

      const localFailures = records.filter(
        (r) => r.verificationTelemetry?.summary?.overallStatus === 'fail'
      );
      const remoteOnly = records.filter((r) => r.verificationTelemetry?.remoteOnlyFailure);

      expect(localFailures.length).toBe(1);
      expect(remoteOnly.length).toBe(1);

      const allFailures = records.filter(
        (r) =>
          r.verificationTelemetry?.summary?.overallStatus === 'fail' ||
          r.verificationTelemetry?.firstCiVerdict?.status === 'fail'
      );
      const detectionRate = localFailures.length / allFailures.length;
      expect(detectionRate).toBe(0.5);
    });

    it('should compute remediation success rate', () => {
      const records = [
        createSuccessfulFirstCiFixture(),
        createRemoteOnlyFailureFixture(),
      ];

      const withRemediation = records.filter((r) => r.verificationTelemetry?.remediation);
      const successfulRemediation = withRemediation.filter((r) =>
        r.verificationTelemetry?.remediation?.some((rem) => rem.outcome === 'passed')
      );

      const rate = successfulRemediation.length / withRemediation.length;
      expect(rate).toBe(1);
    });
  });
});
