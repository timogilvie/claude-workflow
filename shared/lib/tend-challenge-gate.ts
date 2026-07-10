import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readChallengeComparisons, type StoredChallengeComparison } from './challenge-comparison.ts';
import { getChallengeConfig, getChallengeGateConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';
import { listOpenIssuesByIdentifierPrefix, type LinearIssueSummary } from './linear.ts';
import type { PrMetadata } from './pr-metadata.ts';
import { WM_LABELS } from './pr-state-labels.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';

type ChallengeRole = 'primary' | 'challenger';
const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const TASK_IDENTIFIER_PATTERN = /^[A-Z]+-\d+(?:_c)?$/;

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
  createdAt: string;
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

export interface ChallengeGateDeps {
  linearSiblingLookup?: (identifierRoot: string) => Promise<LinearIssueSummary[]>;
  branchExists?: (branch: string, repoDir: string) => boolean | Promise<boolean>;
}

interface ChallengeGateRuntimeDeps {
  linearSiblingLookup: (identifierRoot: string) => Promise<LinearIssueSummary[]>;
  branchExists: (branch: string, repoDir: string) => Promise<boolean>;
  linearCache: Map<string, Promise<LinearIssueSummary[]>>;
  branchCache: Map<string, Promise<boolean>>;
}

type PendingSignal =
  | { kind: 'linear-sibling'; value: string }
  | { kind: 'branch-twin'; value: string };

type PendingSignalResult =
  | { kind: 'none' }
  | { kind: 'signals'; signals: PendingSignal[] }
  | { kind: 'lookup-error'; source: 'linear' | 'branch'; message: string };

/** Options for overriding gate behaviour in tests or specialized callers. */
export interface ChallengeGateOptions extends ChallengeGateDeps {
  /** Returns current epoch-ms; defaults to Date.now(). */
  nowMs?: () => number;
  /** Minimum age (seconds) a PR must reach before it is eligible for tend. */
  coolOffSeconds?: number;
  /** Pre-fetched list of remote branch names (skips git ls-remote call). */
  remoteBranches?: string[];
  /** Custom remote-branch lister; replaces the default git ls-remote call. */
  listRemoteBranches?: (repoDir: string) => string[];
}

export type ChallengeGate =
  | { kind: 'not-in-challenge' }
  | { kind: 'pair-unresolved'; pairId: string; otherPr: number | null; reason: string }
  | { kind: 'cool-off'; reason: string }
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
      const prNumber = parseWorkflowStatePr(task.pr);
      if (
        prNumber !== null &&
        typeof task.challengePairId === 'string' &&
        (task.challengeRole === 'primary' || task.challengeRole === 'challenger')
      ) {
        pairs.set(prNumber, { pairId: task.challengePairId, role: task.challengeRole });
      }
    }

    return pairs;
  } catch (error) {
    console.warn(`[tend-challenge-gate] Failed to read workflow-state.json: ${errorMessage(error)}`);
    return new Map();
  }
}

function parseWorkflowStatePr(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }

  return null;
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
  if (latestComparison.comparisonOutcome === 'double-forfeit') {
    return {
      kind: 'loser',
      pairId,
      winnerPr: null,
    };
  }

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

