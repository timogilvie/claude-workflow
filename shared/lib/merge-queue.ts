export type MergeQueueState = 'ready' | 'ready-stale' | 'merge-candidate';

export interface MergeQueuePr {
  issue: string;
  slug: string;
  prNumber: number;
  branch: string;
  readyBaseSha?: string;
  queueState?: MergeQueueState;
  changedFiles?: string[];
  readyAt?: string;
  unblocksCount?: number;
  candidatePromotedAt?: string;
  candidateLastProgressAt?: string;
  candidateSkippedAt?: string;
  workflowStatus?: string;
  prState?: string;
}

export const TERMINAL_WORKFLOW_STATUSES = new Set(['merged', 'completed-external', 'aborted']);

export function isTerminalWorkflowStatus(status?: string): boolean {
  return typeof status === 'string' && TERMINAL_WORKFLOW_STATUSES.has(status);
}

export function isClosedOrMergedPrState(prState?: string): boolean {
  if (typeof prState !== 'string' || prState === '') return false;
  const normalized = prState.toLowerCase();
  return normalized === 'merged' || normalized === 'closed';
}

export function isSelectableMergeQueuePr(pr: Pick<MergeQueuePr, 'workflowStatus' | 'prState'>): boolean {
  if (isTerminalWorkflowStatus(pr.workflowStatus)) return false;
  if (isClosedOrMergedPrState(pr.prState)) return false;
  return true;
}

export interface MergeQueueConfigResolved {
  enabled: boolean;
  maxConcurrentCandidates: number;
  stuckTimeoutSeconds: number;
  conflictGroupingEnabled: boolean;
  skipCooldownSeconds: number;
}

export interface MergeQueueTickPlan {
  stuckIssues: string[];
  selectedIssues: string[];
}

