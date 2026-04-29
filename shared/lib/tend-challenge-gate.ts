import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readChallengeComparisons, type StoredChallengeComparison } from './challenge-comparison.ts';
import { getChallengeConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';
import type { PrMetadata } from './pr-metadata.ts';
import { WM_LABELS } from './pr-state-labels.ts';

type ChallengeRole = 'primary' | 'challenger';

interface ChallengePairInfo {
  pairId: string;
  role: ChallengeRole;
}

interface WorkflowStateTask {
  pr?: unknown;
  challengePairId?: unknown;
  challengeRole?: unknown;
}

interface WorkflowStateFile {
  tasks?: Record<string, WorkflowStateTask>;
}

interface ChallengeEligiblePr {
  number: number;
  title: string;
  headRefName: string;
  labels: Array<{ name: string }>;
}

export interface ChallengeEligibleWorkItem {
  pr: ChallengeEligiblePr;
  metadata: PrMetadata;
}

export interface ChallengeBlockedCandidate {
  number: number;
  title: string;
  headBranch: string;
  reason: string;
}

export type ChallengeGate =
  | { kind: 'not-in-challenge' }
  | { kind: 'pair-unresolved'; pairId: string; otherPr: number | null; reason: string }
  | { kind: 'winner'; pairId: string; loserPr: number | null; autoMerge: boolean }
  | { kind: 'loser'; pairId: string; winnerPr: number | null };

export function loadWorkflowStateChallengePairs(repoDir: string): Map<number, ChallengePairInfo> {
  const statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  if (!existsSync(statePath)) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as WorkflowStateFile;
    const tasks = parsed.tasks ?? {};
    const pairs = new Map<number, ChallengePairInfo>();

    for (const task of Object.values(tasks)) {
      if (
        typeof task.pr === 'number' &&
        typeof task.challengePairId === 'string' &&
        (task.challengeRole === 'primary' || task.challengeRole === 'challenger')
      ) {
        pairs.set(task.pr, { pairId: task.challengePairId, role: task.challengeRole });
      }
    }

    return pairs;
  } catch (error) {
    console.warn(`[tend-challenge-gate] Failed to read workflow-state.json: ${errorMessage(error)}`);
    return new Map();
  }
}

