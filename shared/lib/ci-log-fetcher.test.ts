import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enrichFailingChecks,
  fetchCheckRunAnnotations,
  fetchFailedJobLogTail,
  parseGitHubActionsJobRef,
  type CiLogFetchOptions,
} from './ci-log-fetcher.ts';

describe('parseGitHubActionsJobRef', () => {
  it('parses GitHub Actions job details URLs', () => {
    assert.deepEqual(
      parseGitHubActionsJobRef('https://github.com/acme/widgets/actions/runs/12345/job/67890?pr=42'),
      { owner: 'acme', repo: 'widgets', runId: '12345', jobId: '67890' },
    );
  });

  it('returns null for empty or non-Actions URLs', () => {
    assert.equal(parseGitHubActionsJobRef(undefined), null);
    assert.equal(parseGitHubActionsJobRef('https://github.com/acme/widgets/pull/42'), null);
  });
});

describe('fetchFailedJobLogTail', () => {
  it('returns a bounded failed log tail', async () => {
    const calls: Array<{ args: string[]; timeout: number }> = [];
    const execFile: CiLogFetchOptions['execFile'] = async (_file, args, options) => {
      calls.push({ args, timeout: options.timeout });
      return { stdout: `${'a'.repeat(80)}\nConfig validation failed: bad model config` };
    };

    const result = await fetchFailedJobLogTail(
      { owner: 'acme', repo: 'widgets', runId: '12345', jobId: '67890' },
      { repoDir: '/tmp/repo', maxBytes: 40, timeoutMs: 1234, execFile },
    );

    assert.match(result ?? '', /^\[\.\.\.truncated\.\.\.\]/);
    assert.match(result ?? '', /bad model config/);
    assert.deepEqual(calls[0].args, [
      'run',
      'view',
      '12345',
      '--log-failed',
      '--job',
      '67890',
      '--repo',
      'acme/widgets',
    ]);
    assert.equal(calls[0].timeout, 1234);
  });

  it('returns null when gh exits non-zero or times out', async () => {
    const execFile: CiLogFetchOptions['execFile'] = async () => {
      throw new Error('Command failed');
    };

    const result = await fetchFailedJobLogTail(
      { owner: 'acme', repo: 'widgets', runId: '12345', jobId: '67890' },
      { repoDir: '/tmp/repo', maxBytes: 100, execFile },
    );

    assert.equal(result, null);
  });
});

describe('fetchCheckRunAnnotations', () => {
  it('parses and formats check-run annotations', async () => {
    const execFile: CiLogFetchOptions['execFile'] = async () => ({
      stdout: JSON.stringify([
        {
          path: 'shared/lib/config.test.ts',
          start_line: 42,
          annotation_level: 'failure',
          message: 'ERR_TEST_FAILURE: expected true actual false',
        },
      ]),
    });

    const result = await fetchCheckRunAnnotations(
      { owner: 'acme', repo: 'widgets', runId: '12345', jobId: '67890' },
      112233,
      { repoDir: '/tmp/repo', maxBytes: 1000, execFile },
    );

    assert.deepEqual(result, [
      'shared/lib/config.test.ts:42 failure ERR_TEST_FAILURE: expected true actual false',
    ]);
  });

  it('returns null for malformed annotation JSON', async () => {
    const execFile: CiLogFetchOptions['execFile'] = async () => ({ stdout: 'not json' });
    const result = await fetchCheckRunAnnotations(
      { owner: 'acme', repo: 'widgets', runId: '12345', jobId: '67890' },
      112233,
      { repoDir: '/tmp/repo', maxBytes: 1000, execFile },
    );

    assert.equal(result, null);
  });

  it('bounds oversized annotations by the configured max bytes', async () => {
    const execFile: CiLogFetchOptions['execFile'] = async () => ({
      stdout: JSON.stringify([
        {
          path: 'big.test.ts',
          start_line: 1,
          annotation_level: 'failure',
          message: `ERR_TEST_FAILURE ${'x'.repeat(500)}`,
        },
      ]),
    });

    const result = await fetchCheckRunAnnotations(
      { owner: 'acme', repo: 'widgets', runId: '12345', jobId: '67890' },
      112233,
      { repoDir: '/tmp/repo', maxBytes: 80, execFile },
    );

    assert.equal(result?.length, 1);
    assert.match(result?.[0] ?? '', /^\[\.\.\.truncated\.\.\.\]/);
    assert.ok(Buffer.byteLength(result?.[0] ?? '', 'utf-8') <= 100);
  });
});

describe('enrichFailingChecks', () => {
  it('enriches only failing checks and preserves checks when fetches fail', async () => {
    const execFile: CiLogFetchOptions['execFile'] = async (_file, args) => {
      if (args[0] === 'api') {
        return {
          stdout: JSON.stringify([{
            path: 'test.ts',
            start_line: 9,
            annotation_level: 'failure',
            message: 'assertion failed',
          }]),
        };
      }
      return { stdout: 'ERR_TEST_FAILURE in unit test log' };
    };

    const checks = await enrichFailingChecks([
      { name: 'build', status: 'success', rawStatus: 'SUCCESS' },
      {
        name: 'Unit Tests',
        status: 'failure',
        rawStatus: 'FAILURE',
        detailsUrl: 'https://github.com/acme/widgets/actions/runs/12345/job/67890',
        databaseId: 112233,
      },
      {
        name: 'deploy',
        status: 'failure',
        rawStatus: 'FAILURE',
        detailsUrl: 'https://example.com/deploy/1',
      },
    ], {
      repoDir: '/tmp/repo',
      maxBytes: 1000,
      execFile,
    });

    assert.equal(checks[0].text, undefined);
    assert.match(checks[1].text ?? '', /ERR_TEST_FAILURE/);
    assert.deepEqual(checks[1].annotations, ['test.ts:9 failure assertion failed']);
    assert.equal(checks[2].text, undefined);
  });
});
