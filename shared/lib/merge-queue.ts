import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';

export type MergeQueueState = 'ready' | 'ready-stale' | 'merge-candidate';
export type MergeQueueCiConclusion = 'pass' | 'fail' | 'pending' | 'unknown' | 'none';

export interface MergeQueueCiState {
  conclusion: MergeQueueCiConclusion;
  headSha?: string;
  mergeStateStatus?: string;
  observedAt?: string;
  failing?: string[];
  observed?: number;
  required?: number;
}

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
  mergeRetryInProgressUntil?: string;
  candidateSkippedAt?: string;
  workflowStatus?: string;
  prState?: string;
  ci?: MergeQueueCiState;
  /** Progress-only telemetry mirrored from the lane-progress record (HOK-2919). */
  lastProgressAt?: string;
  laneWaitSeconds?: number;
  laneHoldSeconds?: number;
  rebaseCount?: number;
  ciRestartCount?: number;
}

/**
 * Named state transitions that count as real merge-lane progress for a PR.
 * Ordinary poll ticks must never be recorded — only these transitions update
 * `lastProgressAt` (HOK-2919 progress-vs-liveness).
 */
export type LaneProgressEvent =
  | 'lane-entered'
  | 'merge-attempt'
  | 'rebase'
  | 'ci-restart'
  | 'stale-base-refresh'
  | 'retry-scheduled'
  | 'merged';

/**
 * Durable per-PR lane residence telemetry. Written by the tend process (which
 * performs rebases, CI restarts, and merges) and mirrored into the merge-queue
 * ready artifacts by the mill monitor so both views can explain queue
 * residence. Also the data source for HOK-2936's reconciliation capsule.
 */
export interface LaneProgressRecord {
  prNumber: number;
  /** First time any lane event was recorded for this PR (lane entry). */
  enteredLaneAt?: string;
  /** Timestamp of the most recent real state transition (never a poll tick). */
  lastProgressAt?: string;
  lastEvent?: LaneProgressEvent;
  /** Seconds between lane entry and the most recent progress event. */
  laneHoldSeconds?: number;
  /** Seconds between ready verdict and lane entry, when readyAt is known. */
  laneWaitSeconds?: number;
  rebaseCount?: number;
  ciRestartCount?: number;
  mergeAttemptCount?: number;
}

/** Directory holding all per-PR strict-lane state (retry budget, progress). */
export function mergeLaneStateDir(prNumber: number | string, repoDir: string): string {
  return join(repoDir, '.wavemill', 'merge-lane', String(prNumber));
}

export function laneProgressPath(prNumber: number | string, repoDir: string): string {
  return join(mergeLaneStateDir(prNumber, repoDir), 'progress.json');
}

/**
 * Record one lane-progress event for a PR. Uses the shared JSON state mutex so
 * concurrent tend/monitor writers serialize. Counter fields only move on their
 * matching events; `lastProgressAt` moves on every recorded event.
 */
export async function recordLaneProgress(
  prNumber: number,
  repoDir: string,
  event: LaneProgressEvent,
  options: { now?: string; readyAt?: string } = {},
): Promise<LaneProgressRecord> {
  const now = options.now ?? new Date().toISOString();
  return mutateJsonState<LaneProgressRecord>(
    laneProgressPath(prNumber, repoDir),
    (current) => {
      const record: LaneProgressRecord = { ...(current ?? { prNumber }) };
      record.prNumber = prNumber;
      if (!record.enteredLaneAt) {
        record.enteredLaneAt = now;
        const readyAtMs = timestampMs(options.readyAt);
        const enteredMs = timestampMs(now);
        if (readyAtMs > 0 && enteredMs >= readyAtMs) {
          record.laneWaitSeconds = Math.round((enteredMs - readyAtMs) / 1000);
        }
      }
      record.lastProgressAt = now;
      record.lastEvent = event;
      const enteredMs = timestampMs(record.enteredLaneAt);
      const nowMs = timestampMs(now);
      if (enteredMs > 0 && nowMs >= enteredMs) {
        record.laneHoldSeconds = Math.round((nowMs - enteredMs) / 1000);
      }
      if (event === 'rebase' || event === 'stale-base-refresh') {
        record.rebaseCount = (record.rebaseCount ?? 0) + 1;
      }
      if (event === 'ci-restart' || event === 'stale-base-refresh') {
        record.ciRestartCount = (record.ciRestartCount ?? 0) + 1;
      }
      if (event === 'merge-attempt') {
        record.mergeAttemptCount = (record.mergeAttemptCount ?? 0) + 1;
      }
      return record;
    },
    { createIfMissing: true, initial: { prNumber } },
  );
}