export function classifyChallengeState(
  prNumber: number,
  metadata: PrMetadata | null,
  challengePairMap: Map<number, ChallengePairInfo>,
  comparisons: StoredChallengeComparison[],
  autoMerge: boolean,
  allPrNumbers: Set<number>,
): ChallengeGate {
  const workflowStatePair = challengePairMap.get(prNumber);
  const pairId = metadata?.challengePairId ?? workflowStatePair?.pairId;

  if (!pairId) {
    return { kind: 'not-in-challenge' };
  }

  if (
    metadata?.challengePairId &&
    workflowStatePair?.pairId &&
    metadata.challengePairId !== workflowStatePair.pairId
  ) {
    console.warn(
      `[tend-challenge-gate] PR #${prNumber} pair mismatch: metadata=${metadata.challengePairId} workflow=${workflowStatePair.pairId}`,
    );
  }

  const relevantComparisons = comparisons
    .filter((comparison) => comparison.challengePairId === pairId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (relevantComparisons.length === 0) {
    return {
      kind: 'pair-unresolved',
      pairId,
      otherPr: findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
      reason: 'pair-unresolved:no-comparison',
    };
  }

  const latestComparison = relevantComparisons[0];
  if (relevantComparisons.some((comparison) => comparison.winner !== latestComparison.winner)) {
    console.warn(
      `[tend-challenge-gate] Pair ${pairId} has conflicting comparison winners; using latest record at ${latestComparison.timestamp}`,
    );
  }

  const role = resolvePrRole(prNumber, latestComparison, workflowStatePair?.role);
  if (!role) {
    return {
      kind: 'pair-unresolved',
      pairId,
      otherPr: findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
      reason: 'pair-unresolved:unknown-role',
    };
  }

  const winnerPr = latestComparison.winner === 'primary'
    ? parsePrNumberFromUrl(latestComparison.primaryPrUrl)
    : parsePrNumberFromUrl(latestComparison.challengerPrUrl);
  const loserPr = latestComparison.winner === 'primary'
    ? parsePrNumberFromUrl(latestComparison.challengerPrUrl)
    : parsePrNumberFromUrl(latestComparison.primaryPrUrl);

  if (role === latestComparison.winner) {
    return {
      kind: 'winner',
      pairId,
      loserPr: loserPr ?? findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
      autoMerge,
    };
  }

  return {
    kind: 'loser',
    pairId,
    winnerPr: winnerPr ?? findOtherOpenPr(pairId, prNumber, challengePairMap, allPrNumbers),
  };
}

export function applyChallengePairGates<T extends ChallengeEligibleWorkItem>(
  eligibleItems: T[],
  blocked: ChallengeBlockedCandidate[],
  repoDir: string,
): { eligible: T[]; blocked: ChallengeBlockedCandidate[]; losers: number[] } {
  const allPrNumbers = new Set([
    ...eligibleItems.map((item) => item.pr.number),
    ...blocked.map((item) => item.number),
  ]);
  const challengePairMap = loadWorkflowStateChallengePairs(repoDir);

  let comparisons: StoredChallengeComparison[];
  try {
    comparisons = readChallengeComparisons(join(repoDir, '.wavemill', 'evals'));
  } catch (error) {
    console.warn(`[tend-challenge-gate] Failed to read challenge comparisons: ${errorMessage(error)}`);
    comparisons = [];
  }

  const autoMerge = getChallengeConfig(repoDir).autoMergeWinner ?? true;
  const nextEligible: T[] = [];
  const nextBlocked = [...blocked];
  const losers = new Set<number>();

  for (const item of eligibleItems) {
    const state = classifyChallengeState(
      item.pr.number,
      item.metadata,
      challengePairMap,
      comparisons,
      autoMerge,
      allPrNumbers,
    );

    if (state.kind === 'not-in-challenge') {
      nextEligible.push(item);
      continue;
    }

    if (state.kind === 'pair-unresolved') {
      nextBlocked.push(toBlockedCandidate(item, `challenge:${state.reason}`));
      continue;
    }

    if (state.kind === 'winner') {
      if (state.autoMerge) {
        nextEligible.push(item);
      } else {
        nextBlocked.push(toBlockedCandidate(item, `challenge:winner-held:${state.pairId}`));
      }
      continue;
    }

    nextBlocked.push(toBlockedCandidate(item, `challenge:loser:${state.pairId}`));
    if (!labelSet(item.pr).has(WM_LABELS.superseded)) {
      losers.add(item.pr.number);
    }
  }

  return { eligible: nextEligible, blocked: nextBlocked, losers: [...losers] };
}

function labelSet(pr: ChallengeEligiblePr): Set<string> {
  return new Set(pr.labels.map((label) => label.name));
}

function toBlockedCandidate(item: ChallengeEligibleWorkItem, reason: string): ChallengeBlockedCandidate {
  return {
    number: item.pr.number,
    title: item.pr.title,
    headBranch: item.pr.headRefName,
    reason,
  };
}

function findOtherOpenPr(
  pairId: string,
  prNumber: number,
  challengePairMap: Map<number, ChallengePairInfo>,
  allPrNumbers: Set<number>,
): number | null {
  for (const [candidatePr, pair] of challengePairMap.entries()) {
    if (candidatePr !== prNumber && pair.pairId === pairId && allPrNumbers.has(candidatePr)) {
      return candidatePr;
    }
  }

  return null;
}

function resolvePrRole(
  prNumber: number,
  comparison: StoredChallengeComparison,
  workflowRole: ChallengeRole | undefined,
): ChallengeRole | null {
  const primaryPr = parsePrNumberFromUrl(comparison.primaryPrUrl);
  const challengerPr = parsePrNumberFromUrl(comparison.challengerPrUrl);

  if (primaryPr === prNumber) {
    return 'primary';
  }

  if (challengerPr === prNumber) {
    return 'challenger';
  }

  return workflowRole ?? null;
}

function parsePrNumberFromUrl(url: string | undefined): number | null {
  if (!url) {
    return null;
  }

  const match = /\/pull\/(\d+)(?:\/|$)/.exec(url);
  if (!match) {
    return null;
  }

  const prNumber = Number(match[1]);
  return Number.isInteger(prNumber) ? prNumber : null;
}

