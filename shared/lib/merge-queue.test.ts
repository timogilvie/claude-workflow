import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeConflictGroups,
  selectMergeCandidates,
  isCandidateStuck,
  demoteCandidate,
  planMergeQueueTick,
  type MergeQueueConfigResolved,
  type MergeQueuePr,
} from './merge-queue.ts';

const config: MergeQueueConfigResolved = {
  enabled: true,
  maxConcurrentCandidates: 2,
  stuckTimeoutSeconds: 900,
  conflictGroupingEnabled: true,
  skipCooldownSeconds: 60,
};

function pr(overrides: Partial<MergeQueuePr>): MergeQueuePr {
  return {
    issue: 'HOK-1',
    slug: 'one',
    prNumber: 1,
    branch: 'task/one',
    queueState: 'ready-stale',
    readyAt: '2026-05-06T12:00:00.000Z',
    unblocksCount: 0,
    changedFiles: ['a.ts'],
    ...overrides,
  };
}

test('same-file overlap selects only one candidate', () => {
  const selected = selectMergeCandidates({
    readyPrs: [pr({ issue: 'HOK-1' }), pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two' })],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-1']);
});

test('disjoint files can select two candidates', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-1', changedFiles: ['a.ts'] }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', changedFiles: ['b.ts'] }),
    ],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-1', 'HOK-2']);
});

test('transitive conflict grouping works', () => {
  const groups = computeConflictGroups([
    pr({ issue: 'HOK-1', changedFiles: ['a.ts'] }),
    pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', changedFiles: ['a.ts', 'b.ts'] }),
    pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['b.ts'] }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((item) => item.issue), ['HOK-1', 'HOK-3', 'HOK-2']);
});

test('maxConcurrentCandidates caps output', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-1', changedFiles: ['a.ts'] }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', changedFiles: ['b.ts'] }),
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['c.ts'] }),
    ],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 2 },
  });
  assert.equal(selected.length, 2);
});

test('priority order honors unblocking count before file count before age', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-1', changedFiles: ['a.ts', 'b.ts'], unblocksCount: 1, readyAt: '2026-05-06T12:00:00.000Z' }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', changedFiles: ['c.ts'], unblocksCount: 2 }),
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['d.ts'], unblocksCount: 1, readyAt: '2026-05-06T11:00:00.000Z' }),
    ],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 3, conflictGroupingEnabled: false },
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-2', 'HOK-3', 'HOK-1']);
});

test('stuck timeout boundary is deterministic', () => {
  assert.equal(
    isCandidateStuck(
      { candidatePromotedAt: '2026-05-06T12:00:00.000Z' },
      '2026-05-06T12:15:00.000Z',
      config,
    ),
    true,
  );
});

test('demotion patch clears candidate promotion state', () => {
  const patch = demoteCandidate(pr({ issue: 'HOK-1' }), 'stuck', '2026-05-06T12:30:00.000Z');
  assert.equal(patch.queueState, 'ready-stale');
  assert.equal(patch.candidatePromotedAt, null);
  assert.equal(patch.candidateLastProgressAt, null);
  assert.equal(patch.candidateSkipReason, 'stuck');
});

test('disabled conflict grouping selects by priority up to max', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-1', changedFiles: ['a.ts'], unblocksCount: 0 }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', changedFiles: ['a.ts'], unblocksCount: 3 }),
    ],
    activeCandidates: [],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, conflictGroupingEnabled: false },
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-2', 'HOK-1']);
});

test('tick planner demotes stuck candidate and promotes disjoint replacement', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-1',
        queueState: 'merge-candidate',
        candidatePromotedAt: '2026-05-06T12:00:00.000Z',
        changedFiles: ['a.ts'],
      }),
      pr({
        issue: 'HOK-2',
        prNumber: 2,
        branch: 'task/two',
        queueState: 'ready-stale',
        changedFiles: ['b.ts'],
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(plan.stuckIssues, ['HOK-1']);
  assert.deepEqual(plan.selectedIssues, ['HOK-2']);
});