export async function applyChallengePairGates<T extends ChallengeEligibleWorkItem>(
  eligibleItems: T[],
  blocked: ChallengeBlockedCandidate[],
  repoDir: string,
  options: ChallengeGateOptions = {},
): Promise<{ eligible: T[]; blocked: ChallengeBlockedCandidate[]; losers: number[] }> {
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
  const gateConfig = getChallengeGateConfig(repoDir);
  const coolOffSeconds = options.coolOffSeconds ?? gateConfig.coolOffSeconds;
  const nowMs = options.nowMs ?? (() => Date.now());

  const remoteBranches = options.remoteBranches
    ?? (options.listRemoteBranches
      ? options.listRemoteBranches(repoDir)
      : listRemoteTaskBranches(repoDir));
  const remoteBranchSet = new Set(remoteBranches);
  const runtimeDeps = createRuntimeDeps(options, async (branch) => remoteBranchSet.has(branch));

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
      const sibling = getSiblingBranch(item.pr.headRefName);
      if (sibling && remoteBranchSet.has(sibling)) {
        nextBlocked.push(toBlockedCandidate(item, 'challenge:pair-unresolved:branch-pair'));
        continue;
      }

      const pendingSignals = await detectPendingChallengeSignals(item, repoDir, runtimeDeps);
      if (pendingSignals.kind === 'lookup-error') {
        console.warn(
          `[tend-challenge-gate] Lookup failed for PR #${item.pr.number} (${pendingSignals.source}): ${pendingSignals.message}`,
        );
        nextBlocked.push(toBlockedCandidate(item, `challenge:pair-unresolved:lookup-error:${pendingSignals.source}`));
        continue;
      }

      if (pendingSignals.kind === 'signals') {
        nextBlocked.push(toBlockedCandidate(item, `challenge:${formatPendingSignalReason(pendingSignals.signals)}`));
        continue;
      }

      if (coolOffSeconds > 0 && item.pr.headRefName.startsWith('task/')) {
        const createdMs = Date.parse(item.pr.createdAt);
        if (!Number.isNaN(createdMs) && nowMs() - createdMs < coolOffSeconds * 1000) {
          nextBlocked.push(toBlockedCandidate(item, 'challenge:cool-off'));
          continue;
        }
      }

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

function createRuntimeDeps(
  deps: ChallengeGateDeps,
  defaultBranchLookup: (branch: string, repoDir: string) => Promise<boolean>,
): ChallengeGateRuntimeDeps {
  return {
    linearSiblingLookup: deps.linearSiblingLookup ?? defaultLinearSiblingLookup,
    branchExists: async (branch, repoDir) => Boolean(await (deps.branchExists ?? defaultBranchLookup)(branch, repoDir)),
    linearCache: new Map(),
    branchCache: new Map(),
  };
}

async function defaultLinearSiblingLookup(identifierRoot: string): Promise<LinearIssueSummary[]> {
  if (!process.env.LINEAR_API_KEY) {
    return [];
  }

  return await listOpenIssuesByIdentifierPrefix(identifierRoot);
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

const CHALLENGER_SUFFIX = '-challenger';

/**
 * Returns the paired branch name for a `task/<slug>` or `task/<slug>-challenger` branch.
 * Returns null if the branch does not follow the `task/` naming convention.
 */
export function getSiblingBranch(branch: string): string | null {
  if (!branch.startsWith('task/')) return null;
  if (branch.endsWith(CHALLENGER_SUFFIX)) {
    return branch.slice(0, -CHALLENGER_SUFFIX.length);
  }
  return branch + CHALLENGER_SUFFIX;
}

/**
 * Lists all remote `task/*` branches via `git ls-remote`.
 * Returns an empty array on error so callers degrade gracefully.
 */
export function listRemoteTaskBranches(repoDir: string): string[] {
  try {
    const output = String(execShellCommand(
      `git ls-remote --heads origin ${escapeShellArg('refs/heads/task/*')}`,
      { encoding: 'utf-8', cwd: repoDir },
    ));
    return parseRemoteBranchOutput(output);
  } catch (error) {
    console.warn(`[tend-challenge-gate] Failed to list remote branches: ${errorMessage(error)}`);
    return [];
  }
}

/**
 * Parses raw `git ls-remote --heads` output into branch name strings.
 * Filters to only `task/`-prefixed names.
 */
export function parseRemoteBranchOutput(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const ref = line.split(/\s+/).pop() ?? '';
      return ref.replace(/^refs\/heads\//, '');
    })
    .filter((name) => name.startsWith('task/'));
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

async function detectPendingChallengeSignals(
  item: ChallengeEligibleWorkItem,
  repoDir: string,
  deps: ChallengeGateRuntimeDeps,
): Promise<PendingSignalResult> {
  const signals: PendingSignal[] = [];
  const taskRoot = normalizeChallengeIdentifierRoot(item.metadata.task);
  if (taskRoot) {
    try {
      const siblings = await getLinearSiblings(taskRoot, item.metadata.task || null, deps);
      for (const sibling of siblings) {
        signals.push({ kind: 'linear-sibling', value: sibling.identifier });
      }
    } catch (error) {
      return { kind: 'lookup-error', source: 'linear', message: errorMessage(error) };
    }
  } else if (item.metadata.task) {
    console.warn(`[tend-challenge-gate] Skipping Linear sibling lookup for invalid task id "${item.metadata.task}"`);
  }

  const twinBranch = deriveTwinBranch(item.pr.headRefName);
  if (twinBranch) {
    try {
      const exists = await getBranchExistence(twinBranch, repoDir, deps);
      if (exists) {
        signals.push({ kind: 'branch-twin', value: twinBranch });
      }
    } catch (error) {
      return { kind: 'lookup-error', source: 'branch', message: errorMessage(error) };
    }
  }

  return signals.length > 0 ? { kind: 'signals', signals } : { kind: 'none' };
}

async function getLinearSiblings(
  identifierRoot: string,
  currentIdentifier: string | null,
  deps: ChallengeGateRuntimeDeps,
): Promise<LinearIssueSummary[]> {
  let lookup = deps.linearCache.get(identifierRoot);
  if (!lookup) {
    lookup = deps.linearSiblingLookup(identifierRoot);
    deps.linearCache.set(identifierRoot, lookup);
  }

  const siblings = await lookup;
  return siblings.filter((issue) => issue.identifier !== currentIdentifier);
}

async function getBranchExistence(
  branch: string,
  repoDir: string,
  deps: ChallengeGateRuntimeDeps,
): Promise<boolean> {
  const cacheKey = `${repoDir}\u0000${branch}`;
  let lookup = deps.branchCache.get(cacheKey);
  if (!lookup) {
    lookup = deps.branchExists(branch, repoDir);
    deps.branchCache.set(cacheKey, lookup);
  }

  return await lookup;
}

function normalizeChallengeIdentifierRoot(identifier: string | undefined): string | null {
  if (!identifier || !TASK_IDENTIFIER_PATTERN.test(identifier)) {
    return null;
  }

  return identifier.endsWith('_c') ? identifier.slice(0, -2) : identifier;
}

function deriveTwinBranch(headBranch: string): string | null {
  if (!headBranch.startsWith('task/')) {
    return null;
  }

  const slug = headBranch.slice('task/'.length);
  if (!slug || !BRANCH_NAME_PATTERN.test(headBranch)) {
    return null;
  }

  return slug.endsWith('-challenger')
    ? `task/${slug.slice(0, -'-challenger'.length)}`
    : `task/${slug}-challenger`;
}

function formatPendingSignalReason(signals: PendingSignal[]): string {
  return `pair-unresolved:${signals.map((signal) => `${signal.kind}:${signal.value}`).join('+')}`;
}
