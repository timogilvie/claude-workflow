import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  setWavemillBlocked,
  setWavemillMerged,
  setWavemillMerging,
  setWavemillReady,
  setWavemillSuperseded,
  WM_LABELS,
} from './pr-state-labels.ts';
import { getIntegrationConfig, getIntegrationReadyPolicy } from './config.ts';
import { readChallengeComparisons } from './challenge-comparison.ts';
import { getPullRequest } from './github.ts';
import { getIssueCompletionState } from './linear.ts';
import { extractMetadataBlock, parsePrMetadata, type PrMetadata } from './pr-metadata.ts';
import { evaluateReady } from './ready-engine.ts';
import { runReadyStage } from './ready-stage.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import {
  applyChallengePairGates,
  evaluateAutoCloseEligibility,
  type ChallengeGateDeps,
  type ChallengeGateOptions,
  type ChallengeLoserCleanupCandidate,
} from './tend-challenge-gate.ts';
import { isTransientErrorText, retryTransient, TransientError } from './transient-retry.ts';

export interface TendCandidate {
  number: number;
  title: string;
  headBranch: string;
  createdAt: string;
  dependencyDepth: number;
}

export interface BlockedCandidate {
  number: number;
  title: string;
  headBranch: string;
  reason: string;
}

export interface IntegrationHealth {
  state: 'healthy' | 'unhealthy';
  reason?: string;
}

export interface TendDecision {
  integrationHealth: IntegrationHealth;
  eligible: TendCandidate[];
  blocked: BlockedCandidate[];
  nextPR: number | null;
}

export interface MergeExecutionResult {
  status: 'merged' | 'blocked' | 'skipped' | 'halted';
  prNumber: number;
  phase?: string;
  failureExcerpt?: string;
  haltLoop: boolean;
}

export interface MergeExecutionDeps {
  shellRunner: (cmd: string, opts?: { encoding?: string; cwd?: string; timeout?: number }) => string;
  readyChecker: (prNumber: number, repoDir: string) => Promise<{ ready: boolean; reason?: string }>;
  healthChecker: HealthChecker;
  acquireMerging: (prNumber: number) => void;
  releaseToBlocked: (prNumber: number) => void;
  releaseMerged: (prNumber: number) => void;
  restoreReady: (prNumber: number) => void;
  retrySleep: (ms: number) => Promise<void>;
  currentTimeMs: () => number;
  setMergeRetryWindow: (prNumber: number, untilIso: string | null, repoDir: string) => void;
}

export interface ExecuteMergeOptions {
  repoDir: string;
  deps?: Partial<MergeExecutionDeps>;
}

export interface GhPrListEntry {
  number: number;
  title: string;
  headRefName: string;
  headRefOid?: string;
  createdAt: string;
  isDraft: boolean;
  labels: { name: string }[];
  body: string;
}

export type HealthChecker = (integrationBranch: string, repoDir: string) => Promise<IntegrationHealth>;
export type PrFetcher = (integrationBranch: string, repoDir: string) => Promise<GhPrListEntry[]>;
export interface CheckWaitResult {
  outcome: 'pass' | 'fail' | 'timeout';
  summary: string;
}

export interface SelectNextCandidateOptions {
  repoDir: string;
  prFetcher?: PrFetcher;
  healthChecker?: HealthChecker;
  staleGuardBlockReconciler?: StaleGuardBlockReconciler;
  loserCleanup?: (candidate: ChallengeLoserCleanupCandidate, repoDir: string) => void;
  challengeGateDeps?: ChallengeGateDeps;
  challengeGateOptions?: ChallengeGateOptions;
}

interface EligibleWorkItem {
  pr: GhPrListEntry;
  metadata: PrMetadata;
}

interface CrossPrRevertGuardEvidence {
  prNumber?: number;
  headSha?: string;
  outcome?: 'pass' | 'policy-fail' | 'tool-fail';
  checkedAt?: string;
  reason?: string;
}

interface ReadyGuardState {
  status?: string;
  verdict?: string;
  readyLabelsUpdated?: boolean;
  readyHeadSha?: string;
  guard?: CrossPrRevertGuardEvidence;
}

interface StaleGuardBlockReconciliationResult {
  ok: boolean;
  labels?: { name: string }[];
  reason?: string;
}

export type StaleGuardBlockReconciler = (
  pr: GhPrListEntry,
  guardState: ReadyGuardState,
  repoDir: string,
) => StaleGuardBlockReconciliationResult;

interface IntegrationBranchResolution {
  sha: string;
  source: 'remote' | 'local';
}

const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const PR_DEPENDENCY_PATTERN = /^PR#(\d+)$/i;
const FAILING_CHECK_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled']);
const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const FAILING_CHECK_BUCKETS = new Set(['fail', 'cancel']);
const PASSING_CHECK_BUCKETS = new Set(['pass', 'skipping']);
const CHECK_POLL_INTERVAL_MS = 30_000;
const TRANSIENT_REQUIRED_CHECKS_EXPECTED = 'required status checks are expected';
const MERGE_RETRY_MAX_ATTEMPTS = 8;
const MERGE_RETRY_BACKOFF_MS = 30_000;
const MERGE_RETRY_WINDOW_MS = 5 * 60 * 1000;
const GH_COMMAND_TIMEOUT_MS = 120_000;
const GIT_COMMAND_TIMEOUT_MS = 180_000;
const GIT_MUTATION_TIMEOUT_MS = 300_000;
const MERGE_COMMAND_TIMEOUT_MS = 180_000;
const DEFAULT_EXTERNAL_COMMAND_TIMEOUT_MS = 120_000;

interface PrMergeDiagnostics {
  mergeStateStatus?: string;
  statusCheckRollup?: unknown;
  headRefOid?: string;
  baseRefOid?: string;
  unavailableReason?: string;
}

