import { describe, it, expect } from '@jest/globals';
import { validateEvalRecord } from '../shared/lib/eval-validator.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';

describe('Eval Record Backward Compatibility', () => {
  it('should validate old eval record without verificationTelemetry', () => {
    const oldRecord: EvalRecord = {
      id: 'test-old-1',
      schemaVersion: '1.35.0',
      originalPrompt: 'Some prompt',
      modelId: 'claude-opus-4',
      modelVersion: '2024-08-06',
      score: 0.75,
      scoreBand: 'Assisted Success',
      timeSeconds: 300,
      timestamp: new Date().toISOString(),
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'Good work',
    };

    const errors = validateEvalRecord(oldRecord, { file: 'test.jsonl', line: 1 });
    expect(errors).toEqual([]);
  });

  it('should validate new eval record with verificationTelemetry', () => {
    const newRecord: EvalRecord = {
      id: 'test-new-1',
      schemaVersion: '1.37.0',
      originalPrompt: 'Some prompt',
      modelId: 'claude-opus-4',
      modelVersion: '2024-08-06',
      score: 0.85,
      scoreBand: 'Full Success',
      timeSeconds: 250,
      timestamp: new Date().toISOString(),
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'Excellent work',
      verificationTelemetry: {
        contractSource: 'github-enforced',
        contractVersion: '1.0.0',
        verifiedHeadSha: 'a'.repeat(40),
        verifiedBaseSha: 'b'.repeat(40),
        summary: {
          totalCommands: 3,
          passedCommands: 3,
          failedCommands: 0,
          timeoutCommands: 0,
          overallStatus: 'pass',
          totalTimeSeconds: 15,
          wasOverridden: false,
        },
        firstCiVerdict: {
          status: 'pass',
          timeToVerdictSeconds: 600,
        },
      },
    };

    const errors = validateEvalRecord(newRecord, { file: 'test.jsonl', line: 1 });
    expect(errors).toEqual([]);
  });

  it('should reject invalid SHAs in verificationTelemetry', () => {
    const record: EvalRecord = {
      id: 'test-invalid-sha',
      schemaVersion: '1.37.0',
      originalPrompt: 'Some prompt',
      modelId: 'claude-opus-4',
      modelVersion: '2024-08-06',
      score: 0.75,
      scoreBand: 'Assisted Success',
      timeSeconds: 300,
      timestamp: new Date().toISOString(),
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'Test',
      verificationTelemetry: {
        verifiedHeadSha: 'invalid-sha',
      },
    };

    const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject out-of-bounds durations', () => {
    const record: EvalRecord = {
      id: 'test-bad-duration',
      schemaVersion: '1.37.0',
      originalPrompt: 'Some prompt',
      modelId: 'claude-opus-4',
      modelVersion: '2024-08-06',
      score: 0.75,
      scoreBand: 'Assisted Success',
      timeSeconds: 300,
      timestamp: new Date().toISOString(),
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'Test',
      verificationTelemetry: {
        summary: {
          totalCommands: 1,
          passedCommands: 1,
          failedCommands: 0,
          timeoutCommands: 0,
          overallStatus: 'pass',
          totalTimeSeconds: 100000, // exceeds 86400
          wasOverridden: false,
        },
      },
    };

    const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should detect secret patterns in failureReason', () => {
    const record: EvalRecord = {
      id: 'test-secret-leak',
      schemaVersion: '1.37.0',
      originalPrompt: 'Some prompt',
      modelId: 'claude-opus-4',
      modelVersion: '2024-08-06',
      score: 0.75,
      scoreBand: 'Assisted Success',
      timeSeconds: 300,
      timestamp: new Date().toISOString(),
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'Test',
      verificationTelemetry: {
        commands: [
          {
            index: 1,
            commandName: 'npm test',
            status: 'fail',
            failureReason: 'API_KEY=secret123 failed',
          },
        ],
      },
    };

    const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
    expect(errors.length).toBeGreaterThan(0);
  });
});
