import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateCodingCompletionGate } from './completion-gate.ts';

describe('completion-gate', () => {
  it('blocks completion when the tree is dirty', () => {
    const decision = evaluateCodingCompletionGate({
      dirtyPaths: ['src/app.ts'],
      commitPolicySatisfied: true,
      checksPolicySatisfied: true,
    });

    assert.deepEqual(decision, {
      status: 'blocked',
      reason: 'dirty_tree',
      message: 'Completion is blocked until the worktree is clean; found 1 dirty path(s).',
    });
  });

  it('blocks completion when commit policy is not satisfied', () => {
    const decision = evaluateCodingCompletionGate({
      dirtyPaths: [],
      commitPolicySatisfied: false,
      checksPolicySatisfied: true,
    });

    assert.deepEqual(decision, {
      status: 'blocked',
      reason: 'commit_policy_unsatisfied',
      message: 'Completion is blocked until the commit policy is satisfied.',
    });
  });

  it('blocks completion when checks policy is not satisfied', () => {
    const decision = evaluateCodingCompletionGate({
      dirtyPaths: [],
      commitPolicySatisfied: true,
      checksPolicySatisfied: false,
    });

    assert.deepEqual(decision, {
      status: 'blocked',
      reason: 'checks_policy_unsatisfied',
      message: 'Completion is blocked until the required checks policy is satisfied.',
    });
  });

  it('accepts completion when tree, commit policy, and checks policy are all satisfied', () => {
    const decision = evaluateCodingCompletionGate({
      dirtyPaths: [],
      commitPolicySatisfied: true,
      checksPolicySatisfied: true,
    });

    assert.deepEqual(decision, { status: 'accepted' });
  });
});