export function createPrFetcher(deps: {
  exec?: typeof execShellCommand;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
} = {}): PrFetcher {
  const exec = deps.exec ?? execShellCommand;
  return async (integrationBranch: string, repoDir: string): Promise<GhPrListEntry[]> => {
    validateIntegrationBranch(integrationBranch);

    return retryTransient(
      () => {
        const output = String(exec(
          [
            'gh',
            'pr',
            'list',
            '--base',
            escapeShellArg(integrationBranch),
            '--state',
            'open',
            '--json',
            'number,title,headRefName,headRefOid,createdAt,isDraft,labels,body',
          ].join(' '),
          { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
        ));
        const parsed = JSON.parse(output) as unknown;

        if (!Array.isArray(parsed)) {
          throw new Error('tend: gh pr list returned non-array JSON');
        }

        return parsed as GhPrListEntry[];
      },
      { label: 'gh pr list', sleep: deps.sleep, random: deps.random },
    );
  };
}

export const defaultPrFetcher: PrFetcher = createPrFetcher();

export async function defaultHealthChecker(integrationBranch: string, repoDir: string): Promise<IntegrationHealth> {
  try {
    validateIntegrationBranch(integrationBranch);

    const resolution = resolveIntegrationBranchSha(integrationBranch, repoDir);
    const repo = resolveOwnerRepoFromRemote(repoDir);

    if (!repo) {
      return { state: 'unhealthy', reason: 'health-check-error: unable to resolve origin repo' };
    }

    let checkRuns: Array<{ name?: string; conclusion?: string | null }>;
    try {
      checkRuns = await readCheckRuns(repo, resolution.sha, repoDir);
    } catch (error) {
      const remoteResolution = resolveRemoteIntegrationBranchSha(integrationBranch, repoDir);
      if (
        resolution.source !== 'local' ||
        !isMissingCommitCheckRunsError(error) ||
        !remoteResolution ||
        remoteResolution.sha === resolution.sha
      ) {
        throw error;
      }
      checkRuns = await readCheckRuns(repo, remoteResolution.sha, repoDir);
    }

    for (const checkRun of checkRuns) {
      const conclusion = checkRun.conclusion ?? '';
      if (FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
        return { state: 'unhealthy', reason: `${checkRun.name || 'check'}: ${conclusion}` };
      }
    }

    return { state: 'healthy' };
  } catch (error) {
    return { state: 'unhealthy', reason: `health-check-error: ${errorMessage(error)}` };
  }
}

async function readCheckRuns(
  repo: string,
  sha: string,
  repoDir: string,
): Promise<Array<{ name?: string; conclusion?: string | null }>> {
  return retryTransient(
    () => {
      const raw = String(execShellCommand(
        `gh api ${escapeShellArg(`repos/${repo}/commits/${sha}/check-runs`)}`,
        { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
      ));
      const parsed = JSON.parse(raw) as { check_runs?: Array<{ name?: string; conclusion?: string | null }> };
      return Array.isArray(parsed.check_runs) ? parsed.check_runs : [];
    },
    { label: 'gh check-runs' },
  );
}

function isMissingCommitCheckRunsError(error: unknown): boolean {
  const output = outputFromError(error);
  return output.includes('No commit found for SHA') && output.includes('HTTP 422');
}

function resolveIntegrationBranchSha(integrationBranch: string, repoDir: string): IntegrationBranchResolution {
  const remoteResolution = resolveRemoteIntegrationBranchSha(integrationBranch, repoDir);
  if (remoteResolution) {
    return remoteResolution;
  }

  const localSha = resolveRefSha(integrationBranch, repoDir);
  if (localSha) {
    return { sha: localSha, source: 'local' };
  }

  const remoteTrackingRef = integrationRemoteTrackingRef(integrationBranch);

  throw new Error(
    `unable to resolve integration branch ${escapeShellArg(integrationBranch)} locally or as ${remoteTrackingRef}`,
  );
}

function resolveRemoteIntegrationBranchSha(
  integrationBranch: string,
  repoDir: string,
): IntegrationBranchResolution | null {
  const remoteTrackingRef = integrationRemoteTrackingRef(integrationBranch);
  const remoteSha = resolveRefSha(remoteTrackingRef, repoDir);
  if (!remoteSha) {
    return null;
  }

  return { sha: remoteSha, source: 'remote' };
}

function integrationRemoteTrackingRef(integrationBranch: string): string {
  return `refs/remotes/origin/${integrationBranch}`;
}

function resolveRefSha(ref: string, repoDir: string): string | null {
  try {
    const sha = String(execShellCommand(
      `git rev-parse ${escapeShellArg(ref)} 2>/dev/null`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GIT_COMMAND_TIMEOUT_MS },
    )).trim();
    return sha ? sha : null;
  } catch {
    return null;
  }
}

export async function selectNextCandidate(options: SelectNextCandidateOptions): Promise<TendDecision> {
  const integrationBranch = getConfiguredIntegrationBranch(options.repoDir);
  const healthChecker = options.healthChecker ?? defaultHealthChecker;
  const prFetcher = options.prFetcher ?? defaultPrFetcher;

  const integrationHealth = await healthChecker(integrationBranch, options.repoDir);
  if (integrationHealth.state === 'unhealthy') {
    return { integrationHealth, eligible: [], blocked: [], nextPR: null };
  }

  const allPrs = await prFetcher(integrationBranch, options.repoDir);
  const wavemillPrs = allPrs.filter(isWavemillPr);
  const openPrNumbers = new Set(wavemillPrs.map((pr) => pr.number));
  const staleGuardBlockReconciler = options.staleGuardBlockReconciler ?? defaultStaleGuardBlockReconciler;
  const blocked: BlockedCandidate[] = [];
  let eligibleWorkItems: EligibleWorkItem[] = [];

  for (const pr of wavemillPrs) {
    const metadataResult = getValidMetadata(pr.body);
    const reason = getInitialBlockReason(
      pr,
      metadataResult.metadata,
      openPrNumbers,
      options.repoDir,
      staleGuardBlockReconciler,
    );

    if (reason) {
      blocked.push(toBlockedCandidate(pr, reason));
      continue;
    }

    eligibleWorkItems.push({ pr, metadata: metadataResult.metadata });
  }

  const dependencyBlocked = removeCandidatesWithBlockedDependencies(eligibleWorkItems);
  blocked.push(...dependencyBlocked.blocked);
  eligibleWorkItems = dependencyBlocked.eligible;

  const cycleResult = computeDependencyDepths(eligibleWorkItems);
  blocked.push(...cycleResult.cycleBlocked);

  const challengeResult = await applyChallengePairGates(
    cycleResult.eligible,
    blocked,
    options.repoDir,
    { ...options.challengeGateOptions, ...options.challengeGateDeps },
  );
  blocked.length = 0;
  blocked.push(...challengeResult.blocked);

  const cleanupLoser = options.loserCleanup ?? defaultLoserCleanup;
  for (const candidate of challengeResult.loserCleanupCandidates) {
    try {
      cleanupLoser(candidate, options.repoDir);
    } catch {
      // Cleanup failure is non-fatal; the loser remains blocked for manual review.
    }
  }

  const eligible = challengeResult.eligible
    .map((item) => ({
      number: item.pr.number,
      title: item.pr.title,
      headBranch: item.pr.headRefName,
      createdAt: item.pr.createdAt,
      dependencyDepth: item.dependencyDepth,
    }))
    .sort((a, b) => a.dependencyDepth - b.dependencyDepth || a.createdAt.localeCompare(b.createdAt));

  return {
    integrationHealth,
    eligible,
    blocked,
    nextPR: eligible[0]?.number ?? null,
  };
}

export function formatStatusLine(
  decision: TendDecision,
  opts: {
    action?: string;
    lastPR?: number | null;
    iteration?: number;
    pollStartedAt?: string;
    pollCompletedAt?: string | null;
  } = {},
): string {
  const health = decision.integrationHealth.state === 'healthy' ? 'ok' : 'degraded';
  const last = typeof opts.lastPR === 'number' ? `#${opts.lastPR}` : 'none';
  const action = opts.action ?? 'idle';

  const parts = [
    typeof opts.iteration === 'number' ? `iter=${opts.iteration}` : null,
    opts.pollStartedAt ? `poll_started=${opts.pollStartedAt}` : null,
    opts.pollCompletedAt ? `poll_completed=${opts.pollCompletedAt}` : null,
    `eligible=${decision.eligible.length}`,
    `blocked=${decision.blocked.length}`,
    `health=${health}`,
    `last=${last}`,
    `action=${action}`,
  ];

  return parts.filter((part): part is string => part !== null).join(' ');
}

export async function executeMerge(
  candidate: TendCandidate,
  options: ExecuteMergeOptions,
): Promise<MergeExecutionResult> {
  const deps = mergeExecutionDeps(options.deps);
  const integrationConfig = getIntegrationConfig(options.repoDir);
  const integrationBranch = getConfiguredIntegrationBranch(options.repoDir);

  validateBranchName(candidate.headBranch, 'PR branch');

  let activeMerges: number[];
  try {
    activeMerges = await listMergingPrs(options.repoDir, deps);
  } catch (error) {
    console.warn(`tend: merge-lane probe failed for PR #${candidate.number}: ${errorMessage(error)}`);
    return {
      status: 'skipped',
      prNumber: candidate.number,
      phase: 'merge-lane-probe',
      failureExcerpt: truncateOutput(outputFromError(error)),
      haltLoop: false,
    };
  }
  if (activeMerges.length > 0) {
    return { status: 'skipped', prNumber: candidate.number, haltLoop: false };
  }

  try {
    await retryTransient(() => deps.acquireMerging(candidate.number), {
      label: 'set merging label',
      sleep: deps.retrySleep,
    });
  } catch (error) {
    try {
      deps.restoreReady(candidate.number);
    } catch {
      // Preserve the acquisition failure; restore is best-effort.
    }
    return {
      status: 'skipped',
      prNumber: candidate.number,
      phase: 'label',
      failureExcerpt: truncateOutput(outputFromError(error)),
      haltLoop: false,
    };
  }

  const block = async (phase: string, output: string): Promise<MergeExecutionResult> => {
    const failureExcerpt = truncateOutput(output);
    try {
      postFailureComment(candidate.number, buildFailureComment(phase, failureExcerpt), options.repoDir, deps.shellRunner);
    } catch {
      // Comment posting failure is non-fatal; always release the PR from merging state.
    }
    try {
      deps.releaseToBlocked(candidate.number);
    } catch {
      // Label update failure is non-fatal; PR will be manually reviewed or auto-retried on next cycle.
    }
    return { status: 'blocked', prNumber: candidate.number, phase, failureExcerpt, haltLoop: false };
  };

  let worktreeResult: MergeExecutionResult | null;
  try {
    worktreeResult = await withScratchWorktree(
      candidate.number,
      candidate.headBranch,
      options.repoDir,
      async (worktreePath) => {
        try {
          rebaseAndPush(worktreePath, candidate.headBranch, integrationBranch, deps.shellRunner);
        } catch (error) {
          return block('rebase', outputFromError(error));
        }

        const checks = await waitForChecks(
          candidate.number,
          options.repoDir,
          deps.shellRunner,
          { requiredChecks: integrationConfig.requiredChecks, retrySleep: deps.retrySleep },
        );
        if (checks.outcome !== 'pass') {
          return block('checks', checks.summary);
        }

        try {
          const ready = await deps.readyChecker(candidate.number, options.repoDir);
          if (!ready.ready) {
            return block('ready', ready.reason || 'ready check failed');
          }
        } catch (error) {
          return block('ready', outputFromError(error));
        }

        try {
          await mergeWithTransientRetry(
            candidate.number,
            integrationConfig.mergeMethod,
            integrationConfig.requiredChecks,
            options.repoDir,
            deps,
          );
        } catch (error) {
          return block('merge', outputFromError(error));
        }

        if (integrationConfig.deleteBranchAfterMerge) {
          try {
            deps.shellRunner(
              `git push origin --delete ${escapeShellArg(candidate.headBranch)}`,
              { encoding: 'utf-8', cwd: options.repoDir, timeout: GIT_MUTATION_TIMEOUT_MS },
            );
          } catch (error) {
            console.warn(
              `tend: post-merge remote branch cleanup failed for PR #${candidate.number} (${candidate.headBranch}): ${errorMessage(error)}`,
            );
          }
        }

        try {
          await retryTransient(() => deps.releaseMerged(candidate.number), {
            label: 'set merged label',
            sleep: deps.retrySleep,
          });
        } catch (error) {
          console.warn(`tend: failed to mark PR #${candidate.number} merged after merge completed: ${errorMessage(error)}`);
        }
        return null;
      },
      deps.shellRunner,
    );
  } catch (error) {
    return block('worktree', outputFromError(error));
  }

  if (worktreeResult) {
    return worktreeResult;
  }

  let health: IntegrationHealth;
  try {
    health = await deps.healthChecker(integrationBranch, options.repoDir);
  } catch (error) {
    health = { state: 'unhealthy', reason: `health-check-error: ${errorMessage(error)}` };
  }

  if (health.state === 'unhealthy') {
    const reason = health.reason || 'integration branch is unhealthy after merge';
    try {
      postFailureComment(
        candidate.number,
        buildFailureComment('integration', `Integration branch \`${integrationBranch}\` is unhealthy after merge: ${reason}`),
        options.repoDir,
        deps.shellRunner,
      );
    } catch (error) {
      console.warn(`tend: failed to post integration halt comment for PR #${candidate.number}: ${errorMessage(error)}`);
    }
    return {
      status: 'halted',
      prNumber: candidate.number,
      phase: 'integration',
      failureExcerpt: truncateOutput(reason),
      haltLoop: true,
    };
  }

  return { status: 'merged', prNumber: candidate.number, haltLoop: false };
}

export function truncateOutput(output: string, maxLines = 30): string {
  const lines = output.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return output.trim();
  }

  return ['... (truncated)', ...lines.slice(-maxLines)].join('\n').trim();
}

