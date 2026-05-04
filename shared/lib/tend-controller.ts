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
import { applyChallengePairGates, type ChallengeGateOptions } from './tend-challenge-gate.ts';

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
  shellRunner: (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;
  readyChecker: (prNumber: number, repoDir: string) => Promise<{ ready: boolean; reason?: string }>;
  healthChecker: HealthChecker;
  acquireMerging: (prNumber: number) => void;
  releaseToBlocked: (prNumber: number) => void;
  releaseMerged: (prNumber: number) => void;
  restoreReady: (prNumber: number) => void;
}

export interface ExecuteMergeOptions {
  repoDir: string;
  deps?: Partial<MergeExecutionDeps>;
}

export interface GhPrListEntry {
  number: number;
  title: string;
  headRefName: string;
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
  loserCleanup?: (prNumber: number, repoDir: string) => void;
  challengeGateOptions?: ChallengeGateOptions;
}

interface EligibleWorkItem {
  pr: GhPrListEntry;
  metadata: PrMetadata;
}

const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const PR_DEPENDENCY_PATTERN = /^PR#(\d+)$/i;
const FAILING_CHECK_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled']);
const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const FAILING_CHECK_BUCKETS = new Set(['fail', 'cancel']);
const PASSING_CHECK_BUCKETS = new Set(['pass', 'skipping']);
const CHECK_POLL_INTERVAL_MS = 30_000;

export async function defaultPrFetcher(integrationBranch: string, repoDir: string): Promise<GhPrListEntry[]> {
  validateIntegrationBranch(integrationBranch);

  const output = String(execShellCommand(
    [
      'gh',
      'pr',
      'list',
      '--base',
      escapeShellArg(integrationBranch),
      '--state',
      'open',
      '--json',
      'number,title,headRefName,createdAt,isDraft,labels,body',
    ].join(' '),
    { encoding: 'utf-8', cwd: repoDir },
  ));
  const parsed = JSON.parse(output) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('tend: gh pr list returned non-array JSON');
  }

  return parsed as GhPrListEntry[];
}

export async function defaultHealthChecker(integrationBranch: string, repoDir: string): Promise<IntegrationHealth> {
  try {
    validateIntegrationBranch(integrationBranch);

    const sha = String(execShellCommand(
      `git rev-parse ${escapeShellArg(integrationBranch)} 2>/dev/null`,
      { encoding: 'utf-8', cwd: repoDir },
    )).trim();
    const repo = resolveOwnerRepoFromRemote(repoDir);

    if (!repo) {
      return { state: 'unhealthy', reason: 'health-check-error: unable to resolve origin repo' };
    }

    const raw = String(execShellCommand(
      `gh api ${escapeShellArg(`repos/${repo}/commits/${sha}/check-runs`)}`,
      { encoding: 'utf-8', cwd: repoDir },
    ));
    const parsed = JSON.parse(raw) as { check_runs?: Array<{ name?: string; conclusion?: string | null }> };
    const checkRuns = Array.isArray(parsed.check_runs) ? parsed.check_runs : [];

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
  const blocked: BlockedCandidate[] = [];
  let eligibleWorkItems: EligibleWorkItem[] = [];

  for (const pr of wavemillPrs) {
    const metadataResult = getValidMetadata(pr.body);
    const reason = getInitialBlockReason(pr, metadataResult.metadata, openPrNumbers);

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

  const challengeResult = applyChallengePairGates(cycleResult.eligible, blocked, options.repoDir, options.challengeGateOptions);
  blocked.length = 0;
  blocked.push(...challengeResult.blocked);

  const cleanupLoser = options.loserCleanup ?? defaultLoserCleanup;
  for (const loserPr of challengeResult.losers) {
    try {
      cleanupLoser(loserPr, options.repoDir);
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
  opts: { action?: string; lastPR?: number | null } = {},
): string {
  const health = decision.integrationHealth.state === 'healthy' ? 'ok' : 'degraded';
  const last = typeof opts.lastPR === 'number' ? `#${opts.lastPR}` : 'none';
  const action = opts.action ?? 'idle';

  return `eligible=${decision.eligible.length} blocked=${decision.blocked.length} health=${health} last=${last} action=${action}`;
}

export async function executeMerge(
  candidate: TendCandidate,
  options: ExecuteMergeOptions,
): Promise<MergeExecutionResult> {
  const deps = mergeExecutionDeps(options.deps);
  const integrationConfig = getIntegrationConfig(options.repoDir);
  const integrationBranch = getConfiguredIntegrationBranch(options.repoDir);

  validateBranchName(candidate.headBranch, 'PR branch');

  const activeMerges = listMergingPrs(options.repoDir, deps.shellRunner);
  if (activeMerges.length > 0) {
    return { status: 'skipped', prNumber: candidate.number, haltLoop: false };
  }

  try {
    deps.acquireMerging(candidate.number);
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

        const checks = await waitForChecks(candidate.number, options.repoDir, deps.shellRunner);
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
          const mergeFlag = `--${integrationConfig.mergeMethod}`;
          const deleteBranchFlag = integrationConfig.deleteBranchAfterMerge ? ' --delete-branch' : '';
          deps.shellRunner(
            `gh pr merge ${candidate.number} ${mergeFlag}${deleteBranchFlag}`,
            { encoding: 'utf-8', cwd: options.repoDir },
          );
        } catch (error) {
          return block('merge', outputFromError(error));
        }

        deps.releaseMerged(candidate.number);
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
    postFailureComment(
      candidate.number,
      buildFailureComment('integration', `Integration branch \`${integrationBranch}\` is unhealthy after merge: ${reason}`),
      options.repoDir,
      deps.shellRunner,
    );
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
  })).trim();
  const worktreePath = join(commonGitDir, 'wavemill-tend', String(prNumber));

  // Fetch the latest remote tip for the PR branch so the detached worktree
  // operates on what GitHub considers the branch's current state, not a
  // possibly-stale local ref.
  shellRunner(
    `git fetch origin ${escapeShellArg(prBranch)} 2>&1`,
    { encoding: 'utf-8', cwd: repoDir },
  );

  // Use --detach so this worktree gets a detached HEAD at the PR's remote
  // tip rather than checking out the branch by name. Mill creates its own
  // task worktree that already holds <prBranch> checked out, and git refuses
  // to check out the same branch in two worktrees. Tend doesn't need branch
  // ownership — it just needs the tree at that commit so it can rebase and
  // push back to origin's <prBranch> ref by name (see rebaseAndPush).
  shellRunner(
    `git worktree add --detach ${escapeShellArg(worktreePath)} ${escapeShellArg(`origin/${prBranch}`)}`,
    { encoding: 'utf-8', cwd: repoDir },
  );

  try {
    return await fn(worktreePath);
  } finally {
    try {
      shellRunner(
        `git worktree remove --force ${escapeShellArg(worktreePath)}`,
        { encoding: 'utf-8', cwd: repoDir },
      );
    } catch {
      // A cleanup failure should not change the PR's merge outcome.
    }
  }
}

function listMergingPrs(repoDir: string, shellRunner: MergeExecutionDeps['shellRunner']): number[] {
  const output = shellRunner(
    `gh pr list --label ${escapeShellArg(WM_LABELS.merging)} --state open --json number`,
    { encoding: 'utf-8', cwd: repoDir },
  );
  const parsed = JSON.parse(String(output)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('tend: gh pr list returned non-array JSON');
  }
  return parsed
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { number?: unknown }).number : null))
    .filter((number): number is number => typeof number === 'number');
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
    { encoding: 'utf-8', cwd: worktreePath },
  )));

  // Capture the PR branch SHA before rebase for SHA-keyed force-with-lease
  const prRemoteRef = `origin/${prBranch}`;
  const prBranchSha = String(shellRunner(`git rev-parse ${escapeShellArg(prRemoteRef)}`, {
    encoding: 'utf-8',
    cwd: worktreePath,
  })).trim();

  try {
    output.push(String(shellRunner(
      `git rebase ${escapeShellArg(`origin/${integrationBranch}`)} 2>&1`,
      { encoding: 'utf-8', cwd: worktreePath },
    )));
  } catch (error) {
    // Explicitly abort rebase on failure
    try {
      shellRunner('git rebase --abort 2>&1', { encoding: 'utf-8', cwd: worktreePath });
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
    { encoding: 'utf-8', cwd: worktreePath },
  )));

  return output.join('\n');
}

