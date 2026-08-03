import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import { computeVerificationMetrics } from './verification-metrics.ts';

function makeRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: overrides.id ?? 'eval-1',
    schemaVersion: '1.36.0',
    originalPrompt: 'Ship a change',
    modelId: 'gpt-5.4',
    modelVersion: 'gpt-5.4',
    score: 1,
    scoreBand: 'Full Success',
    timeSeconds: 60,
    timestamp: '2026-08-03T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Done.',
    repoContext: {
      repoId: 'wavemill',
      repoVisibility: 'private',
      primaryLanguage: 'TypeScript',
    },
    outcomes: {
      success: true,
      review: {
        humanReviewRequired: false,
        rounds: 1,
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
    ...overrides,
  };
}

describe('verification metrics', () => {
  const window = {
    startTime: new Date('2026-08-03T00:00:00.000Z'),
    endTime: new Date('2026-08-04T00:00:00.000Z'),
  };

  it('computes first-green, remote-only, remediation, time-to-green, prevention, and override rates', () => {
    const records = [
      makeRecord({
        id: 'local-failure',
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
            prCreated: false,
            merged: false,
          },
        },
        verificationTelemetry: {
          schema_version: '1.0',
          contract: {
            source: 'explicit',
            version: '1.0',
          },
          local_verification: {
            ran: true,
            passed: false,
            first_failure_category: 'lint',
          },
          timeline: {
            local_start: '2026-08-03T12:00:00.000Z',
          },
        },
      }),
      makeRecord({
        id: 'remote-only',
        verificationTelemetry: {
          schema_version: '1.0',
          contract: {
            source: 'explicit',
            version: '1.0',
          },
          local_verification: {
            ran: true,
            passed: true,
          },
          remote_ci_verdict: {
            ran: true,
            passed: false,
            check_count: 2,
            remote_only_failure: true,
            first_failure_category: 'test',
          },
          remediation: {
            remote_fix_required: true,
          },
          timeline: {
            local_start: '2026-08-03T12:10:00.000Z',
          },
        },
      }),
      makeRecord({
        id: 'first-green',
        verificationTelemetry: {
          schema_version: '1.0',
          contract: {
            source: 'explicit',
            version: '1.0',
          },
          local_verification: {
            ran: true,
            passed: true,
          },
          remote_ci_verdict: {
            ran: true,
            passed: true,
            check_count: 3,
            remote_only_failure: false,
          },
          remediation: {
            local_remediation_outcome: 'none',
            remote_fix_required: false,
          },
          timeline: {
            local_start: '2026-08-03T12:20:00.000Z',
            remote_ci_first_green: '2026-08-03T12:30:00.000Z',
          },
        },
      }),
      makeRecord({
        id: 'override',
        verificationTelemetry: {
          schema_version: '1.0',
          contract: {
            source: 'explicit',
            version: '1.0',
          },
          local_verification: {
            ran: true,
            passed: false,
            first_failure_category: 'custom',
          },
          operator_override: {
            applied: true,
            reason: 'Manually checked.',
          },
        },
      }),
    ];

    const metrics = computeVerificationMetrics(records, window);

    assert.equal(metrics.total_records_analyzed, 4);
    assert.equal(metrics.first_green_ci_rate, 50);
    assert.equal(metrics.local_vs_remote_detection_rate, 0);
    assert.equal(metrics.ci_remediation_rate, 100);
    assert.equal(metrics.median_time_to_green_ms, 10 * 60 * 1000);
    assert.equal(metrics.failures_prevented_before_pr, 25);
    assert.equal(metrics.operator_override_rate, 25);
  });

  it('segments by repository and contract version', () => {
    const records = [
      makeRecord({
        id: 'included',
        repoContext: {
          repoId: 'wavemill',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
        },
        verificationTelemetry: {
          contract: {
            source: 'explicit',
            version: '2.0',
          },
          remote_ci_verdict: {
            ran: true,
            passed: true,
            check_count: 1,
          },
        },
      }),
      makeRecord({
        id: 'wrong-version',
        verificationTelemetry: {
          contract: {
            source: 'explicit',
            version: '1.0',
          },
          remote_ci_verdict: {
            ran: true,
            passed: false,
            check_count: 1,
          },
        },
      }),
      makeRecord({
        id: 'wrong-repo',
        repoContext: {
          repoId: 'other',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
        },
        verificationTelemetry: {
          contract: {
            source: 'explicit',
            version: '2.0',
          },
          remote_ci_verdict: {
            ran: true,
            passed: false,
            check_count: 1,
          },
        },
      }),
    ];

    const metrics = computeVerificationMetrics(records, {
      ...window,
      repoId: 'wavemill',
      contractVersion: '2.0',
    });

    assert.equal(metrics.total_records_analyzed, 1);
    assert.equal(metrics.first_green_ci_rate, 100);
  });
});