export function buildFailureComment(phase: string, excerpt: string): string {
  const title = phase.charAt(0).toUpperCase() + phase.slice(1);
  const escaped = (excerpt || '(no output)').replace(/```/g, '`  `');
  return [
    `### Wavemill ${title} failed`,
    '',
    '```text',
    escaped,
    '```',
  ].join('\n');
}

async function withScratchWorktree<T>(
  prNumber: number,
  prBranch: string,
  repoDir: string,
  fn: (worktreePath: string) => Promise<T>,
  shellRunner: MergeExecutionDeps['shellRunner'],
): Promise<T> {
  validateBranchName(prBranch, 'PR branch');

  const commonGitDir = String(shellRunner('git rev-parse --git-common-dir', {
    encoding: 'utf-8',
    cwd: repoDir,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  })).trim();
  const worktreePath = join(commonGitDir, 'wavemill-tend', String(prNumber));

  // Fetch the latest remote tip for the PR branch so the detached worktree
  // operates on what GitHub considers the branch's current state, not a
  // possibly-stale local ref.
  shellRunner(
    `git fetch origin ${escapeShellArg(prBranch)} 2>&1`,
    { encoding: 'utf-8', cwd: repoDir, timeout: GIT_MUTATION_TIMEOUT_MS },
  );

  // Use --detach so this worktree gets a detached HEAD at the PR's remote
  // tip rather than checking out the branch by name. Mill creates its own
  // task worktree that already holds <prBranch> checked out, and git refuses
  // to check out the same branch in two worktrees. Tend doesn't need branch
  // ownership — it just needs the tree at that commit so it can rebase and
  // push back to origin's <prBranch> ref by name (see rebaseAndPush).
  shellRunner(
    `git worktree add --detach ${escapeShellArg(worktreePath)} ${escapeShellArg(`origin/${prBranch}`)}`,
    { encoding: 'utf-8', cwd: repoDir, timeout: GIT_MUTATION_TIMEOUT_MS },
  );

  try {
    return await fn(worktreePath);
  } finally {
    try {
      shellRunner(
        `git worktree remove --force ${escapeShellArg(worktreePath)}`,
        { encoding: 'utf-8', cwd: repoDir, timeout: GIT_MUTATION_TIMEOUT_MS },
      );
    } catch {
      // A cleanup failure should not change the PR's merge outcome.
    }
  }
}

