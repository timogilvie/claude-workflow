import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  auditStaleTaskBranches,
  cleanupStaleTaskBranches,
  type PrRef,
  type StaleBranchDeps,
  type StaleBranchRecord,
} from './stale-task-branches.ts';

function pr(number: number, state: string, mergedAt: string | null = null): PrRef {
  return { number, state, mergedAt, url: `https://github.test/pr/${number}` };
}

function makeDeps(overrides: Partial<StaleBranchDeps> & {
  remoteBranches?: string[];
  prsByBranch?: Record<string, PrRef[]>;
  localBranches?: string[];
  worktrees?: string[];
  active?: string[];
} = {}): StaleBranchDeps {
  return {
    listRemoteTaskBranches: () => overrides.remoteBranches ?? [],
    listPullRequestsForBranch: (branch) => overrides.prsByBranch?.[branch] ?? [],
    localBranchExists: (branch) => new Set(overrides.localBranches ?? []).has(branch),
    worktreeBranches: () => new Set(overrides.worktrees ?? []),
    activeWorkflowBranches: () => new Set(overrides.active ?? []),
    deleteRemoteBranch: overrides.deleteRemoteBranch ?? (() => undefined),
  };
}

describe('auditStaleTaskBranches', () => {
  it('classifies remote task refs by PR state and local liveness', () => {
    const records = auditStaleTaskBranches('/repo', makeDeps({
      remoteBranches: [
        'task/closed',
        'task/local',
        'task/merged',
        'task/no-pr',
        'task/open',
        'feature/not-task',
      ],
      prsByBranch: {
        'task/closed': [pr(12, 'CLOSED')],
        'task/local': [pr(13, 'MERGED', '2026-08-01T00:00:00Z')],
        'task/merged': [pr(11, 'MERGED', '2026-08-01T00:00:00Z')],
        'task/open': [pr(14, 'OPEN')],
      },
      localBranches: ['task/local'],
    }));

    assert.deepEqual(
      Object.fromEntries(records.map((record) => [record.branch, record.status])),
      {
        'task/closed': 'closed-unmerged',
        'task/local': 'local-live',
        'task/merged': 'stale-merged',
        'task/no-pr': 'no-pr',
        'task/open': 'open-pr',
      },
    );
  });

  it('treats worktree and active workflow branches as live', () => {
    const records = auditStaleTaskBranches('/repo', makeDeps({
      remoteBranches: ['task/worktree', 'task/active'],
      prsByBranch: {
        'task/worktree': [pr(21, 'MERGED', '2026-08-01T00:00:00Z')],
        'task/active': [pr(22, 'MERGED', '2026-08-01T00:00:00Z')],
      },
      worktrees: ['task/worktree'],
      active: ['task/active'],
    }));

    const byBranch = Object.fromEntries(records.map((record) => [record.branch, record]));
    assert.equal(byBranch['task/worktree'].status, 'local-live');
    assert.equal(byBranch['task/active'].status, 'local-live');
    assert.match(byBranch['task/worktree'].reasons.join(';'), /worktree/);
    assert.match(byBranch['task/active'].reasons.join(';'), /workflow state/);
  });
});

describe('cleanupStaleTaskBranches', () => {
  const records: StaleBranchRecord[] = [
    { branch: 'task/merged', status: 'stale-merged', prs: [pr(1, 'MERGED')], reasons: [] },
    { branch: 'task/closed', status: 'closed-unmerged', prs: [pr(2, 'CLOSED')], reasons: [] },
    { branch: 'task/open', status: 'open-pr', prs: [pr(3, 'OPEN')], reasons: [] },
    { branch: 'feature/merged', status: 'stale-merged', prs: [pr(4, 'MERGED')], reasons: [] },
  ];

  it('dry-run performs no deletes', () => {
    const deleted: string[] = [];
    const result = cleanupStaleTaskBranches(records, { execute: false }, {
      deleteRemoteBranch: (branch) => { deleted.push(branch); },
    }, '/repo');

    assert.deepEqual(deleted, []);
    assert.equal(result.deleted.length, 0);
    assert.equal(result.skipped.length, records.length);
  });

  it('execute deletes only stale-merged task refs by default', () => {
    const deleted: string[] = [];
    const result = cleanupStaleTaskBranches(records, { execute: true }, {
      deleteRemoteBranch: (branch) => { deleted.push(branch); },
    }, '/repo');

    assert.deepEqual(deleted, ['task/merged']);
    assert.deepEqual(result.deleted, ['task/merged']);
    assert.equal(result.failed.length, 0);
  });

  it('includeClosed adds closed-unmerged task refs', () => {
    const deleted: string[] = [];
    cleanupStaleTaskBranches(records, { execute: true, includeClosed: true }, {
      deleteRemoteBranch: (branch) => { deleted.push(branch); },
    }, '/repo');

    assert.deepEqual(deleted, ['task/merged', 'task/closed']);
  });

  it('reports per-branch failures and continues', () => {
    const result = cleanupStaleTaskBranches(records, { execute: true, includeClosed: true }, {
      deleteRemoteBranch: (branch) => {
        if (branch === 'task/merged') throw new Error('push failed');
      },
    }, '/repo');

    assert.deepEqual(result.deleted, ['task/closed']);
    assert.deepEqual(result.failed, [{ branch: 'task/merged', error: 'push failed' }]);
  });
});
