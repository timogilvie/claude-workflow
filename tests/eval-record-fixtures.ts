/**
 * Eval record fixtures for verification telemetry testing.
 *
 * Provides deterministic, realistic eval records for three key scenarios:
 * 1. Local failure (PR blocked before creation)
 * 2. Remote-only failure (CI catches issue)
 * 3. Successful first CI (no issues)
 */

import { v4 as uuidv4 } from 'uuid';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';

/**
 * Fixture: Eval record for local failure (verification blocks PR)
 */
export function createLocalFailureFixture(overrides?: Partial<EvalRecord>): EvalRecord {
  return {
    id: uuidv4(),
    schemaVersion: '1.37.0',
    originalPrompt: 'Implement feature X',
    modelId: 'claude-opus-4',
    modelVersion: '2024-08-06',
    score: 0,
    scoreBand: 'Failure',
    timeSeconds: 180,
    timestamp: new Date().toISOString(),
    interventionRequired: true,
    interventionCount: 1,
    interventionDetails: ['Manual verification override needed'],
    rationale: 'Verification failed locally; PR not created',
    agentType: 'claude',
    verificationTelemetry: {
      contractSource: 'github-enforced',
      contractVersion: '1.0.0',
      verifiedHeadSha: 'a'.repeat(40),
      verifiedBaseSha: 'b'.repeat(40),
      startedAt: new Date(Date.now() - 600000).toISOString(),
      completedAt: new Date(Date.now() - 580000).toISOString(),
      commands: [
        {
          index: 1,
          commandName: 'check-required-files',
          status: 'pass',
          durationMs: 500,
        },
        {
          index: 2,
          commandName: 'run-linter',
          status: 'fail',
          durationMs: 2000,
          failureReason: 'Lint errors in src/main.ts',
        },
      ],
      summary: {
        totalCommands: 2,
        passedCommands: 1,
        failedCommands: 1,
        timeoutCommands: 0,
        overallStatus: 'fail',
        totalTimeSeconds: 2.5,
        wasOverridden: false,
      },
      failureCategory: 'lint_error',
      failedCheckFingerprint: 'e3b0c44298fc1c149afbf4c8996fb924',
    },
    ...overrides,
  };
}

/**
 * Fixture: Eval record for remote-only failure (passes locally, fails on CI)
 */
export function createRemoteOnlyFailureFixture(overrides?: Partial<EvalRecord>): EvalRecord {
  const startTime = new Date(Date.now() - 1200000);
  const ciStartTime = new Date(startTime.getTime() + 60000);

  return {
    id: uuidv4(),
    schemaVersion: '1.37.0',
    originalPrompt: 'Implement feature Y',
    modelId: 'claude-opus-4',
    modelVersion: '2024-08-06',
    score: 0.3,
    scoreBand: 'Partial',
    timeSeconds: 600,
    timestamp: new Date().toISOString(),
    prUrl: 'https://github.com/test/repo/pull/123',
    interventionRequired: true,
    interventionCount: 2,
    interventionDetails: [
      'Fixed test compatibility issue',
      'Updated dependency version',
    ],
    rationale: 'CI tests failed; required remediation',
    agentType: 'claude',
    verificationTelemetry: {
      contractSource: 'github-enforced',
      contractVersion: '1.0.0',
      verifiedHeadSha: 'c'.repeat(40),
      verifiedBaseSha: 'd'.repeat(40),
      startedAt: startTime.toISOString(),
      completedAt: new Date(startTime.getTime() + 20000).toISOString(),
      commands: [
        {
          index: 1,
          commandName: 'check-required-files',
          status: 'pass',
          durationMs: 300,
        },
        {
          index: 2,
          commandName: 'run-linter',
          status: 'pass',
          durationMs: 1500,
        },
        {
          index: 3,
          commandName: 'run-tests',
          status: 'pass',
          durationMs: 5000,
        },
      ],
      summary: {
        totalCommands: 3,
        passedCommands: 3,
        failedCommands: 0,
        timeoutCommands: 0,
        overallStatus: 'pass',
        totalTimeSeconds: 6.8,
        wasOverridden: false,
      },
      firstCiVerdict: {
        startedAt: ciStartTime.toISOString(),
        concludedAt: new Date(ciStartTime.getTime() + 900000).toISOString(),
        status: 'fail',
        timeToVerdictSeconds: 900,
        workflowRunId: 'run_123456',
      },
      remoteOnlyFailure: true,
      failureCategory: 'test_compatibility',
      failedCheckFingerprint: 'f3b0c44298fc1c149afbf4c8996fb924',
      remediation: [
        {
          attemptNumber: 1,
          description: 'Fixed test setup',
          outcome: 'still_failing',
          delaySeconds: 60,
          durationSeconds: 300,
        },
        {
          attemptNumber: 2,
          description: 'Updated dependencies',
          outcome: 'passed',
          delaySeconds: 30,
          durationSeconds: 180,
        },
      ],
    },
    ...overrides,
  };
}

/**
 * Fixture: Eval record for successful first CI (passes locally and on CI)
 */
export function createSuccessfulFirstCiFixture(overrides?: Partial<EvalRecord>): EvalRecord {
  const startTime = new Date(Date.now() - 1800000);
  const ciStartTime = new Date(startTime.getTime() + 60000);

  return {
    id: uuidv4(),
    schemaVersion: '1.37.0',
    originalPrompt: 'Implement feature Z',
    modelId: 'claude-opus-4',
    modelVersion: '2024-08-06',
    score: 0.95,
    scoreBand: 'Full Success',
    timeSeconds: 300,
    timestamp: new Date().toISOString(),
    prUrl: 'https://github.com/test/repo/pull/124',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Clean implementation; passed all checks locally and on CI',
    agentType: 'claude',
    verificationTelemetry: {
      contractSource: 'github-enforced',
      contractVersion: '1.0.0',
      verifiedHeadSha: 'e'.repeat(40),
      verifiedBaseSha: 'f'.repeat(40),
      startedAt: startTime.toISOString(),
      completedAt: new Date(startTime.getTime() + 25000).toISOString(),
      commands: [
        {
          index: 1,
          commandName: 'check-required-files',
          status: 'pass',
          durationMs: 300,
        },
        {
          index: 2,
          commandName: 'run-linter',
          status: 'pass',
          durationMs: 2000,
        },
        {
          index: 3,
          commandName: 'run-tests',
          status: 'pass',
          durationMs: 8000,
        },
      ],
      summary: {
        totalCommands: 3,
        passedCommands: 3,
        failedCommands: 0,
        timeoutCommands: 0,
        overallStatus: 'pass',
        totalTimeSeconds: 10.3,
        wasOverridden: false,
      },
      firstCiVerdict: {
        startedAt: ciStartTime.toISOString(),
        concludedAt: new Date(ciStartTime.getTime() + 600000).toISOString(),
        status: 'pass',
        timeToVerdictSeconds: 600,
        workflowRunId: 'run_789012',
      },
      remoteOnlyFailure: false,
    },
    ...overrides,
  };
}
