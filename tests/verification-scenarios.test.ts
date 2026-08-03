import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
      assert.equal(errors.length, 0);
    });

    it('should have fail status in verification summary', () => {
      const record = createLocalFailureFixture();
      assert.equal(record.verificationTelemetry?.summary?.overallStatus, 'fail');
    });

    it('should not have CI verdict (PR not created)', () => {
      const record = createLocalFailureFixture();
      assert.equal(record.verificationTelemetry?.firstCiVerdict, undefined);
    });

    it('should export with telemetry redacted', () => {
      const record = createLocalFailureFixture();
      const projected = projectForExport(record);
      assert.ok(projected.verificationTelemetry);
      assert.equal((projected.verificationTelemetry as any)?.failureCategory, 'lint_error');
    });
  });

  describe('Scenario 2: Remote-Only Failure (CI catches issue)', () => {
    it('should create valid eval record', () => {
      const record = createRemoteOnlyFailureFixture();
      const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
      assert.equal(errors.length, 0);
    });

    it('should have pass status for local verification', () => {
      const record = createRemoteOnlyFailureFixture();
      assert.equal(record.verificationTelemetry?.summary?.overallStatus, 'pass');
    });

    it('should have fail status for first CI verdict', () => {
      const record = createRemoteOnlyFailureFixture();
      assert.equal(record.verificationTelemetry?.firstCiVerdict?.status, 'fail');
    });

    it('should mark as remote-only failure', () => {
      const record = createRemoteOnlyFailureFixture();
      assert.equal(record.verificationTelemetry?.remoteOnlyFailure, true);
    });

    it('should include remediation attempts', () => {
      const record = createRemoteOnlyFailureFixture();
      assert.equal(record.verificationTelemetry?.remediation?.length, 2);
      assert.equal(record.verificationTelemetry?.remediation?.[1]?.outcome, 'passed');
    });
  });

  describe('Scenario 3: Successful First CI (no issues)', () => {
    it('should create valid eval record', () => {
      const record = createSuccessfulFirstCiFixture();
      const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
      assert.equal(errors.length, 0);
    });

    it('should have pass status for both local and CI', () => {
      const record = createSuccessfulFirstCiFixture();
      assert.equal(record.verificationTelemetry?.summary?.overallStatus, 'pass');
      assert.equal(record.verificationTelemetry?.firstCiVerdict?.status, 'pass');
    });

    it('should not be marked as remote-only failure', () => {
      const record = createSuccessfulFirstCiFixture();
      assert.equal(record.verificationTelemetry?.remoteOnlyFailure, false);
    });

    it('should have reasonable CI timing', () => {
      const record = createSuccessfulFirstCiFixture();
      assert.equal(record.verificationTelemetry?.firstCiVerdict?.timeToVerdictSeconds, 600);
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
      assert.equal(rate, 0.5);
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

      assert.equal(localFailures.length, 1);
      assert.equal(remoteOnly.length, 1);

      const allFailures = records.filter(
        (r) =>
          r.verificationTelemetry?.summary?.overallStatus === 'fail' ||
          r.verificationTelemetry?.firstCiVerdict?.status === 'fail'
      );
      const detectionRate = localFailures.length / allFailures.length;
      assert.equal(detectionRate, 0.5);
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
      assert.equal(rate, 1);
    });
  });
});
