import { join } from 'node:path';
import { loadWavemillConfig } from './config.ts';
import {
  appendChallengeComparison,
  buildDoubleForfeitComparison,
  buildForfeitComparison,
  readChallengeComparisons,
  type ChallengeComparison,
} from './challenge-comparison.ts';
import {
  classifyPairUnresolvableState,
  getSiblingBranch,
  listRemoteTaskBranches,
  loadWorkflowStateChallengeData,
  type PairTaskState,
  type TaskEvalState,
  type UnresolvableReason,
} from './tend-challenge-gate.ts';

const ORPHAN_PAIR_GRACE_MS = 60_000;
const DEFAULT_HARD_FAILURE_RETRY_MAX = 2;
const UNKNOWN_PR_NUMBER = 0;
const UNKNOWN_MODEL = 'unknown';

export interface UnresolvablePairInput {
  pairId: string;
  repoDir: string;
  reason?: UnresolvableReason;
  dryRun?: boolean;
  now?: () => Date;
}

export type ResolveOutcome =
  | { status: 'already-resolved'; recordExists: true }
  | {
    status: 'resolved';
    record: ChallengeComparison;
    outcome: 'forfeit' | 'double-forfeit';
    reason: UnresolvableReason;
    dryRun: boolean;
  }
  | { status: 'skipped'; reason: string };

export function resolveUnresolvablePair(input: UnresolvablePairInput): ResolveOutcome {
  const evalsDir = join(input.repoDir, '.wavemill', 'evals');
  const existing = readChallengeComparisons(evalsDir).find((comparison) => comparison.challengePairId === input.pairId);
  if (existing) {
    return { status: 'already-resolved', recordExists: true };
  }

  const workflow = loadWorkflowStateChallengeData(input.repoDir);
  const pairState = workflow.taskStateByPair.get(input.pairId);
  if (!pairState) {
    return { status: 'skipped', reason: `Pair ${input.pairId} is not present in workflow state.` };
  }
  const retryMax = getHardFailureRetryMax(input.repoDir);

  if ((workflow.activeJobsByPair.get(input.pairId) ?? []).length > 0) {
    return { status: 'skipped', reason: `Pair ${input.pairId} still has active eval/comparison work.` };
  }

  const resolvedReason = input.reason ?? detectUnresolvableReason(
    input.pairId,
    input.repoDir,
    pairState,
    workflow.challengePairMap,
    input.now ?? (() => new Date()),
    retryMax,
  );
  if (!resolvedReason) {
    return { status: 'skipped', reason: `Pair ${input.pairId} is not currently unresolvable.` };
  }

  // For aborted pairs, buildResolutionRecord may return null when no arm has a
  // completed eval yet (the survivor may still be working). Surface an
  // accurate skip reason rather than the generic manual-repair message.
  if (resolvedReason === 'both-challenge-aborted' || resolvedReason === 'sibling-challenge-aborted') {
    const primaryCompleted = pairState.primary?.evalCompleted === true;
    const challengerCompleted = pairState.challenger?.evalCompleted === true;
    if (!primaryCompleted && !challengerCompleted) {
      const abortReason = pairState.primary?.challengeAborted ?? pairState.challenger?.challengeAborted ?? resolvedReason;
      return {
        status: 'skipped',
        reason: `Pair ${input.pairId} is quarantined (${abortReason}) but no arm has a completed eval yet; re-run once the surviving arm's eval persists.`,
      };
    }
  }

  const resolution = buildResolutionRecord({
    pairId: input.pairId,
    pairState,
    reason: resolvedReason,
    timestamp: (input.now ?? (() => new Date()))().toISOString(),
    retryMax,
  });
  if (!resolution) {
    return { status: 'skipped', reason: `Pair ${input.pairId} requires manual repair before a terminal record can be written.` };
  }

  if (!input.dryRun) {
    appendChallengeComparison(resolution.record, evalsDir);
  }

  return {
    status: 'resolved',
    record: resolution.record,
    outcome: resolution.outcome,
    reason: resolvedReason,
    dryRun: input.dryRun === true,
  };
}

