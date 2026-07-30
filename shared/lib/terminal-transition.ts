import type { FeatureState } from './feature-state.ts';

export type TerminalTransitionType =
  | 'pr-created'
  | 'pr-ready'
  | 'pr-merged'
  | 'pr-closed-unmerged'
  | 'challenge-resolved'
  | 'operator-abort'
  | 'recovery';

export type TerminalSourceOfTruth = 'github' | 'workflow-state' | 'hook' | 'challenge-result';

export interface TerminalTransition {
  type: TerminalTransitionType;
  sourceOfTruth: TerminalSourceOfTruth;
  issueId: string;
  prNumber?: number;
  challengePairId?: string;
  details: Record<string, unknown>;
}

export type ReconcileResult =
  | { status: 'reconciled'; changed: string[] }
  | { status: 'idempotent'; reason: string }
  | { status: 'skipped'; reason: string }
  | { status: 'conflict'; reason: string };

export type PrTerminalState = 'merged' | 'closed-unmerged';
export type ChallengeRole = 'primary' | 'challenger';
export type LinearTerminalState = 'Done' | 'Backlog' | 'Canceled' | null;

export interface ChallengeTerminalContext {
  isChallenge: boolean;
  role?: ChallengeRole | string | null;
  siblingPr?: string | number | null;
  siblingPrState?: 'OPEN' | 'CLOSED' | 'MERGED' | string | null;
  siblingMerged?: boolean;
  comparisonOutcome?: string | null;
  comparisonWinner?: ChallengeRole | string | null;
  intentionallyInvalid?: boolean;
}

export interface ClosedPrLinearDecision {
  state: LinearTerminalState;
  reason:
    | 'standalone-closed'
    | 'challenge-winner-merged'
    | 'challenge-sibling-active'
    | 'challenge-sibling-missing'
    | 'challenge-both-closed'
    | 'challenge-invalid'
    | 'challenge-no-comparison'
    | 'challenge-loser';
}

export function isTerminal(state: Pick<FeatureState, 'currentPhase' | 'normalizedState' | 'outcome'>): boolean {
  if (state.currentPhase === 'done' || state.currentPhase === 'aborted') return true;
  if (state.normalizedState === 'failed' || state.normalizedState === 'aborted') return true;
  return state.outcome.completed === true;
}

export function detectPrTerminal(pr: { state?: string | null; mergedAt?: string | null } | null | undefined): PrTerminalState | null {
  if (!pr) return null;
  if (pr.mergedAt || pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed-unmerged';
  return null;
}

export function decideClosedPrLinearState(context: ChallengeTerminalContext): ClosedPrLinearDecision {
  if (!context.isChallenge) {
    return { state: 'Backlog', reason: 'standalone-closed' };
  }

  if (context.intentionallyInvalid) {
    return { state: 'Canceled', reason: 'challenge-invalid' };
  }

  const outcome = context.comparisonOutcome ?? '';
  const winner = context.comparisonWinner ?? '';
  if (outcome === 'winner' || outcome === 'forfeit') {
    if (winner && context.role && winner === context.role) {
      return { state: 'Done', reason: 'challenge-winner-merged' };
    }
    return { state: 'Canceled', reason: 'challenge-loser' };
  }
  if (outcome === 'double-forfeit') {
    return { state: 'Canceled', reason: 'challenge-no-comparison' };
  }

  if (context.siblingMerged || context.siblingPrState === 'MERGED') {
    return { state: 'Done', reason: 'challenge-winner-merged' };
  }
  if (!context.siblingPr) {
    return { state: null, reason: 'challenge-sibling-missing' };
  }
  if (context.siblingPrState === 'CLOSED') {
    return { state: 'Backlog', reason: 'challenge-both-closed' };
  }
  return { state: null, reason: 'challenge-sibling-active' };
}
