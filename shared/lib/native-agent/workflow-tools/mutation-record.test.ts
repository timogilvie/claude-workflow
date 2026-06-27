import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDeniedRecord,
  createExecutedRecord,
  createFailedRecord,
  normalizeMutationError,
  type DeniedMutationRecord,
  type ExecutedMutationRecord,
  type FailedMutationRecord,
  type MutationRecord,
} from './mutation-record.ts';

// ---------------------------------------------------------------------------
// Record shapes and JSON serializability
// ---------------------------------------------------------------------------

describe('mutation-record: DeniedMutationRecord', () => {
  it('createDeniedRecord produces correct shape', () => {
    const record = createDeniedRecord('github_create_pr', 'review', 'merge', 'review_cannot_merge: test', 1000);
    assert.equal(record.outcome, 'denied');
    assert.equal(record.tool, 'github_create_pr');
    assert.equal(record.phase, 'review');
    assert.equal(record.action, 'merge');
    assert.equal(record.reason, 'review_cannot_merge: test');
    assert.equal(record.timestampMs, 1000);
  });

  it('denied record is JSON-serializable', () => {
    const record = createDeniedRecord('linear_comment', 'ready', 'comment', 'ready_mutation_denied: test', 2000);
    const json = JSON.stringify(record);
    const parsed = JSON.parse(json) as DeniedMutationRecord;
    assert.equal(parsed.outcome, 'denied');
    assert.equal(parsed.tool, 'linear_comment');
    assert.equal(parsed.phase, 'ready');
    assert.equal(parsed.action, 'comment');
    assert.equal(parsed.reason, 'ready_mutation_denied: test');
    assert.equal(parsed.timestampMs, 2000);
  });

  it('denied record does not have an executed or failed shape', () => {
    const record: MutationRecord = createDeniedRecord('github_add_label', 'ready', 'add_label', 'reason', 0);
    assert.equal(record.outcome, 'denied');
    // Narrowed to denied — no policyReason, error, result fields
    assert.equal('policyReason' in record, false);
    assert.equal('error' in record, false);
  });
});

describe('mutation-record: ExecutedMutationRecord', () => {
  it('createExecutedRecord produces correct shape without extras', () => {
    const record = createExecutedRecord('github_create_pr', 'review', 'create_pr', 'allowed', 3000);
    assert.equal(record.outcome, 'executed');
    assert.equal(record.tool, 'github_create_pr');
    assert.equal(record.phase, 'review');
    assert.equal(record.action, 'create_pr');
    assert.equal(record.policyReason, 'allowed');
    assert.equal(record.timestampMs, 3000);
    assert.equal(record.idempotencyKey, undefined);
    assert.equal(record.idempotencyOutcome, undefined);
    assert.equal(record.ref, undefined);
  });

  it('createExecutedRecord includes idempotency extras when provided', () => {
    const ref = { system: 'github' as const, kind: 'pull_request' as const, id: '42', url: 'https://example.com/42' };
    const record = createExecutedRecord(
      'github_create_pr', 'review', 'create_pr', 'allowed', 4000,
      { idempotencyKey: 'github_create_pr:owner/repo:feat:main:abc', idempotencyOutcome: 'created', ref },
    );
    assert.equal(record.idempotencyKey, 'github_create_pr:owner/repo:feat:main:abc');
    assert.equal(record.idempotencyOutcome, 'created');
    assert.deepEqual(record.ref, ref);
  });

  it('executed record is JSON-serializable', () => {
    const ref = { system: 'github' as const, kind: 'pull_request' as const, id: '7' };
    const record = createExecutedRecord(
      'github_add_label', 'review', 'add_label', 'policy ok', 5000,
      { idempotencyKey: 'k1', idempotencyOutcome: 'skipped', ref: null },
    );
    const json = JSON.stringify(record);
    const parsed = JSON.parse(json) as ExecutedMutationRecord;
    assert.equal(parsed.outcome, 'executed');
    assert.equal(parsed.idempotencyOutcome, 'skipped');
    assert.equal(parsed.ref, null);
  });

  it('ref can be null when outcome is skipped', () => {
    const record = createExecutedRecord(
      'github_add_label', 'review', 'add_label', 'allowed', 0,
      { idempotencyKey: 'k', idempotencyOutcome: 'skipped', ref: null },
    );
    assert.equal(record.ref, null);
  });
});

describe('mutation-record: FailedMutationRecord', () => {
  it('createFailedRecord produces correct shape for Error instance', () => {
    const record = createFailedRecord('linear_comment', 'coding', 'comment', new Error('network timeout'), 6000);
    assert.equal(record.outcome, 'failed');
    assert.equal(record.tool, 'linear_comment');
    assert.equal(record.phase, 'coding');
    assert.equal(record.action, 'comment');
    assert.equal(record.error, 'network timeout');
    assert.equal(record.timestampMs, 6000);
  });

  it('failed record is JSON-serializable', () => {
    const record = createFailedRecord('github_create_pr', 'review', 'create_pr', new Error('rate limited'), 7000);
    const json = JSON.stringify(record);
    const parsed = JSON.parse(json) as FailedMutationRecord;
    assert.equal(parsed.outcome, 'failed');
    assert.equal(parsed.error, 'rate limited');
    assert.equal(parsed.timestampMs, 7000);
  });

  it('does not contain a stack trace in the error field', () => {
    const err = new Error('some message');
    const record = createFailedRecord('linear_comment', 'coding', 'comment', err, 0);
    assert.equal(record.error.includes('at '), false, 'stack trace must not appear in error field');
  });
});

// ---------------------------------------------------------------------------
// normalizeMutationError
// ---------------------------------------------------------------------------

describe('mutation-record: normalizeMutationError', () => {
  it('extracts message from Error instance', () => {
    assert.equal(normalizeMutationError(new Error('boom')), 'boom');
  });

  it('returns string error as-is', () => {
    assert.equal(normalizeMutationError('something went wrong'), 'something went wrong');
  });

  it('returns fallback for null', () => {
    assert.equal(normalizeMutationError(null), 'unknown error');
  });

  it('returns fallback for undefined', () => {
    assert.equal(normalizeMutationError(undefined), 'unknown error');
  });

  it('returns fallback for numeric error codes', () => {
    assert.equal(normalizeMutationError(404), 'unknown error');
  });

  it('returns fallback for plain objects', () => {
    assert.equal(normalizeMutationError({ code: 'ENOENT' }), 'unknown error');
  });
});
