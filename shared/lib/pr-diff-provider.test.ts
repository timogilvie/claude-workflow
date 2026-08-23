import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { fetchPrDiff, isTooLargeDiffError, type PrDiffRunOptions } from './pr-diff-provider.ts';

const TOO_LARGE_STDERR = `HTTP 406: Sorry, the diff exceeded the maximum number of files (300).
Consider using 'List pull requests files' API or locally cloning the repository instead.
PullRequest.diff too_large`;

function ghError(message: string): Error {
  return Object.assign(new Error(message), { stderr: message });
}

function metadata(): string {
  return JSON.stringify({
    url: 'https://github.com/org/repo/pull/1197',
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: 'head-sha',
  });
}

describe('fetchPrDiff', () => {
  it('returns gh pr diff output when it succeeds', () => {
    const runGh = mock.fn((args: string[]) => {
      assert.deepEqual(args, ['pr', 'diff', '123']);
      return 'diff --git a/a.ts b/a.ts\n';
    });

    const result = fetchPrDiff('123', '/repo', { runGh });

    assert.equal(result.kind, 'diff');
    assert.equal(result.kind === 'diff' && result.source, 'gh-pr-diff');
    assert.equal(result.kind === 'diff' && result.text, 'diff --git a/a.ts b/a.ts\n');
    assert.equal(runGh.mock.callCount(), 1);
  });

  it('falls back to a local git diff when gh pr diff hits the 300-file cap', () => {
    const warn = mock.method(console, 'warn', () => {});
    const runGh = mock.fn((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'diff') throw ghError(TOO_LARGE_STDERR);
      if (args[0] === 'pr' && args[1] === 'view') return metadata();
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    const runGit = mock.fn((args: string[]) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'merge-base') return 'base-sha';
      if (args[0] === 'diff') return 'diff --git a/big.ts b/big.ts\n+large change\n';
      throw new Error(`unexpected git ${args.join(' ')}`);
    });

    try {
      const result = fetchPrDiff('1197', '/repo', { runGh, runGit });

      assert.equal(result.kind, 'diff');
      assert.equal(result.kind === 'diff' && result.source, 'local-git');
      assert.match(result.kind === 'diff' ? result.text : '', /large change/);
      assert.ok(result.attempts.some((attempt) => attempt.includes('HTTP 406')));
      assert.ok(result.attempts.some((attempt) => attempt.includes('local-git: ok')));
    } finally {
      warn.mock.restore();
    }
  });

  it('returns unavailable when both gh too_large and local fallback fail', () => {
    const warn = mock.method(console, 'warn', () => {});
    const runGh = mock.fn((args: string[]) => {
      if (args[1] === 'diff') throw ghError(TOO_LARGE_STDERR);
      if (args[1] === 'view') return metadata();
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    const runGit = mock.fn((args: string[]) => {
      if (args[0] === 'fetch') throw new Error('fetch failed');
      throw new Error(`unexpected git ${args.join(' ')}`);
    });

    try {
      const result = fetchPrDiff('1197', '/repo', { runGh, runGit });

      assert.equal(result.kind, 'unavailable');
      assert.equal(result.kind === 'unavailable' && result.reason, 'gh_too_large');
      assert.match(result.kind === 'unavailable' ? result.detail : '', /HTTP 406/);
      assert.notEqual(result.kind === 'unavailable' && result.detail, '(PR diff unavailable)');
    } finally {
      warn.mock.restore();
    }
  });

  it('classifies repeated buffer overruns as unavailable, not an empty diff', () => {
    const warn = mock.method(console, 'warn', () => {});
    const runGh = mock.fn((args: string[]) => {
      if (args[1] === 'diff') return 'x'.repeat(20);
      if (args[1] === 'view') return metadata();
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    const runGit = mock.fn((args: string[], options?: PrDiffRunOptions) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'merge-base') return 'base-sha';
      if (args[0] === 'diff') {
        assert.equal(options?.encoding, 'buffer');
        return 'y'.repeat(20);
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    });

    try {
      const result = fetchPrDiff('1197', '/repo', { runGh, runGit, maxBytes: 5 });

      assert.equal(result.kind, 'unavailable');
      assert.equal(result.kind === 'unavailable' && result.reason, 'buffer_overrun');
      assert.notEqual(result.kind === 'diff' && result.text, '');
    } finally {
      warn.mock.restore();
    }
  });

  it('preserves an empty successful diff', () => {
    const result = fetchPrDiff('123', '/repo', {
      runGh: () => '',
    });

    assert.equal(result.kind, 'diff');
    assert.equal(result.kind === 'diff' && result.text, '');
    assert.equal(result.kind === 'diff' && result.bytes, 0);
  });
});

describe('isTooLargeDiffError', () => {
  it('matches GitHub diff-too-large errors but not unrelated failures', () => {
    assert.equal(isTooLargeDiffError(TOO_LARGE_STDERR), true);
    assert.equal(isTooLargeDiffError('PullRequest.diff too_large'), true);
    assert.equal(isTooLargeDiffError('HTTP 404: Not Found'), false);
  });
});