function detectUnresolvableReason(
  pairId: string,
  repoDir: string,
  pairState: PairTaskState,
  challengePairMap: Map<number, { pairId: string }>,
  now: () => Date,
  retryMax: number,
): UnresolvableReason | null {
  // State-derived reasons (hard-failure exhaustion and challenge aborts) are
  // shared with the merge gate via classifyPairUnresolvableState so the gate
  // and resolver cannot disagree (HOK-2773).
  const stateReason = classifyPairUnresolvableState(pairState, retryMax);
  if (stateReason) {
    return stateReason;
  }

  // Orphan detection is separate: it needs sibling branch/PR evidence that
  // the pair state alone does not carry.
  if (pairState.primary && pairState.challenger) {
    return null;
  }

  const representative = pairState.primary ?? pairState.challenger;
  if (!representative || !isPastOrphanGrace(representative, now)) {
    return null;
  }

  const siblingBranch = representative.branch ? getSiblingBranch(representative.branch) : null;
  const remoteBranches = new Set(listRemoteTaskBranches(repoDir));
  if (siblingBranch && remoteBranches.has(siblingBranch)) {
    return null;
  }

  const otherOpenPrExists = [...challengePairMap.entries()].some(
    ([prNumber, info]) => info.pairId === pairId && prNumber !== representative.prNumber,
  );
  if (otherOpenPrExists) {
    return null;
  }

  return 'orphan-sibling';
}

function isPastOrphanGrace(task: TaskEvalState, now: () => Date): boolean {
  if (task.updatedAt === null) {
    return true;
  }
  return now().getTime() - task.updatedAt >= ORPHAN_PAIR_GRACE_MS;
}

function isHardFailureExhausted(task: TaskEvalState | undefined, retryMax: number): boolean {
  return Boolean(task?.evalFailed && task.evalHardFailureRetryCount >= retryMax);
}

function buildResolutionRecord(input: {
  pairId: string;
  pairState: PairTaskState;
  reason: UnresolvableReason;
  timestamp: string;
  retryMax: number;
}): { record: ChallengeComparison; outcome: 'forfeit' | 'double-forfeit' } | null {
  const primary = input.pairState.primary;
  const challenger = input.pairState.challenger;

  if (input.reason === 'both-challenge-aborted' || input.reason === 'sibling-challenge-aborted') {
    return buildAbortedResolution(input);
  }

  if (input.reason === 'both-eval-hard-failed') {
    return {
      outcome: 'double-forfeit',
      record: buildDoubleForfeitComparison({
        challengePairId: input.pairId,
        primaryModel: getTaskModel(primary),
        challengerModel: getTaskModel(challenger),
        primaryPrUrl: getTaskPrUrl(primary),
        challengerPrUrl: getTaskPrUrl(challenger),
        rationale: 'Both sides exhausted challenge eval hard-failure retries before a comparison could be launched.',
        terminalReason: 'both_eval_hard_failed',
        timestamp: input.timestamp,
      }),
    };
  }

  if (input.reason === 'sibling-eval-hard-failed') {
    const primaryExhausted = isHardFailureExhausted(primary, input.retryMax);
    const challengerExhausted = isHardFailureExhausted(challenger, input.retryMax);
    if (primaryExhausted && challenger?.evalCompleted) {
      return {
        outcome: 'forfeit',
        record: buildForfeitComparison({
          challengePairId: input.pairId,
          primaryModel: getTaskModel(primary),
          challengerModel: getTaskModel(challenger),
          primaryPrUrl: getTaskPrUrl(primary),
          challengerPrUrl: getTaskPrUrl(challenger),
          winner: 'challenger',
          rationale: 'Primary exhausted challenge eval hard-failure retries before persisting an eval record.',
          terminalReason: 'primary_eval_hard_failed',
          timestamp: input.timestamp,
        }),
      };
    }
    if (challengerExhausted && primary?.evalCompleted) {
      return {
        outcome: 'forfeit',
        record: buildForfeitComparison({
          challengePairId: input.pairId,
          primaryModel: getTaskModel(primary),
          challengerModel: getTaskModel(challenger),
          primaryPrUrl: getTaskPrUrl(primary),
          challengerPrUrl: getTaskPrUrl(challenger),
          winner: 'primary',
          rationale: 'Challenger exhausted challenge eval hard-failure retries before persisting an eval record.',
          terminalReason: 'challenger_eval_hard_failed',
          timestamp: input.timestamp,
        }),
      };
    }
    return null;
  }

  const loneSide = primary ?? challenger;
  if (!loneSide) {
    return null;
  }
  if (!loneSide.evalCompleted) {
    return {
      outcome: 'double-forfeit',
      record: buildDoubleForfeitComparison({
        challengePairId: input.pairId,
        primaryModel: getTaskModel(primary),
        challengerModel: getTaskModel(challenger),
        primaryPrUrl: getTaskPrUrl(primary),
        challengerPrUrl: getTaskPrUrl(challenger),
        rationale: 'Challenge pair became orphaned before either side produced a persisted eval/comparison result.',
        terminalReason: 'orphan_pair',
        timestamp: input.timestamp,
      }),
    };
  }

  return {
    outcome: 'forfeit',
    record: buildForfeitComparison({
      challengePairId: input.pairId,
      primaryModel: getTaskModel(primary),
      challengerModel: getTaskModel(challenger),
      primaryPrUrl: getTaskPrUrl(primary),
      challengerPrUrl: getTaskPrUrl(challenger),
      winner: loneSide.role,
      rationale: 'Challenge pair became orphaned before a comparison could be launched; the surviving side wins by forfeit.',
      terminalReason: 'orphan_pair',
      timestamp: input.timestamp,
    }),
  };
}

