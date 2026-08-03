import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvalRecord } from '../shared/lib/eval-validator.ts';
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

function baseRecord(overrides: Partial<EvalRecord>): EvalRecord {
  return {
    id: 'test-record',
    schemaVersion: '1.35.0',
    originalPrompt: 'Some prompt',
    modelId: 'claude-sonnet-4-5-20250929',
    modelVersion: '2024-08-06',
    score: 0.75,
    scoreBand: 'Assisted Success',
    timeSeconds: 300,
    timestamp: '2026-01-01T00:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Good work',
    taskDescriptor: baseTaskDescriptor(),
    ...overrides,
  };
}

describe('Eval Record Backward Compatibility', () => {
  it('should validate old eval record without verificationTelemetry', () => {
    const oldRecord = baseRecord({ id: 'test-old-1' });
    const errors = validateEvalRecord(oldRecord, { file: 'test.jsonl', line: 1 });
    assert.deepEqual(errors, []);
  });

  it('should validate new eval record with verificationTelemetry', () => {
    const newRecord = baseRecord({
      id: 'test-new-1',
      schemaVersion: '1.37.0',
      score: 0.85,
      scoreBand: 'Minor Feedback',
      timeSeconds: 250,
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
    });

    const errors = validateEvalRecord(newRecord, { file: 'test.jsonl', line: 1 });
    assert.deepEqual(errors, []);
  });

  it('should reject invalid SHAs in verificationTelemetry', () => {
    const record = baseRecord({
      id: 'test-invalid-sha',
      schemaVersion: '1.37.0',
      rationale: 'Test',
      verificationTelemetry: {
        verifiedHeadSha: 'invalid-sha',
      },
    });

    const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
    assert.ok(errors.length > 0, 'expected validation errors');
  });

  it('should reject out-of-bounds durations', () => {
    const record = baseRecord({
      id: 'test-bad-duration',
      schemaVersion: '1.37.0',
      rationale: 'Test',
      verificationTelemetry: {
        summary: {
          totalCommands: 1,
          passedCommands: 1,
          failedCommands: 0,
          timeoutCommands: 0,
          overallStatus: 'pass',
          totalTimeSeconds: 100000,
          wasOverridden: false,
        },
      },
    });

    const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
    assert.ok(errors.length > 0, 'expected validation errors');
  });

  it('should detect secret patterns in failureReason', () => {
    const record = baseRecord({
      id: 'test-secret-leak',
      schemaVersion: '1.37.0',
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
    });

    const errors = validateEvalRecord(record, { file: 'test.jsonl', line: 1 });
    assert.ok(errors.length > 0, 'expected validation errors');
  });
});
