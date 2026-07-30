import { type PullRequest, getPullRequest } from './github.ts';
import { detectPrTerminal, type PrTerminalState } from './terminal-transition.ts';

export interface PrReconciliationState {
  pr: PullRequest;
  terminal: PrTerminalState | null;
}

export const prReconciliationDeps = {
  getPullRequest,
};

export async function fetchPrState(prNumber: number | string, repo?: string): Promise<PrReconciliationState> {
  const pr = prReconciliationDeps.getPullRequest(prNumber, repo ? { repo } : {});
  return { pr, terminal: detectPrTerminal(pr) };
}

export function reconcilePrStateWithHook(
  pr: { state?: string | null; mergedAt?: string | null },
  hook: { state?: string | null } | null | undefined,
): { terminal: PrTerminalState | null; staleLiveHook: boolean } {
  const terminal = detectPrTerminal(pr);
  const staleLiveHook = Boolean(terminal && hook && ['working', 'waiting', 'approval-needed', 'error'].includes(hook.state ?? ''));
  return { terminal, staleLiveHook };
}
