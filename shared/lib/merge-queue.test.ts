import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeConflictGroups,
  selectMergeCandidates,
  isCandidateStuck,
  demoteCandidate,
  planMergeQueueTick,
  isTerminalWorkflowStatus,
  isClosedOrMergedPrState,
  isSelectableMergeQueuePr,
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

// --- Terminal workflow status predicate tests ---

test('isTerminalWorkflowStatus: merged is terminal', () => {
  assert.equal(isTerminalWorkflowStatus('merged'), true);
});

test('isTerminalWorkflowStatus: completed-external is terminal', () => {
  assert.equal(isTerminalWorkflowStatus('completed-external'), true);
});

test('isTerminalWorkflowStatus: aborted is terminal', () => {
  assert.equal(isTerminalWorkflowStatus('aborted'), true);
});

test('isTerminalWorkflowStatus: undefined is not terminal', () => {
  assert.equal(isTerminalWorkflowStatus(undefined), false);
});

test('isTerminalWorkflowStatus: unknown status is not terminal', () => {
  assert.equal(isTerminalWorkflowStatus('coding'), false);
});

test('isClosedOrMergedPrState: MERGED is closed/merged', () => {
  assert.equal(isClosedOrMergedPrState('MERGED'), true);
});

test('isClosedOrMergedPrState: CLOSED is closed/merged', () => {
  assert.equal(isClosedOrMergedPrState('CLOSED'), true);
});

test('isClosedOrMergedPrState: lowercase merged is closed/merged', () => {
  assert.equal(isClosedOrMergedPrState('merged'), true);
});

test('isClosedOrMergedPrState: undefined is not closed/merged', () => {
  assert.equal(isClosedOrMergedPrState(undefined), false);
});

test('isClosedOrMergedPrState: OPEN is not closed/merged', () => {
  assert.equal(isClosedOrMergedPrState('OPEN'), false);
});

test('isSelectableMergeQueuePr: missing both fields is selectable', () => {
  assert.equal(isSelectableMergeQueuePr({}), true);
});

test('isSelectableMergeQueuePr: merged workflow status is not selectable', () => {
  assert.equal(isSelectableMergeQueuePr({ workflowStatus: 'merged' }), false);
});

test('isSelectableMergeQueuePr: CLOSED prState is not selectable', () => {
  assert.equal(isSelectableMergeQueuePr({ prState: 'CLOSED' }), false);
});

// --- Selection: terminal active candidates do not block ready PRs ---

test('terminal active candidates are excluded before slot accounting', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['c.ts'], queueState: 'ready-stale' }),
    ],
    activeCandidates: [
      pr({ issue: 'HOK-1', queueState: 'merge-candidate', workflowStatus: 'merged', changedFiles: ['a.ts'] }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', queueState: 'merge-candidate', workflowStatus: 'merged', changedFiles: ['b.ts'] }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 2 },
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-3']);
});

test('with maxConcurrentCandidates=1, terminal candidates still allow a clean PR', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['c.ts'], queueState: 'ready-stale' }),
    ],
    activeCandidates: [
      pr({ issue: 'HOK-1', queueState: 'merge-candidate', workflowStatus: 'merged', changedFiles: ['a.ts'] }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 1 },
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-3']);
});

test('healthy non-terminal candidates select in priority order', () => {
  const selected = selectMergeCandidates({
    readyPrs: [
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', changedFiles: ['c.ts'], queueState: 'ready-stale' }),
    ],
    activeCandidates: [
      pr({ issue: 'HOK-1', queueState: 'merge-candidate', changedFiles: ['a.ts'] }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config: { ...config, maxConcurrentCandidates: 2 },
  });
  assert.deepEqual(selected.map((item) => item.issue), ['HOK-1', 'HOK-3']);
});

// --- Planner: terminal candidates excluded from selectedIssues and stuckIssues ---

test('planMergeQueueTick excludes terminal candidates from selectedIssues', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({ issue: 'HOK-1', queueState: 'merge-candidate', workflowStatus: 'merged', changedFiles: ['a.ts'], candidatePromotedAt: '2026-05-06T12:20:00.000Z' }),
      pr({ issue: 'HOK-2', prNumber: 2, branch: 'task/two', queueState: 'merge-candidate', workflowStatus: 'completed-external', changedFiles: ['b.ts'], candidatePromotedAt: '2026-05-06T12:20:00.000Z' }),
      pr({ issue: 'HOK-3', prNumber: 3, branch: 'task/three', queueState: 'ready-stale', changedFiles: ['c.ts'] }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(plan.selectedIssues, ['HOK-3']);
  assert.deepEqual(plan.stuckIssues, []);
});

test('terminal stale active candidates do not appear in stuckIssues', () => {
  const plan = planMergeQueueTick({
    readyPrs: [
      pr({
        issue: 'HOK-1',
        queueState: 'merge-candidate',
        workflowStatus: 'merged',
        candidatePromotedAt: '2026-05-06T12:00:00.000Z',
        changedFiles: ['a.ts'],
      }),
    ],
    now: '2026-05-06T12:30:00.000Z',
    config,
  });
  assert.deepEqual(plan.stuckIssues, []);
  assert.deepEqual(plan.selectedIssues, []);
});