export async function waitForChecks(
  prNumber: number,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
  timeoutMs = 30 * 60 * 1000,
): Promise<CheckWaitResult> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const output = readPrChecks(prNumber, repoDir, shellRunner);
    const checks = parseCheckRuns(output);
    const failed = checks.find((check) => isFailingCheck(check));
    if (failed) {
      return { outcome: 'fail', summary: summarizeChecks(checks) };
    }

    if (checks.length > 0 && checks.every((check) => isPassingCheck(check))) {
      return { outcome: 'pass', summary: summarizeChecks(checks) };
    }

    if (Date.now() >= deadline) {
      return {
        outcome: 'timeout',
        summary: summarizeChecks(checks),
      };
    }

    await sleep(CHECK_POLL_INTERVAL_MS);
  }
}

function readPrChecks(
  prNumber: number,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
): string {
  const output = shellRunner(
    `gh pr checks ${prNumber} --json name,state,bucket 2>&1 || true`,
    { encoding: 'utf-8', cwd: repoDir },
  );
  if (String(output).includes('no checks reported')) {
    return '[]';
  }
  return output;
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
    { encoding: 'utf-8', cwd: repoDir },
  );
}

function mergeExecutionDeps(deps: Partial<MergeExecutionDeps> | undefined): MergeExecutionDeps {
  return {
    shellRunner: (cmd, opts) => String(execShellCommand(cmd, opts)),
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
    ...deps,
  };
}

function defaultLoserCleanup(prNumber: number, repoDir: string): void {
  setWavemillSuperseded(prNumber);
  execShellCommand(
    `gh pr close ${prNumber} --comment ${escapeShellArg('Closed: lost challenge comparison.')}`,
    { encoding: 'utf-8', cwd: repoDir },
  );
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

function summarizeChecks(checks: PrCheckRun[]): string {
  if (checks.length === 0) {
    return 'No PR checks reported.';
  }
  return checks
    .map((check) => `${check.name || 'check'}: ${check.conclusion || check.bucket || check.state || 'pending'}`)
    .join('\n');
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
): string | null {
  const labels = labelSet(pr);

  if (pr.isDraft) {
    return 'draft';
  }

  if (labels.has(WM_LABELS.blocked)) {
    return 'blocked-label';
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
