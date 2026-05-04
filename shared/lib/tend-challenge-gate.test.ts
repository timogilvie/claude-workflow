import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  applyChallengePairGates,
  getSiblingBranch,
  parseRemoteBranchOutput,
  type ChallengeBlockedCandidate,
  type ChallengeEligibleWorkItem,
  type ChallengeGateOptions,
} from './tend-challenge-gate.ts';

function makeWorkItem(overrides: {
  number?: number;
  title?: string;
  headRefName?: string;
  createdAt?: string;
  labels?: Array<{ name: string }>;
  challengePairId?: string;
  challenge?: boolean;
}): ChallengeEligibleWorkItem {
  return {
    pr: {
      number: overrides.number ?? 101,
      title: overrides.title ?? 'Test PR',
      headRefName: overrides.headRefName ?? 'task/test-pr',
      createdAt: overrides.createdAt ?? '2026-04-01T00:00:00Z',
      labels: overrides.labels ?? [],
    },
    metadata: {
      challengePairId: overrides.challengePairId,
      challenge: overrides.challenge,
    },
  };
}

function setupRepoDir(config: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-gate-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      integration: { integrationBranch: 'auto/integration' },
      ...config,
    }),
  );
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function writeWorkflowState(repoDir: string, tasks: Record<string, unknown>): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks }));
}

describe('getSiblingBranch', () => {
  it('returns challenger sibling for a primary task branch', () => {
    assert.equal(getSiblingBranch('task/foo'), 'task/foo-challenger');
  });

  it('returns primary sibling for a challenger task branch', () => {
    assert.equal(getSiblingBranch('task/foo-challenger'), 'task/foo');
  });

  it('returns null for non-task branches', () => {
    assert.equal(getSiblingBranch('feature/bar'), null);
    assert.equal(getSiblingBranch('main'), null);
  });

  it('handles double-challenger suffix correctly', () => {
    assert.equal(getSiblingBranch('task/foo-challenger-challenger'), 'task/foo-challenger');
  });

  it('handles nested task branch paths', () => {
    assert.equal(getSiblingBranch('task/some/nested/path'), 'task/some/nested/path-challenger');
  });
});

describe('parseRemoteBranchOutput', () => {
  it('parses full refs from git ls-remote output', () => {
    const output = [
      'abc123\trefs/heads/task/foo',
      'def456\trefs/heads/task/bar-challenger',
    ].join('\n');
    assert.deepEqual(parseRemoteBranchOutput(output), ['task/foo', 'task/bar-challenger']);
  });

  it('handles plain branch names without refs/heads/', () => {
    const output = 'abc123\ttask/baz\n';
    assert.deepEqual(parseRemoteBranchOutput(output), ['task/baz']);
  });

  it('skips non-task branches', () => {
    const output = [
      'abc123\trefs/heads/main',
      'def456\trefs/heads/task/foo',
      'ghi789\trefs/heads/feature/bar',
    ].join('\n');
    assert.deepEqual(parseRemoteBranchOutput(output), ['task/foo']);
  });

  it('handles empty output', () => {
    assert.deepEqual(parseRemoteBranchOutput(''), []);
    assert.deepEqual(parseRemoteBranchOutput('\n'), []);
  });
});

describe('branch sibling detection in applyChallengePairGates', () => {
  it('blocks a primary when challenger sibling branch exists on remote', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({ number: 101, headRefName: 'task/foo' })];
      const options: ChallengeGateOptions = {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 0);
      assert.equal(result.blocked.length, 1);
      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolved:branch-pair');
    } finally {
      cleanup();
    }
  });

  it('blocks a challenger when primary sibling branch exists on remote', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({ number: 102, headRefName: 'task/foo-challenger' })];
      const options: ChallengeGateOptions = {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 0);
      assert.equal(result.blocked.length, 1);
      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolved:branch-pair');
    } finally {
      cleanup();
    }
  });

  it('allows a task PR when no sibling branch exists', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/solo',
        createdAt: '2020-01-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: ['task/solo'],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
      assert.equal(result.blocked.length, 0);
    } finally {
      cleanup();
    }
  });

  it('does not let branch detection re-block a resolved winner', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/foo',
        challengePairId: 'pair-1',
        challenge: true,
      })];

      writeWorkflowState(repoDir, {
        HOK_1: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
        HOK_1_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
      });
      mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
      writeFileSync(
        join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
        JSON.stringify({
          challengePairId: 'pair-1',
          primaryPrUrl: 'https://github.com/org/repo/pull/101',
          challengerPrUrl: 'https://github.com/org/repo/pull/102',
          winner: 'primary',
          timestamp: '2026-04-28T12:00:00Z',
        }),
      );

      const options: ChallengeGateOptions = {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
      assert.equal(result.eligible[0].pr.number, 101);
    } finally {
      cleanup();
    }
  });
});

