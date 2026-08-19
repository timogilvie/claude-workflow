import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeBackoffDelayMs,
  isTransientError,
  isTransientErrorText,
  retryTransient,
} from './transient-retry.ts';

describe('transient error classification', () => {
  it('recognizes GitHub and network transient failures', () => {
    const samples = [
      'HTTP 503: No server is currently available to service your request. (https://api.github.com/graphql)',
      'Command failed: gh pr list\nHTTP 503: No server is currently available',
      'HTTP 502 Bad Gateway',
      'HTTP 429 rate limit exceeded',
      'secondary rate limit',
      'ECONNRESET',
      'Could not resolve host: github.com',
      'Failed to get PR: HTTP 503 Service Unavailable',
    ];
    for (const sample of samples) {
      assert.equal(isTransientErrorText(sample), true, sample);
    }
    assert.equal(isTransientError({ killed: true, signal: 'SIGTERM', code: 'ETIMEDOUT' }), true);
  });

  it('does not classify auth, validation, or programming errors as transient', () => {
    for (const sample of ['HTTP 404 Not Found', 'HTTP 401 Bad credentials', 'HTTP 422 Validation Failed', 'TypeError']) {
      assert.equal(isTransientErrorText(sample), false, sample);
    }
  });
});

describe('computeBackoffDelayMs', () => {
  it('applies exponential cap and jitter bounds', () => {
    assert.equal(computeBackoffDelayMs(1, { baseMs: 2_000, maxMs: 20_000, random: () => 0.5 }), 2_000);
    assert.equal(computeBackoffDelayMs(2, { baseMs: 2_000, maxMs: 20_000, random: () => 0.5 }), 4_000);
    assert.equal(computeBackoffDelayMs(5, { baseMs: 2_000, maxMs: 20_000, random: () => 0.5 }), 20_000);
    assert.equal(computeBackoffDelayMs(1, { baseMs: 2_000, maxMs: 20_000, random: () => 0 }), 1_500);
    assert.equal(computeBackoffDelayMs(1, { baseMs: 2_000, maxMs: 20_000, random: () => 1 }), 2_500);
  });
});

describe('retryTransient', () => {
  it('retries transient failures and returns the eventual result', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await retryTransient(
      () => {
        calls += 1;
        if (calls < 3) throw new Error('HTTP 503 Service Unavailable');
        return 'ok';
      },
      { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 },
    );

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2_000, 4_000]);
  });

  it('throws terminal errors immediately and preserves final error identity', async () => {
    const terminal = new Error('HTTP 404 Not Found');
    await assert.rejects(
      retryTransient(() => { throw terminal; }, { sleep: async () => undefined }),
      (error) => error === terminal,
    );

    const final = new Error('HTTP 503 Service Unavailable');
    let calls = 0;
    await assert.rejects(
      retryTransient(
        () => {
          calls += 1;
          throw final;
        },
        { maxAttempts: 2, sleep: async () => undefined },
      ),
      (error) => error === final,
    );
    assert.equal(calls, 2);
  });
});
