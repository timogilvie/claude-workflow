import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMergeConflicts,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_TRANSIENT_ATTEMPTS,
  readyStageDeps,
} from '../shared/lib/ready-stage.ts';

describe('ready-stage transient mergeability', () => {
  it('exports the transient retry constants', () => {
    assert.equal(MAX_TRANSIENT_ATTEMPTS, 3);
    assert.equal(INITIAL_BACKOFF_MS, 5000);
    assert.equal(MAX_BACKOFF_MS, 15000);
  });

  it('retries UNKNOWN mergeability with exponential backoff', async () => {
    const execMock = mock.method(readyStageDeps, 'execShellCommand', () =>
      JSON.stringify({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })
    );
    const sleepCalls: number[] = [];
    const sleepMock = mock.method(readyStageDeps, 'sleep', async (ms: number) => {
      sleepCalls.push(ms);
    });

    try {
      const result = await checkMergeConflicts(42, '/tmp/test');

      assert.equal(result.status, 'UNKNOWN');
      assert.equal(result.attempts, MAX_TRANSIENT_ATTEMPTS);
      assert.equal(execMock.mock.callCount(), MAX_TRANSIENT_ATTEMPTS);
      assert.deepEqual(sleepCalls, [INITIAL_BACKOFF_MS, Math.min(INITIAL_BACKOFF_MS * 2, MAX_BACKOFF_MS)]);
    } finally {
      execMock.mock.restore();
      sleepMock.mock.restore();
    }
  });

  it('returns ERROR for non-transient GitHub merge states without retrying', async () => {
    const execMock = mock.method(readyStageDeps, 'execShellCommand', () =>
      JSON.stringify({ mergeable: 'BLOCKED', mergeStateStatus: 'ERROR' })
    );
    const sleepMock = mock.method(readyStageDeps, 'sleep', async () => undefined);

    try {
      const result = await checkMergeConflicts(42, '/tmp/test');

      assert.equal(result.status, 'ERROR');
      assert.equal(result.attempts, 1);
      assert.match(result.message, /Unexpected mergeability state/);
      assert.equal(execMock.mock.callCount(), 1);
      assert.equal(sleepMock.mock.callCount(), 0);
    } finally {
      execMock.mock.restore();
      sleepMock.mock.restore();
    }
  });

  it('retries transient GitHub exceptions and returns the last error', async () => {
    const execMock = mock.method(readyStageDeps, 'execShellCommand', () => {
      throw new Error('HTTP 504 from GitHub GraphQL');
    });
    const sleepCalls: number[] = [];
    const sleepMock = mock.method(readyStageDeps, 'sleep', async (ms: number) => {
      sleepCalls.push(ms);
    });

    try {
      const result = await checkMergeConflicts(42, '/tmp/test');

      assert.equal(result.status, 'ERROR');
      assert.equal(result.attempts, MAX_TRANSIENT_ATTEMPTS);
      assert.match(result.error ?? '', /HTTP 504/);
      assert.equal(execMock.mock.callCount(), MAX_TRANSIENT_ATTEMPTS);
      assert.deepEqual(sleepCalls, [INITIAL_BACKOFF_MS, Math.min(INITIAL_BACKOFF_MS * 2, MAX_BACKOFF_MS)]);
    } finally {
      execMock.mock.restore();
      sleepMock.mock.restore();
    }
  });

  it('recovers when a later retry reports CLEAN', async () => {
    const responses = [
      JSON.stringify({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
      JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    ];
    const execMock = mock.method(
      readyStageDeps,
      'execShellCommand',
      () => responses.shift() ?? JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })
    );
    const sleepCalls: number[] = [];
    const sleepMock = mock.method(readyStageDeps, 'sleep', async (ms: number) => {
      sleepCalls.push(ms);
    });

    try {
      const result = await checkMergeConflicts(42, '/tmp/test');

      assert.equal(result.status, 'CLEAN');
      assert.equal(result.attempts, 2);
      assert.equal(result.mergeStateStatus, 'CLEAN');
      assert.equal(execMock.mock.callCount(), 2);
      assert.deepEqual(sleepCalls, [INITIAL_BACKOFF_MS]);
    } finally {
      execMock.mock.restore();
      sleepMock.mock.restore();
    }
  });

  it('still returns CONFLICTED immediately for real merge conflicts', async () => {
    const execMock = mock.method(readyStageDeps, 'execShellCommand', () =>
      JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
    );
    const sleepMock = mock.method(readyStageDeps, 'sleep', async () => undefined);

    try {
      const result = await checkMergeConflicts(42, '/tmp/test');

      assert.equal(result.status, 'CONFLICTED');
      assert.equal(result.attempts, 1);
      assert.equal(execMock.mock.callCount(), 1);
      assert.equal(sleepMock.mock.callCount(), 0);
    } finally {
      execMock.mock.restore();
      sleepMock.mock.restore();
    }
  });
});