async function listMergingPrs(repoDir: string, deps: MergeExecutionDeps): Promise<number[]> {
  return retryTransient(
    () => {
      const output = deps.shellRunner(
        `gh pr list --label ${escapeShellArg(WM_LABELS.merging)} --state open --json number`,
        { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
      );
      const parsed = JSON.parse(String(output)) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('tend: gh pr list returned non-array JSON');
      }
      return parsed
        .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { number?: unknown }).number : null))
        .filter((number): number is number => typeof number === 'number');
    },
    { label: 'gh pr list merging', sleep: deps.retrySleep },
  );
}

function rebaseAndPush(
  worktreePath: string,
  prBranch: string,
  integrationBranch: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
): string {
  validateBranchName(prBranch, 'PR branch');
  validateBranchName(integrationBranch, 'integration branch');

  const output: string[] = [];

  output.push(String(shellRunner(
    `git fetch origin ${escapeShellArg(integrationBranch)} 2>&1`,
    { encoding: 'utf-8', cwd: worktreePath, timeout: GIT_MUTATION_TIMEOUT_MS },
  )));

  // Capture the PR branch SHA before rebase for SHA-keyed force-with-lease
  const prRemoteRef = `origin/${prBranch}`;
  const prBranchSha = String(shellRunner(`git rev-parse ${escapeShellArg(prRemoteRef)}`, {
    encoding: 'utf-8',
    cwd: worktreePath,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  })).trim();

  const integrationRemoteRef = `origin/${integrationBranch}`;
  if (isRemoteIntegrationAncestorOfPrHead(integrationRemoteRef, prBranchSha, worktreePath, shellRunner)) {
    output.push(`tend: skipping pre-merge rebase because ${integrationRemoteRef} is already an ancestor of ${prBranchSha}`);
    return output.join('\n');
  }

  try {
    output.push(String(shellRunner(
      `git rebase ${escapeShellArg(integrationRemoteRef)} 2>&1`,
      { encoding: 'utf-8', cwd: worktreePath, timeout: GIT_MUTATION_TIMEOUT_MS },
    )));
  } catch (error) {
    // Explicitly abort rebase on failure
    try {
      shellRunner('git rebase --abort 2>&1', {
        encoding: 'utf-8',
        cwd: worktreePath,
        timeout: GIT_COMMAND_TIMEOUT_MS,
      });
    } catch {
      // Rebase abort failure is best-effort
    }
    throw error;
  }

  // Push the rebased commits back to origin's <prBranch>. We use HEAD:<branch>
  // syntax because withScratchWorktree intentionally checks out a detached
  // HEAD (so it doesn't fight mill's task worktree for branch ownership).
  // --force-with-lease still keys on origin's pre-rebase SHA — that doesn't
  // depend on local branch ownership.
  output.push(String(shellRunner(
    `git push --force-with-lease=${escapeShellArg(prBranch)}:${escapeShellArg(prBranchSha)} origin HEAD:${escapeShellArg(prBranch)} 2>&1`,
    { encoding: 'utf-8', cwd: worktreePath, timeout: GIT_MUTATION_TIMEOUT_MS },
  )));

  return output.join('\n');
}

function isRemoteIntegrationAncestorOfPrHead(
  integrationRemoteRef: string,
  prBranchSha: string,
  worktreePath: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
): boolean {
  try {
    shellRunner(
      `git merge-base --is-ancestor ${escapeShellArg(integrationRemoteRef)} ${escapeShellArg(prBranchSha)}`,
      { encoding: 'utf-8', cwd: worktreePath, timeout: GIT_COMMAND_TIMEOUT_MS },
    );
    return true;
  } catch (error) {
    if (shouldWarnOnAncestryCheckFailure(error)) {
      console.warn(
        `tend: pre-merge ancestry check failed for ${integrationRemoteRef} at ${prBranchSha}; falling back to rebase: ${errorMessage(error)}`,
      );
    }
    return false;
  }
}

function shouldWarnOnAncestryCheckFailure(error: unknown): boolean {
  // git merge-base --is-ancestor exits with code 1 (no output) when not an ancestor.
  // execSync throws with no "not ancestor" text — detect via exit status instead.
  const status = (error as Record<string, unknown>)?.status;
  return status !== 1;
}

export async function waitForChecks(
  prNumber: number,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
  options: { timeoutMs?: number; requiredChecks?: string[]; retrySleep?: (ms: number) => Promise<void> } = {},
): Promise<CheckWaitResult> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const requiredChecks = options.requiredChecks ?? [];
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const output = await readPrChecks(prNumber, repoDir, shellRunner, options.retrySleep ?? sleep);
    const checks = parseCheckRuns(output);
    const failed = checks.find((check) => isFailingCheck(check));
    if (failed) {
      return { outcome: 'fail', summary: summarizeChecks(checks) };
    }

    const missingRequired = findMissingRequiredChecks(checks, requiredChecks);

    if (checks.length > 0 && missingRequired.length === 0 && checks.every((check) => isPassingCheck(check))) {
      return { outcome: 'pass', summary: summarizeChecks(checks, requiredChecks) };
    }

    if (Date.now() >= deadline) {
      return {
        outcome: 'timeout',
        summary: summarizeChecks(checks, requiredChecks),
      };
    }

    await sleep(CHECK_POLL_INTERVAL_MS);
  }
}