/** Read the lane-progress record, or null when absent/unreadable. */
export function readLaneProgress(prNumber: number | string, repoDir: string): LaneProgressRecord | null {
  const path = laneProgressPath(prNumber, repoDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as LaneProgressRecord).prNumber !== 'number') {
      return null;
    }
    return parsed as LaneProgressRecord;
  } catch {
    return null;
  }
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

export function isCiGreen(pr: Pick<MergeQueuePr, 'ci'>): boolean {
  if (pr.ci?.conclusion !== 'pass') return false;
  const mergeStateStatus = pr.ci.mergeStateStatus ?? '';
  return !['BLOCKED', 'DIRTY', 'UNSTABLE'].includes(mergeStateStatus);
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
  ciBlockedIssues: string[];
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
  candidate: Pick<MergeQueuePr, 'candidateLastProgressAt' | 'candidatePromotedAt' | 'mergeRetryInProgressUntil' | 'lastProgressAt'>,
  now: string,
  config: Pick<MergeQueueConfigResolved, 'stuckTimeoutSeconds'>,
): boolean {
  if (timestampMs(candidate.mergeRetryInProgressUntil) > timestampMs(now)) {
    return false;
  }
  // lastProgressAt is tend's lane-progress stamp (rebases, CI restarts,
  // stale-base refreshes). A candidate tend is actively recovering must not be
  // demoted as stuck by the independent queue process (HOK-2919).
  const lastProgress = Math.max(
    timestampMs(candidate.candidateLastProgressAt),
    timestampMs(candidate.lastProgressAt),
  ) || timestampMs(candidate.candidatePromotedAt);
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
  const selected = activeCandidates
    .filter(isSelectableMergeQueuePr)
    .filter(isCiGreen)
    .sort(comparePriority)
    .slice(0, config.maxConcurrentCandidates);
  const selectedIssues = new Set(selected.map((pr) => pr.issue));

  const eligible = readyPrs
    .filter(isSelectableMergeQueuePr)
    .filter(isCiGreen)
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
    mergeRetryInProgressUntil: null,
  };
}

export function planMergeQueueTick(options: {
  readyPrs: MergeQueuePr[];
  now: string;
  config: MergeQueueConfigResolved;
}): MergeQueueTickPlan {
  const { readyPrs, now, config } = options;
  const selectablePrs = readyPrs.filter(isSelectableMergeQueuePr);
  const ciBlockedIssues = selectablePrs
    .filter((pr) => pr.queueState === 'merge-candidate')
    .filter((pr) => pr.ci?.conclusion === 'fail')
    .map((pr) => pr.issue);
  const stuckIssues = selectablePrs
    .filter((pr) => pr.queueState === 'merge-candidate')
    .filter((pr) => !ciBlockedIssues.includes(pr.issue))
    .filter((pr) => isCandidateStuck(pr, now, config))
    .map((pr) => pr.issue);

  const activeCandidates = selectablePrs
    .filter((pr) => pr.queueState === 'merge-candidate')
    .filter((pr) => !ciBlockedIssues.includes(pr.issue))
    .filter((pr) => !stuckIssues.includes(pr.issue));
  const eligibleReadyPrs = selectablePrs.filter((pr) => !stuckIssues.includes(pr.issue));

  const selectedIssues = selectMergeCandidates({
    readyPrs: eligibleReadyPrs,
    activeCandidates,
    now,
    config,
  }).map((pr) => pr.issue);

  return { stuckIssues, selectedIssues, ciBlockedIssues };
}
