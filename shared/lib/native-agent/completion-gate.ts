export type CodingCompletionBlockedReason =
  | 'dirty_tree'
  | 'commit_policy_unsatisfied'
  | 'checks_policy_unsatisfied';

export interface CompletionGateInput {
  dirtyPaths?: readonly string[];
  commitPolicySatisfied: boolean;
  checksPolicySatisfied: boolean;
}

export interface CompletionGateAccepted {
  status: 'accepted';
}

export interface CompletionGateBlocked {
  status: 'blocked';
  reason: CodingCompletionBlockedReason;
  message: string;
}

export type CompletionGateDecision = CompletionGateAccepted | CompletionGateBlocked;

export function evaluateCodingCompletionGate(
  input: CompletionGateInput,
): CompletionGateDecision {
  const dirtyPaths = input.dirtyPaths?.filter((value) => value.trim().length > 0) ?? [];

  if (dirtyPaths.length > 0) {
    return {
      status: 'blocked',
      reason: 'dirty_tree',
      message: `Completion is blocked until the worktree is clean; found ${dirtyPaths.length} dirty path(s).`,
    };
  }

  if (!input.commitPolicySatisfied) {
    return {
      status: 'blocked',
      reason: 'commit_policy_unsatisfied',
      message: 'Completion is blocked until the commit policy is satisfied.',
    };
  }

  if (!input.checksPolicySatisfied) {
    return {
      status: 'blocked',
      reason: 'checks_policy_unsatisfied',
      message: 'Completion is blocked until the required checks policy is satisfied.',
    };
  }

  return { status: 'accepted' };
}
