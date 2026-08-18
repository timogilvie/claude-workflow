import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GhTransientError,
  classifyGhError,
  computeBackoffDelayMs,
  errorText,
  isTransientGhError,
  withGhRetry,
} from './gh-retry.ts';

describe('gh-retry', () => {
  it('classifies GitHub/network outages as transient', () => {
    const cases: unknown[] = [
      'HTTP 503: No server is currently available to service your request. (https://api.github.com/graphql)',
      'HTTP 502: Bad Gateway',
      'HTTP 504: Gateway Timeout',
      'HTTP 429: rate limit exceeded',
      'secondary rate limit',
      Object.assign(new Error('Command failed'), { code: 'ECONNRESET' }),
      Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' }),
      'Something went wrong while executing your query',
    ];

    for (const value of cases) {
      assert.equal(classifyGhError(value).kind, 'transient', String(value));
      assert.equal(isTransientGhError(value), true);
    }
  });

  it('classifies auth and terminal gh failures as non-transient', () => {
    const cases: Array<[unknown, 'auth' | 'other']> = [
      ['HTTP 401: Bad credentials', 'auth'],
      ['HTTP 403: Resource not accessible by integration', 'auth'],
      ['HTTP 404: Not Found', 'other'],
      ['No commit found for SHA abc\nHTTP 422', 'other'],
      [Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), 'other'],
      [new Error('boom'), 'other'],
    ];

    for (const [value, kind] of cases) {
      assert.equal(classifyGhError(value).kind, kind, String(value));
      assert.equal(isTransientGhError(value), false);
    }
  });

  it('reads stdout and stderr from exec-style errors', () => {
    const error = Object.assign(new Error('Command failed'), {
      stdout: Buffer.from(''),
      stderr: Buffer.from('HTTP 503: Service Unavailable'),
    });

    assert.match(errorText(error), /HTTP 503/);
    assert.equal(classifyGhError(error).kind, 'transient');
  });

  it('retries transient failures and succeeds', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await withGhRetry(
      () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('HTTP 503: Service Unavailable');
        }
        return 'ok';
      },
      { sleep: async (ms) => { sleeps.push(ms); }, random: () => 1 },
    );

    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  it('rethrows non-transient failures immediately', async () => {
    let attempts = 0;
    const sleeps: number[] = [];

    await assert.rejects(
      withGhRetry(
        () => {
          attempts += 1;
          throw new Error('HTTP 422: No commit found for SHA');
        },
        { sleep: async (ms) => { sleeps.push(ms); } },
      ),
      /HTTP 422/,
    );

    assert.equal(attempts, 1);
    assert.deepEqual(sleeps, []);
  });

  it('wraps exhausted transient failures', async () => {
    const cause = new Error('HTTP 503: Service Unavailable');

    await assert.rejects(
      withGhRetry(
        () => {
          throw cause;
        },
        { maxAttempts: 2, sleep: async () => {}, label: 'gh pr list' },
      ),
      (error) => {
        assert.ok(error instanceof GhTransientError);
        assert.equal(error.attempts, 2);
        assert.equal(error.cause, cause);
        assert.equal(error.label, 'gh pr list');
        return true;
      },
    );
  });

  it('supports sync functions', async () => {
    const value = await withGhRetry(() => 42, { sleep: async () => {} });
    assert.equal(value, 42);
  });

  it('computes capped jittered backoff delays', () => {
    assert.equal(computeBackoffDelayMs(0, 1000, 5000, () => 1), 0);
    assert.equal(computeBackoffDelayMs(1, 1000, 5000, () => 1), 1000);
    assert.equal(computeBackoffDelayMs(3, 1000, 5000, () => 1), 4000);
    assert.equal(computeBackoffDelayMs(10, 1000, 5000, () => 1), 5000);
    assert.equal(computeBackoffDelayMs(1, 1000, 5000, () => 0), 500);
  });
});