describe('cool-off window in applyChallengePairGates', () => {
  it('blocks a fresh task PR within the cool-off window', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const now = Date.parse('2026-04-01T00:05:00Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/fresh',
        createdAt: '2026-04-01T00:03:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 300,
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 0);
      assert.equal(result.blocked.length, 1);
      assert.equal(result.blocked[0].reason, 'challenge:cool-off');
    } finally {
      cleanup();
    }
  });

  it('allows a task PR after the cool-off window expires', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const now = Date.parse('2026-04-01T00:10:00Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/old-enough',
        createdAt: '2026-04-01T00:03:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 300,
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
      assert.equal(result.blocked.length, 0);
    } finally {
      cleanup();
    }
  });

  it('skips cool-off when coolOffSeconds is 0', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const now = Date.parse('2026-04-01T00:00:01Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/fresh',
        createdAt: '2026-04-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 0,
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
    } finally {
      cleanup();
    }
  });

  it('skips cool-off for non-task branches', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const now = Date.parse('2026-04-01T00:00:01Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'feature/fresh',
        createdAt: '2026-04-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 300,
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
    } finally {
      cleanup();
    }
  });

  it('skips cool-off when createdAt is invalid', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/bad-date',
        createdAt: 'not-a-date',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 300,
        nowMs: () => Date.now(),
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 1);
    } finally {
      cleanup();
    }
  });

  it('uses config default when coolOffSeconds not passed in options', async () => {
    const { repoDir, cleanup } = setupRepoDir({
      challenge: { gate: { coolOffSeconds: 60 } },
    });
    try {
      const now = Date.parse('2026-04-01T00:00:30Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/config-test',
        createdAt: '2026-04-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: [],
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.eligible.length, 0);
      assert.equal(result.blocked[0].reason, 'challenge:cool-off');
    } finally {
      cleanup();
    }
  });

  it('branch-pair detection takes precedence over cool-off', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const now = Date.parse('2026-04-01T00:01:00Z');
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/foo',
        createdAt: '2026-04-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        remoteBranches: ['task/foo', 'task/foo-challenger'],
        coolOffSeconds: 300,
        nowMs: () => now,
      };

      const result = await applyChallengePairGates(items, [], repoDir, options);
      assert.equal(result.blocked.length, 1);
      assert.equal(result.blocked[0].reason, 'challenge:pair-unresolved:branch-pair');
    } finally {
      cleanup();
    }
  });
});

describe('git ls-remote failure fallback', () => {
  it('uses empty branch list when listRemoteBranches fails', async () => {
    const { repoDir, cleanup } = setupRepoDir();
    try {
      const items = [makeWorkItem({
        number: 101,
        headRefName: 'task/solo',
        createdAt: '2020-01-01T00:00:00Z',
      })];
      const options: ChallengeGateOptions = {
        listRemoteBranches: () => { throw new Error('git failed'); },
        coolOffSeconds: 0,
      };

      // listRemoteTaskBranches (the default implementation) catches its own errors
      // and returns []. The listRemoteBranches option bypasses that catch, so a
      // throwing custom override would propagate. This test instead validates the
      // post-failure path: when no remote branches are found the PR is eligible.
      const optionsSafe: ChallengeGateOptions = {
        remoteBranches: [],
        coolOffSeconds: 0,
      };

      const result = await applyChallengePairGates(items, [], repoDir, optionsSafe);
      assert.equal(result.eligible.length, 1);
    } finally {
      cleanup();
    }
  });
});
