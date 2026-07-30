import assert from 'node:assert/strict';
import test from 'node:test';
import { decideClosedPrLinearState, detectPrTerminal, isTerminal } from './terminal-transition.ts';

test('detectPrTerminal distinguishes merged and closed-unmerged PRs', () => {
  assert.equal(detectPrTerminal({ state: 'OPEN', mergedAt: null }), null);
  assert.equal(detectPrTerminal({ state: 'CLOSED', mergedAt: null }), 'closed-unmerged');
  assert.equal(detectPrTerminal({ state: 'CLOSED', mergedAt: '2026-07-30T12:00:00Z' }), 'merged');
  assert.equal(detectPrTerminal({ state: 'MERGED', mergedAt: null }), 'merged');
});

test('isTerminal treats terminal feature states as terminal', () => {
  assert.equal(isTerminal({ currentPhase: 'ready', normalizedState: 'running', outcome: { completed: false } as any }), false);
  assert.equal(isTerminal({ currentPhase: 'done', normalizedState: 'completed', outcome: { completed: true } as any }), true);
  assert.equal(isTerminal({ currentPhase: 'review', normalizedState: 'failed', outcome: { completed: false } as any }), true);
});

test('closed standalone PR returns Linear to Backlog', () => {
  assert.deepEqual(decideClosedPrLinearState({ isChallenge: false }), {
    state: 'Backlog',
    reason: 'standalone-closed',
  });
});

test('closed challenge PR defers while sibling is active', () => {
  assert.deepEqual(decideClosedPrLinearState({
    isChallenge: true,
    role: 'challenger',
    siblingPr: 102,
    siblingPrState: 'OPEN',
  }), {
    state: null,
    reason: 'challenge-sibling-active',
  });
});

test('closed challenge pair with both sides closed returns one stable backlog outcome', () => {
  assert.deepEqual(decideClosedPrLinearState({
    isChallenge: true,
    role: 'primary',
    siblingPr: 102,
    siblingPrState: 'CLOSED',
  }), {
    state: 'Backlog',
    reason: 'challenge-both-closed',
  });
});

test('closed challenge loser and intentionally invalid challenges are terminalized distinctly', () => {
  assert.deepEqual(decideClosedPrLinearState({
    isChallenge: true,
    role: 'challenger',
    comparisonOutcome: 'winner',
    comparisonWinner: 'primary',
  }), {
    state: 'Canceled',
    reason: 'challenge-loser',
  });
  assert.deepEqual(decideClosedPrLinearState({ isChallenge: true, intentionallyInvalid: true }), {
    state: 'Canceled',
    reason: 'challenge-invalid',
  });
});