function getTaskModel(task: TaskEvalState | undefined): string {
  return task?.model?.trim() || UNKNOWN_MODEL;
}

/**
 * `challenge_abort_pair` (wavemill-mill.sh) quarantines BOTH arms with the same
 * `challengeAborted` reason/detail, so the flag alone cannot say which arm
 * actually failed. Persisted evidence can: an arm whose eval completed ran to
 * the end; an arm with no PR never did.
 *
 *  - exactly one side completed its eval and the other never produced a PR
 *      -> forfeit to the completed side
 *  - some side completed but the other also produced a PR (both ran; the
 *    challenge is void without a real comparison)
 *      -> double-forfeit; `challenge-pair-recovery` can supersede it later
 *  - no side has a completed eval yet
 *      -> null (survivor may still be working; writing a terminal record now
 *        would wrongly park a future PR at double-forfeit)
 */
function buildAbortedResolution(input: {
  pairId: string;
  pairState: PairTaskState;
  reason: UnresolvableReason;
  timestamp: string;
}): { record: ChallengeComparison; outcome: 'forfeit' | 'double-forfeit' } | null {
  const primary = input.pairState.primary;
  const challenger = input.pairState.challenger;
  const abortReason = primary?.challengeAborted ?? challenger?.challengeAborted ?? input.reason;
  const primaryCompleted = primary?.evalCompleted === true;
  const challengerCompleted = challenger?.evalCompleted === true;
  const common = {
    challengePairId: input.pairId,
    primaryModel: getTaskModel(primary),
    challengerModel: getTaskModel(challenger),
    primaryPrUrl: getTaskPrUrl(primary),
    challengerPrUrl: getTaskPrUrl(challenger),
    timestamp: input.timestamp,
  };

  if (!primaryCompleted && !challengerCompleted) {
    return null;
  }

  if (primaryCompleted !== challengerCompleted) {
    const winner = primaryCompleted ? 'primary' : 'challenger';
    const loser = winner === 'primary' ? challenger : primary;
    if (!loser || loser.prNumber === null) {
      return {
        outcome: 'forfeit',
        record: buildForfeitComparison({
          ...common,
          winner,
          rationale: `Sibling arm aborted (${abortReason}) before producing a PR; the surviving side wins by forfeit.`,
          terminalReason: winner === 'primary' ? 'challenger_challenge_aborted' : 'primary_challenge_aborted',
        }),
      };
    }
  }

  return {
    outcome: 'double-forfeit',
    record: buildDoubleForfeitComparison({
      ...common,
      rationale: `Challenge pair was quarantined (${abortReason}) after both arms produced work; no winner can be named without a comparison.`,
      terminalReason: 'both_challenge_aborted',
    }),
  };
}

function getTaskPrUrl(task: TaskEvalState | undefined): string {
  const prNumber = task?.prNumber ?? UNKNOWN_PR_NUMBER;
  return `https://github.com/unknown/unknown/pull/${prNumber}`;
}

function getHardFailureRetryMax(repoDir: string): number {
  const fromEnv = Number(process.env.WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES ?? '');
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }

  const raw = loadWavemillConfig(repoDir).challenge?.eval?.retryMaxAttempts;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
    ? raw
    : DEFAULT_HARD_FAILURE_RETRY_MAX;
}