function timestampMs(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function overlaps(left?: string[], right?: string[]): boolean {
  const leftKnown = Array.isArray(left) && left.length > 0;
  const rightKnown = Array.isArray(right) && right.length > 0;
  if (!leftKnown && !rightKnown) return true;
  if (!leftKnown || !rightKnown) return false;
  const rightSet = new Set(right);
  return left.some((file) => rightSet.has(file));
}

function comparePriority(left: MergeQueuePr, right: MergeQueuePr): number {
  const unblocksDelta = (right.unblocksCount ?? 0) - (left.unblocksCount ?? 0);
  if (unblocksDelta !== 0) return unblocksDelta;

  const leftFileCount = left.changedFiles?.length ?? Number.MAX_SAFE_INTEGER;
  const rightFileCount = right.changedFiles?.length ?? Number.MAX_SAFE_INTEGER;
  if (leftFileCount !== rightFileCount) return leftFileCount - rightFileCount;

  const readyDelta = timestampMs(left.readyAt) - timestampMs(right.readyAt);
  if (readyDelta !== 0) return readyDelta;

  return left.issue.localeCompare(right.issue);
}

export function computeConflictGroups(prs: MergeQueuePr[]): MergeQueuePr[][] {
  const visited = new Set<string>();
  const groups: MergeQueuePr[][] = [];
  const index = new Map(prs.map((pr) => [pr.issue, pr]));

  for (const pr of prs) {
    if (visited.has(pr.issue)) continue;
    const group: MergeQueuePr[] = [];
    const queue = [pr.issue];
    visited.add(pr.issue);

    while (queue.length > 0) {
      const issue = queue.shift();
      if (!issue) continue;
      const current = index.get(issue);
      if (!current) continue;
      group.push(current);

      for (const candidate of prs) {
        if (visited.has(candidate.issue)) continue;
        if (overlaps(current.changedFiles, candidate.changedFiles)) {
          visited.add(candidate.issue);
          queue.push(candidate.issue);
        }
      }
    }

    groups.push(group.sort(comparePriority));
  }

  return groups.sort((left, right) => comparePriority(left[0], right[0]));
}

export function isCandidateStuck(
  candidate: Pick<MergeQueuePr, 'candidateLastProgressAt' | 'candidatePromotedAt'>,
  now: string,
  config: Pick<MergeQueueConfigResolved, 'stuckTimeoutSeconds'>,
): boolean {
  const lastProgress = timestampMs(candidate.candidateLastProgressAt) || timestampMs(candidate.candidatePromotedAt);
  if (lastProgress <= 0) return false;
  return timestampMs(now) - lastProgress >= config.stuckTimeoutSeconds * 1000;
}

function coolingDown(pr: MergeQueuePr, now: string, config: Pick<MergeQueueConfigResolved, 'skipCooldownSeconds'>): boolean {
  if (!pr.candidateSkippedAt) return false;
  if (config.skipCooldownSeconds <= 0) return false;
  const skippedAt = timestampMs(pr.candidateSkippedAt);
  if (skippedAt <= 0) return false;
  return timestampMs(now) - skippedAt < config.skipCooldownSeconds * 1000;
}

export function selectMergeCandidates(options: {
  readyPrs: MergeQueuePr[];
  activeCandidates: MergeQueuePr[];
  now: string;
  config: MergeQueueConfigResolved;
}): MergeQueuePr[] {
  const { readyPrs, activeCandidates, now, config } = options;
  const selected = activeCandidates.filter(isSelectableMergeQueuePr).sort(comparePriority).slice(0, config.maxConcurrentCandidates);
  const selectedIssues = new Set(selected.map((pr) => pr.issue));

  const eligible = readyPrs
    .filter(isSelectableMergeQueuePr)
    .filter((pr) => !selectedIssues.has(pr.issue))
    .filter((pr) => !coolingDown(pr, now, config))
    .sort(comparePriority);

  for (const pr of eligible) {
    if (selected.length >= config.maxConcurrentCandidates) break;
    if (config.conflictGroupingEnabled && selected.some((candidate) => overlaps(candidate.changedFiles, pr.changedFiles))) {
      continue;
    }
    selected.push(pr);
    selectedIssues.add(pr.issue);
  }

  return selected;
}

export function markReadyStale(
  pr: Pick<MergeQueuePr, 'readyBaseSha'>,
  currentMainSha: string,
  now: string,
): Record<string, string> {
  return {
    queueState: 'ready-stale',
    staleAt: now,
    staleBaseSha: pr.readyBaseSha ?? '',
    targetBaseSha: currentMainSha,
  };
}

export function promoteCandidate(
  _pr: MergeQueuePr,
  currentMainSha: string,
  now: string,
): Record<string, string> {
  return {
    queueState: 'merge-candidate',
    targetBaseSha: currentMainSha,
    candidatePromotedAt: now,
    candidateLastProgressAt: now,
  };
}

export function demoteCandidate(
  _pr: MergeQueuePr,
  reason: string,
  now: string,
): Record<string, string | null> {
  return {
    queueState: 'ready-stale',
    candidateSkippedAt: now,
    candidateSkipReason: reason,
    candidatePromotedAt: null,
    candidateLastProgressAt: null,
  };
}

export function planMergeQueueTick(options: {
  readyPrs: MergeQueuePr[];
  now: string;
  config: MergeQueueConfigResolved;
}): MergeQueueTickPlan {
  const { readyPrs, now, config } = options;
  const selectablePrs = readyPrs.filter(isSelectableMergeQueuePr);
  const stuckIssues = selectablePrs
    .filter((pr) => pr.queueState === 'merge-candidate')
    .filter((pr) => isCandidateStuck(pr, now, config))
    .map((pr) => pr.issue);

  const activeCandidates = selectablePrs
    .filter((pr) => pr.queueState === 'merge-candidate')
    .filter((pr) => !stuckIssues.includes(pr.issue));
  const eligibleReadyPrs = selectablePrs.filter((pr) => !stuckIssues.includes(pr.issue));

  const selectedIssues = selectMergeCandidates({
    readyPrs: eligibleReadyPrs,
    activeCandidates,
    now,
    config,
  }).map((pr) => pr.issue);

  return { stuckIssues, selectedIssues };
}