async function readPrChecks(
  prNumber: number,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
  retrySleep: (ms: number) => Promise<void>,
): Promise<string> {
  return retryTransient(
    () => {
      const output = String(shellRunner(
        `gh pr checks ${prNumber} --json name,state,bucket 2>&1 || true`,
        { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
      ));
      if (output.includes('no checks reported')) {
        return '[]';
      }
      try {
        JSON.parse(output);
      } catch (error) {
        if (isTransientErrorText(output)) {
          throw new TransientError(output, { cause: error });
        }
      }
      return output;
    },
    { label: 'gh pr checks', sleep: retrySleep },
  );
}

async function defaultRunReadyCheck(
  prNumber: number,
  repoDir: string,
): Promise<{ ready: boolean; reason?: string }> {
  const readyPolicy = getIntegrationReadyPolicy(repoDir);

  if (!readyPolicy.enabled) {
    const result = await runReadyStage({ prNumber, repoDir });
    return { ready: result.verdict === 'pass', reason: result.summary };
  }

  const pr = getPullRequest(prNumber);
  const verdict = await evaluateReady({
    pr: {
      number: pr.number,
      url: pr.url,
      baseBranch: pr.baseRefName,
      body: pr.body || '',
      labels: pr.labels.map((label) => label.name),
      mergedAt: pr.mergedAt,
    },
    config: {
      ...readyPolicy,
      integrationBranch: readyPolicy.integrationBranch || getConfiguredIntegrationBranch(repoDir),
    },
    async fetchPrState(dependencyPrNumber) {
      try {
        const dependencyPr = getPullRequest(dependencyPrNumber);
        const state = dependencyPr.mergedAt ? 'MERGED' : dependencyPr.state === 'OPEN' ? 'OPEN' : 'CLOSED';
        return { state, mergedAt: dependencyPr.mergedAt };
      } catch (error) {
        if ((error as Error).message.includes('not found')) {
          return null;
        }
        throw error;
      }
    },
    async fetchLinearIssueState(identifier) {
      try {
        const issue = await getIssueCompletionState(identifier);
        return { completedAt: issue.completedAt ?? null, canceledAt: issue.canceledAt ?? null };
      } catch (error) {
        if ((error as Error).message.includes('Issue not found')) {
          return null;
        }
        throw error;
      }
    },
    readChallengeComparisons,
  });

  return {
    ready: verdict.status === 'pass',
    reason: verdict.reasons.join('; '),
  };
}

function postFailureComment(
  prNumber: number,
  body: string,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
): void {
  shellRunner(
    `gh pr comment ${prNumber} --body ${escapeShellArg(body)}`,
    { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
  );
}

async function mergeWithTransientRetry(
  prNumber: number,
  mergeMethod: string,
  requiredChecks: string[],
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<void> {
  const mergeFlag = `--${mergeMethod}`;
  const command = `gh pr merge ${prNumber} ${mergeFlag}`;
  const deadlineMs = deps.currentTimeMs() + MERGE_RETRY_WINDOW_MS;
  let lastTransientError = '';
  let lastDiagnostics: PrMergeDiagnostics | null = null;
  let retryWindowMarked = false;

  try {
    for (let attempt = 1; attempt <= MERGE_RETRY_MAX_ATTEMPTS; attempt += 1) {
      try {
        deps.shellRunner(command, { encoding: 'utf-8', cwd: repoDir, timeout: MERGE_COMMAND_TIMEOUT_MS });
        return;
      } catch (error) {
        const output = outputFromError(error);
        if (isAlreadyMergedOutput(output)) {
          return;
        }
        if (!isRequiredChecksExpectedMergeError(output) && !isTransientErrorText(output)) {
          throw error;
        }

        lastTransientError = output;
        lastDiagnostics = readPrMergeDiagnostics(prNumber, repoDir, deps.shellRunner);

        if (attempt >= MERGE_RETRY_MAX_ATTEMPTS || deps.currentTimeMs() + MERGE_RETRY_BACKOFF_MS > deadlineMs) {
          throw new Error(buildTransientMergeFailureDiagnostics(lastTransientError, lastDiagnostics, requiredChecks));
        }

        // Signal the local merge queue (a separate process) that this candidate is
        // in an active transient-retry window so it is not demoted as "stuck" and
        // re-promoted while tend keeps retrying. See isCandidateStuck in merge-queue.ts.
        if (!retryWindowMarked) {
          deps.setMergeRetryWindow(prNumber, new Date(deadlineMs).toISOString(), repoDir);
          retryWindowMarked = true;
        }

        await deps.retrySleep(MERGE_RETRY_BACKOFF_MS);
      }
    }

    throw new Error(buildTransientMergeFailureDiagnostics(lastTransientError, lastDiagnostics, requiredChecks));
  } finally {
    if (retryWindowMarked) {
      deps.setMergeRetryWindow(prNumber, null, repoDir);
    }
  }
}

export function isRequiredChecksExpectedMergeError(output: string): boolean {
  return output.toLowerCase().includes(TRANSIENT_REQUIRED_CHECKS_EXPECTED);
}

function isAlreadyMergedOutput(output: string): boolean {
  return /\balready merged\b|pull request .* was merged/i.test(output);
}

function readPrMergeDiagnostics(
  prNumber: number,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
): PrMergeDiagnostics {
  try {
    const output = shellRunner(
      `gh pr view ${prNumber} --json mergeStateStatus,statusCheckRollup,headRefOid,baseRefOid`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
    );
    const parsed = JSON.parse(String(output)) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { unavailableReason: 'gh pr view returned non-object JSON' };
    }
    const value = parsed as {
      mergeStateStatus?: unknown;
      statusCheckRollup?: unknown;
      headRefOid?: unknown;
      baseRefOid?: unknown;
    };
    return {
      mergeStateStatus: typeof value.mergeStateStatus === 'string' ? value.mergeStateStatus : undefined,
      statusCheckRollup: value.statusCheckRollup,
      headRefOid: typeof value.headRefOid === 'string' ? value.headRefOid : undefined,
      baseRefOid: typeof value.baseRefOid === 'string' ? value.baseRefOid : undefined,
    };
  } catch (error) {
    return { unavailableReason: outputFromError(error) };
  }
}

function buildTransientMergeFailureDiagnostics(
  githubError: string,
  diagnostics: PrMergeDiagnostics | null,
  requiredChecks: string[],
): string {
  const lines = [
    isRequiredChecksExpectedMergeError(githubError)
      ? 'GitHub continued to report a transient required-checks protection error after Wavemill checks passed.'
      : 'GitHub continued to report a transient merge error after Wavemill checks passed.',
    '',
    'Exact GitHub error:',
    githubError || '(no output)',
    '',
    `Required checks: ${requiredChecks.length > 0 ? requiredChecks.join(', ') : '(none configured)'}`,
  ];

  if (!diagnostics) {
    lines.push('Final PR state: unavailable');
    return lines.join('\n');
  }

  if (diagnostics.unavailableReason) {
    lines.push(`Final PR state unavailable: ${diagnostics.unavailableReason}`);
    return lines.join('\n');
  }

  lines.push(`Final mergeStateStatus: ${diagnostics.mergeStateStatus || '(missing)'}`);
  lines.push(`PR head SHA: ${diagnostics.headRefOid || '(missing)'}`);
  lines.push(`Base SHA: ${diagnostics.baseRefOid || '(missing)'}`);
  lines.push('Final check rollup:');
  lines.push(formatStatusCheckRollup(diagnostics.statusCheckRollup));
  return lines.join('\n');
}

function formatStatusCheckRollup(rollup: unknown): string {
  const entries = extractStatusCheckRollupEntries(rollup);
  if (entries.length === 0) {
    return '(no check-rollup entries reported)';
  }
  return entries.map((entry) => {
    const name = stringField(entry, 'name') || stringField(entry, 'context') || 'check';
    const status = stringField(entry, 'status') || stringField(entry, 'state') || stringField(entry, 'conclusion') || 'unknown';
    const conclusion = stringField(entry, 'conclusion');
    return conclusion && conclusion !== status ? `${name}: ${status}/${conclusion}` : `${name}: ${status}`;
  }).join('\n');
}

function extractStatusCheckRollupEntries(rollup: unknown): Record<string, unknown>[] {
  if (Array.isArray(rollup)) {
    return rollup.filter(isRecord);
  }
  if (!isRecord(rollup)) {
    return [];
  }
  if (Array.isArray(rollup.nodes)) {
    return rollup.nodes.filter(isRecord);
  }
  if (Array.isArray(rollup.contexts)) {
    return rollup.contexts.filter(isRecord);
  }
  if (isRecord(rollup.nodes) && Array.isArray(rollup.nodes.nodes)) {
    return rollup.nodes.nodes.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function mergeExecutionDeps(deps: Partial<MergeExecutionDeps> | undefined): MergeExecutionDeps {
  return {
    shellRunner: (cmd, opts) => String(execShellCommand(cmd, {
      ...opts,
      timeout: opts?.timeout ?? DEFAULT_EXTERNAL_COMMAND_TIMEOUT_MS,
    })),
    readyChecker: defaultRunReadyCheck,
    healthChecker: defaultHealthChecker,
    acquireMerging: (prNumber) => {
      setWavemillMerging(prNumber);
    },
    releaseToBlocked: (prNumber) => {
      setWavemillBlocked(prNumber);
    },
    releaseMerged: (prNumber) => {
      setWavemillMerged(prNumber);
    },
    restoreReady: (prNumber) => {
      setWavemillReady(prNumber);
    },
    retrySleep: sleep,
    currentTimeMs: () => Date.now(),
    setMergeRetryWindow: (prNumber, untilIso, repoDir) => {
      writeMergeRetryMarker(prNumber, untilIso, repoDir);
    },
    ...deps,
  };
}

/**
 * Absolute path to the cross-process marker that records an active transient
 * merge-retry window for a PR. Written by the tend process (which knows the PR
 * number and repo dir) and read by the shell mill loop's merge-queue tick, which
 * lives in a separate process and cannot otherwise observe that tend is mid-retry.
 */
export function mergeRetryMarkerPath(prNumber: number, repoDir: string): string {
  return join(repoDir, '.wavemill', 'merge-retry', `${prNumber}.json`);
}

/**
 * Persist (or clear) the transient merge-retry window marker for a PR. Failures
 * are swallowed: the marker is a best-effort anti-churn hint, and losing it must
 * never abort or crash an in-flight merge attempt.
 */
function writeMergeRetryMarker(prNumber: number, untilIso: string | null, repoDir: string): void {
  const markerPath = mergeRetryMarkerPath(prNumber, repoDir);
  try {
    if (untilIso === null) {
      rmSync(markerPath, { force: true });
      return;
    }
    mkdirSync(join(repoDir, '.wavemill', 'merge-retry'), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({ prNumber, until: untilIso })}\n`, 'utf-8');
  } catch {
    // Best-effort only; stuck detection falls back to timestamp-based demotion.
  }
}

function defaultLoserCleanup(candidate: ChallengeLoserCleanupCandidate, repoDir: string): void {
  // Re-validate eligibility at cleanup time to be doubly sure
  const eligibility = evaluateAutoCloseEligibility({
    loserPr: candidate.loserPr,
    winnerPr: candidate.winnerPr,
    comparisonOutcome: 'decisive', // Already validated in gate
    evidenceId: candidate.evidenceId,
  });

  if (!eligibility.eligible) {
    console.warn(
      `[tend-controller] Cleanup candidate PR #${candidate.loserPr} failed re-validation: ${eligibility.refusal}; skipping cleanup`,
    );
    return;
  }

  // Check current PR state to avoid duplicate mutations
  try {
    const prState = getPullRequest(candidate.loserPr, repoDir);
    if (!prState) {
      console.warn(`[tend-controller] Could not find PR #${candidate.loserPr} for cleanup; skipping`);
      return;
    }

    if (prState.state === 'closed') {
      // Already closed; check if label is already present
      const hasSuperseded = prState.labels.some((label) => label.name === WM_LABELS.superseded);
      if (hasSuperseded) {
        // Already handled
        return;
      }
    }
  } catch (error) {
    console.warn(
      `[tend-controller] Failed to check PR #${candidate.loserPr} state: ${errorMessage(error)}; proceeding with cleanup`,
    );
  }

  try {
    setWavemillSuperseded(candidate.loserPr);
  } catch (error) {
    console.warn(
      `[tend-controller] Failed to apply wm:superseded label to PR #${candidate.loserPr}: ${errorMessage(error)}`,
    );
  }

  try {
    execShellCommand(
      `gh pr close ${candidate.loserPr} --comment ${escapeShellArg(
        `Closed: lost challenge comparison.\nWinner: #${candidate.winnerPr}\nEvidence: ${candidate.evidenceId}`,
      )}`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
    );
  } catch (error) {
    console.warn(
      `[tend-controller] Failed to close loser PR #${candidate.loserPr}: ${errorMessage(error)}`,
    );
  }
}

interface PrCheckRun {
  name?: string;
  state?: string | null;
  conclusion?: string | null;
  bucket?: string | null;
}

function parseCheckRuns(output: string): PrCheckRun[] {
  const parsed = JSON.parse(String(output)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('tend: gh pr checks returned non-array JSON');
  }
  return parsed as PrCheckRun[];
}

function isFailingCheck(check: PrCheckRun): boolean {
  const conclusion = (check.conclusion || '').toLowerCase();
  const bucket = (check.bucket || '').toLowerCase();
  const state = (check.state || '').toUpperCase();
  return (
    FAILING_CHECK_CONCLUSIONS.has(conclusion)
    || FAILING_CHECK_BUCKETS.has(bucket)
    || FAILING_CHECK_CONCLUSIONS.has(state.toLowerCase())
  );
}

function isPassingCheck(check: PrCheckRun): boolean {
  const conclusion = (check.conclusion || '').toLowerCase();
  const bucket = (check.bucket || '').toLowerCase();
  return PASSING_CHECK_CONCLUSIONS.has(conclusion) || PASSING_CHECK_BUCKETS.has(bucket);
}

function findMissingRequiredChecks(checks: PrCheckRun[], requiredChecks: string[]): string[] {
  if (requiredChecks.length === 0) {
    return [];
  }
  const reported = new Set(checks.map((check) => check.name).filter(Boolean));
  return requiredChecks.filter((name) => !reported.has(name));
}

function summarizeChecks(checks: PrCheckRun[], requiredChecks: string[] = []): string {
  const missingRequired = findMissingRequiredChecks(checks, requiredChecks);
  if (checks.length === 0) {
    return missingRequired.length > 0
      ? `No PR checks reported.\nMissing required checks: ${missingRequired.join(', ')}`
      : 'No PR checks reported.';
  }
  const summary = checks
    .map((check) => `${check.name || 'check'}: ${check.conclusion || check.bucket || check.state || 'pending'}`)
    .join('\n');
  return missingRequired.length > 0
    ? `${summary}\nMissing required checks: ${missingRequired.join(', ')}`
    : summary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConfiguredIntegrationBranch(repoDir: string): string {
  const integrationBranch = getIntegrationConfig(repoDir).integrationBranch;

  if (!integrationBranch) {
    throw new Error('tend: integration branch not configured');
  }

  validateIntegrationBranch(integrationBranch);
  return integrationBranch;
}

function validateIntegrationBranch(integrationBranch: string): void {
  validateBranchName(integrationBranch, 'integration branch');
}

function validateBranchName(integrationBranch: string, label: string): void {
  if (!BRANCH_NAME_PATTERN.test(integrationBranch)) {
    throw new Error(`tend: invalid ${label} name`);
  }
}

function isWavemillPr(pr: GhPrListEntry): boolean {
  return labelSet(pr).has(WM_LABELS.wavemill) || hasValidMetadataBlock(pr.body);
}

function hasValidMetadataBlock(body: string): boolean {
  return extractMetadataBlock(body).block !== null && parsePrMetadata(body).ok;
}

function getValidMetadata(body: string): { metadata: PrMetadata | null } {
  if (extractMetadataBlock(body).block === null) {
    return { metadata: null };
  }

  const parsed = parsePrMetadata(body);
  if (!parsed.ok) {
    return { metadata: null };
  }

  return { metadata: parsed.metadata };
}

function getInitialBlockReason(
  pr: GhPrListEntry,
  metadata: PrMetadata | null,
  openPrNumbers: Set<number>,
  repoDir: string,
  staleGuardBlockReconciler: StaleGuardBlockReconciler,
): string | null {
  let labels = labelSet(pr);

  if (pr.isDraft) {
    return 'draft';
  }

  if (labels.has(WM_LABELS.blocked)) {
    const guardState = readReadyGuardStateForPr(pr, metadata, repoDir);
    if (!blockedLabelCanBeReconciledFromGuardPass(pr, guardState)) {
      return guardState?.guard?.outcome === 'policy-fail'
        && pr.headRefOid
        && guardState.guard.headSha
        && guardState.guard.headSha !== pr.headRefOid
        ? 'blocked-label:stale-cross-pr-guard'
        : 'blocked-label';
    }

    const reconciliation = staleGuardBlockReconciler(pr, guardState, repoDir);
    if (!reconciliation.ok) {
      return 'blocked-label:stale-guard-label-removal-failed';
    }

    labels = reconciliation.labels
      ? new Set(reconciliation.labels.map((label) => label.name))
      : new Set([...labels].filter((label) => label !== WM_LABELS.blocked).concat(WM_LABELS.ready));
  }

  if (!metadata) {
    return 'missing-metadata';
  }

  if (!labels.has(WM_LABELS.ready)) {
    return 'ready-failed:not-ready';
  }

  if ((metadata.depends_on_linear?.length ?? 0) > 0) {
    return 'deps-unresolved';
  }

  for (const dependency of metadata.depends_on ?? []) {
    const dependencyPrNumber = parseDependencyPrNumber(dependency);
    if (dependencyPrNumber !== null && !openPrNumbers.has(dependencyPrNumber)) {
      return 'deps-unresolved';
    }
  }

  if (metadata.challenge === true && labels.has(WM_LABELS.challengeUnresolved)) {
    return 'challenges-unresolved';
  }

  return null;
}

function defaultStaleGuardBlockReconciler(pr: GhPrListEntry): StaleGuardBlockReconciliationResult {
  try {
    const reconciled = setWavemillReady(pr.number);
    return { ok: true, labels: reconciled.labels };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function blockedLabelCanBeReconciledFromGuardPass(
  pr: GhPrListEntry,
  guardState: ReadyGuardState | null,
): guardState is ReadyGuardState & { guard: CrossPrRevertGuardEvidence } {
  if (!pr.headRefOid || !guardState?.guard) {
    return false;
  }

  return (
    guardState.status === 'completed'
    && (guardState.verdict === 'pass' || guardState.verdict === 'warn')
    && guardState.guard.outcome === 'pass'
    && guardState.guard.headSha === pr.headRefOid
    && (!guardState.readyHeadSha || guardState.readyHeadSha === pr.headRefOid)
  );
}

function readReadyGuardStateForPr(
  pr: GhPrListEntry,
  metadata: PrMetadata | null,
  repoDir: string,
): ReadyGuardState | null {
  const stateDir = findReadyStateDir(pr, metadata, repoDir);
  if (!stateDir) {
    return null;
  }

  const resultFile = join(stateDir, '.ready-result.json');
  if (!existsSync(resultFile)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(resultFile, 'utf-8')) as {
      status?: unknown;
      artifacts?: {
        verdict?: unknown;
        readyLabelsUpdated?: unknown;
        readyHeadSha?: unknown;
        crossPrRevertGuard?: unknown;
      };
    };
    const artifacts = parsed.artifacts && typeof parsed.artifacts === 'object' ? parsed.artifacts : {};
    const guard = parseCrossPrRevertGuardEvidence(artifacts.crossPrRevertGuard);
    return {
      status: typeof parsed.status === 'string' ? parsed.status : undefined,
      verdict: typeof artifacts.verdict === 'string' ? artifacts.verdict : undefined,
      readyLabelsUpdated: typeof artifacts.readyLabelsUpdated === 'boolean' ? artifacts.readyLabelsUpdated : undefined,
      readyHeadSha: typeof artifacts.readyHeadSha === 'string' ? artifacts.readyHeadSha : undefined,
      guard,
    };
  } catch {
    return null;
  }
}

function parseCrossPrRevertGuardEvidence(value: unknown): CrossPrRevertGuardEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const outcome = record.outcome;
  if (outcome !== 'pass' && outcome !== 'policy-fail' && outcome !== 'tool-fail') {
    return undefined;
  }
  return {
    prNumber: typeof record.prNumber === 'number' ? record.prNumber : undefined,
    headSha: typeof record.headSha === 'string' ? record.headSha : undefined,
    outcome,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : undefined,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  };
}

function findReadyStateDir(pr: GhPrListEntry, metadata: PrMetadata | null, repoDir: string): string | null {
  const taskId = metadata?.task;
  if (!taskId) {
    return null;
  }

  for (const candidate of readyStateDirsFromWorkflowState(taskId, repoDir)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const root of ['features', 'bugs']) {
    const rootDir = join(repoDir, root);
    if (!existsSync(rootDir)) {
      continue;
    }
    for (const entry of safeReadDirNames(rootDir)) {
      const stateDir = join(rootDir, entry);
      if (selectedTaskMatches(stateDir, taskId)) {
        return stateDir;
      }
    }
  }

  const branchSlug = pr.headRefName.replace(/^(task|bug)\//, '');
  for (const root of ['features', 'bugs']) {
    const candidate = join(repoDir, root, branchSlug);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function readyStateDirsFromWorkflowState(taskId: string, repoDir: string): string[] {
  const stateFile = join(repoDir, '.wavemill', 'workflow-state.json');
  if (!existsSync(stateFile)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as { tasks?: Record<string, unknown> };
    const tasks = parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {};
    const candidates = [taskId, taskId.replace(/-/g, '_')];
    const dirs: string[] = [];
    for (const key of candidates) {
      const task = tasks[key];
      if (!task || typeof task !== 'object') {
        continue;
      }
      const record = task as Record<string, unknown>;
      const slug = typeof record.slug === 'string' ? record.slug : undefined;
      const worktree = typeof record.worktree === 'string' ? record.worktree : undefined;
      if (worktree && slug) {
        dirs.push(join(worktree, 'features', slug), join(worktree, 'bugs', slug));
      }
      if (slug) {
        dirs.push(join(repoDir, 'features', slug), join(repoDir, 'bugs', slug));
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

function selectedTaskMatches(stateDir: string, taskId: string): boolean {
  const selectedTaskPath = join(stateDir, 'selected-task.json');
  if (!existsSync(selectedTaskPath)) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(selectedTaskPath, 'utf-8')) as { taskId?: unknown };
    return parsed.taskId === taskId;
  } catch {
    return false;
  }
}

function safeReadDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function removeCandidatesWithBlockedDependencies(eligible: EligibleWorkItem[]): {
  eligible: EligibleWorkItem[];
  blocked: BlockedCandidate[];
} {
  let remaining = [...eligible];
  const blocked: BlockedCandidate[] = [];
  let changed = true;

  while (changed) {
    changed = false;
    const remainingNumbers = new Set(remaining.map((item) => item.pr.number));
    const nextRemaining: EligibleWorkItem[] = [];

    for (const item of remaining) {
      const deps = getPrDependencies(item.metadata);
      const hasMissingEligibleDependency = deps.some((dependency) => !remainingNumbers.has(dependency));

      if (hasMissingEligibleDependency) {
        blocked.push(toBlockedCandidate(item.pr, 'deps-unresolved'));
        changed = true;
      } else {
        nextRemaining.push(item);
      }
    }

    remaining = nextRemaining;
  }

  return { eligible: remaining, blocked };
}

function computeDependencyDepths(eligible: EligibleWorkItem[]): {
  eligible: Array<EligibleWorkItem & { dependencyDepth: number }>;
  cycleBlocked: BlockedCandidate[];
} {
  const itemByNumber = new Map(eligible.map((item) => [item.pr.number, item]));
  const depths = new Map<number, number>();
  const visiting: number[] = [];
  const cycleMembers = new Set<number>();

  function visit(prNumber: number): number {
    if (depths.has(prNumber)) {
      return depths.get(prNumber) ?? 0;
    }

    const activeIndex = visiting.indexOf(prNumber);
    if (activeIndex !== -1) {
      for (const cyclePrNumber of visiting.slice(activeIndex)) {
        cycleMembers.add(cyclePrNumber);
      }
      cycleMembers.add(prNumber);
      return 0;
    }

    const item = itemByNumber.get(prNumber);
    if (!item) {
      return 0;
    }

    visiting.push(prNumber);
    const dependencyDepths = getPrDependencies(item.metadata)
      .filter((dependency) => itemByNumber.has(dependency))
      .map((dependency) => visit(dependency));
    visiting.pop();

    const depth = dependencyDepths.length === 0 ? 0 : Math.max(...dependencyDepths) + 1;
    depths.set(prNumber, depth);
    return depth;
  }

  for (const item of eligible) {
    visit(item.pr.number);
  }

  const cycleBlocked = eligible
    .filter((item) => cycleMembers.has(item.pr.number))
    .map((item) => toBlockedCandidate(item.pr, 'dependency-cycle'));
  const candidates = eligible
    .filter((item) => !cycleMembers.has(item.pr.number))
    .map((item) => ({
      dependencyDepth: depths.get(item.pr.number) ?? 0,
      ...item,
    }));

  return { eligible: candidates, cycleBlocked };
}

function getPrDependencies(metadata: PrMetadata): number[] {
  return (metadata.depends_on ?? [])
    .map(parseDependencyPrNumber)
    .filter((dependency): dependency is number => dependency !== null);
}

function parseDependencyPrNumber(dependency: string): number | null {
  const match = dependency.match(PR_DEPENDENCY_PATTERN);
  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function labelSet(pr: GhPrListEntry): Set<string> {
  return new Set(pr.labels.map((label) => label.name));
}

function toBlockedCandidate(pr: GhPrListEntry, reason: string): BlockedCandidate {
  return {
    number: pr.number,
    title: pr.title,
    headBranch: pr.headRefName,
    reason,
  };
}

function resolveOwnerRepoFromRemote(repoDir: string): string | null {
  const remoteUrl = String(execShellCommand('git remote get-url origin', {
    encoding: 'utf-8',
    cwd: repoDir,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  })).trim();
  const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);

  return match?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim();
}

function outputFromError(error: unknown): string {
  if (error && typeof error === 'object') {
    const maybeExecError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const output = [maybeExecError.stdout, maybeExecError.stderr]
      .map((value) => value === undefined || value === null ? '' : String(value))
      .filter((value) => value.length > 0)
      .join('\n');
    if (output.trim()) {
      return output;
    }
    if (typeof maybeExecError.message === 'string') {
      return maybeExecError.message;
    }
  }

  return String(error);
}
