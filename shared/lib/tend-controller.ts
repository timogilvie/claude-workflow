import { join } from 'node:path';
import { getIntegrationConfig, getIntegrationReadyPolicy } from './config.ts';
import { readChallengeComparisons } from './challenge-comparison.ts';
import { getPullRequest } from './github.ts';
import { getIssueCompletionState } from './linear.ts';
import { extractMetadataBlock, parsePrMetadata, type PrMetadata } from './pr-metadata.ts';
import { setWavemillBlocked, setWavemillMerged, setWavemillMerging, WM_LABELS } from './pr-state-labels.ts';
import { evaluateReady } from './ready-engine.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';

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

export interface SelectNextCandidateOptions {
  repoDir: string;
  prFetcher?: PrFetcher;
  healthChecker?: HealthChecker;
}

interface EligibleWorkItem {
  pr: GhPrListEntry;
  metadata: PrMetadata;
}

const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const PR_DEPENDENCY_PATTERN = /^PR#(\d+)$/i;
const FAILING_CHECK_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled']);

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

  const eligible = cycleResult.eligible
    .sort((a, b) => a.dependencyDepth - b.dependencyDepth || a.createdAt.localeCompare(b.createdAt));

  return {
    integrationHealth,
    eligible,
    blocked,
    nextPR: eligible[0]?.number ?? null,
  };
}

export function formatStatusLine(decision: TendDecision): string {
  const health = decision.integrationHealth.reason
    ? `${decision.integrationHealth.state}:${decision.integrationHealth.reason}`
    : decision.integrationHealth.state;
  const next = decision.nextPR === null ? 'none' : `PR#${decision.nextPR}`;

  return `tend: integration=${health} eligible=${decision.eligible.length} blocked=${decision.blocked.length} next=${next}`;
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
  if (!BRANCH_NAME_PATTERN.test(integrationBranch)) {
    throw new Error('tend: invalid integration branch name');
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
  eligible: TendCandidate[];
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
      number: item.pr.number,
      title: item.pr.title,
      headBranch: item.pr.headRefName,
      createdAt: item.pr.createdAt,
      dependencyDepth: depths.get(item.pr.number) ?? 0,
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

// ─── Execute Merge ────────────────────────────────────────────────────────────

export interface PrChecksResult {
  pass: boolean;
  timedOut?: boolean;
  failed?: string[];
}

export interface ReadyCheckResult {
  pass: boolean;
  reasons?: string[];
}

export type TendOutcome =
  | { status: 'idle' }
  | { status: 'skipped'; reason: 'merging-in-progress'; activePr: number }
  | { status: 'merged'; pr: number }
  | { status: 'continue'; failure: 'rebase' | 'checks' | 'checks-timeout' | 'ready' | 'merge'; prNumber: number }
  | { status: 'halt'; reason: 'integration-red' | 'integration-pending-timeout'; integrationBranch: string };

export interface ExecuteOps {
  prFetcher?: PrFetcher;
  healthChecker?: HealthChecker;
  setMerging?: (prNumber: number) => void;
  setBlocked?: (prNumber: number) => void;
  setMerged?: (prNumber: number) => void;
  gitFetch?: (integrationBranch: string, repoDir: string) => void;
  gitWorktreeAdd?: (worktreePath: string, branch: string, repoDir: string) => void;
  gitWorktreeRemove?: (worktreePath: string, repoDir: string) => void;
  gitRebase?: (onto: string, worktreePath: string) => void;
  gitRebaseAbort?: (worktreePath: string) => void;
  gitGetRemoteSha?: (branch: string, repoDir: string) => string;
  gitForcePush?: (branch: string, expectedSha: string, repoDir: string) => void;
  pollPrChecks?: (prNumber: number, repoDir: string, timeoutMs: number) => Promise<PrChecksResult>;
  runReadyCheck?: (prNumber: number, repoDir: string) => Promise<ReadyCheckResult>;
  mergePr?: (prNumber: number, method: string, repoDir: string) => void;
  postComment?: (prNumber: number, body: string, repoDir: string) => void;
}

export interface ExecuteMergeOptions {
  repoDir: string;
  checksTimeoutMs?: number;
  ops?: ExecuteOps;
}

const CHECKS_POLL_INTERVAL_MS = 30_000;
const CHECK_PENDING_STATES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'REQUESTED', 'WAITING', 'STARTUP_FAILURE']);

function defaultGitFetch(integrationBranch: string, repoDir: string): void {
  execShellCommand(`git fetch origin ${escapeShellArg(integrationBranch)}`, { encoding: 'utf-8', cwd: repoDir });
}

function defaultGitWorktreeAdd(worktreePath: string, branch: string, repoDir: string): void {
  execShellCommand(
    `git worktree add ${escapeShellArg(worktreePath)} ${escapeShellArg(branch)}`,
    { encoding: 'utf-8', cwd: repoDir },
  );
}

function defaultGitWorktreeRemove(worktreePath: string, repoDir: string): void {
  try {
    execShellCommand(`git worktree remove --force ${escapeShellArg(worktreePath)}`, { encoding: 'utf-8', cwd: repoDir });
  } catch {
    // Best-effort; no-op if worktree does not exist
  }
}

function defaultGitRebase(onto: string, worktreePath: string): void {
  execShellCommand(`git rebase ${escapeShellArg(onto)}`, { encoding: 'utf-8', cwd: worktreePath });
}

function defaultGitRebaseAbort(worktreePath: string): void {
  try {
    execShellCommand('git rebase --abort', { encoding: 'utf-8', cwd: worktreePath });
  } catch {
    // Best-effort
  }
}

function defaultGitGetRemoteSha(branch: string, repoDir: string): string {
  return String(execShellCommand(
    `git rev-parse ${escapeShellArg(`origin/${branch}`)}`,
    { encoding: 'utf-8', cwd: repoDir },
  )).trim();
}

function defaultGitForcePush(branch: string, expectedSha: string, repoDir: string): void {
  const leaseSpec = `${branch}:${expectedSha}`;
  execShellCommand(
    `git push --force-with-lease=${escapeShellArg(leaseSpec)} origin ${escapeShellArg(branch)}`,
    { encoding: 'utf-8', cwd: repoDir },
  );
}

function defaultPostComment(prNumber: number, body: string, repoDir: string): void {
  execShellCommand(
    `gh pr comment ${escapeShellArg(String(prNumber))} --body ${escapeShellArg(body)}`,
    { encoding: 'utf-8', cwd: repoDir },
  );
}

function defaultMergePr(prNumber: number, method: string, repoDir: string): void {
  execShellCommand(
    `gh pr merge ${escapeShellArg(String(prNumber))} --${escapeShellArg(method)}`,
    { encoding: 'utf-8', cwd: repoDir },
  );
}

async function defaultPollPrChecks(prNumber: number, repoDir: string, timeoutMs: number): Promise<PrChecksResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let raw: string;
    try {
      raw = String(execShellCommand(
        `gh pr checks ${escapeShellArg(String(prNumber))} --json name,state,conclusion`,
        { encoding: 'utf-8', cwd: repoDir },
      ));
    } catch {
      raw = '[]';
    }

    const checks = JSON.parse(raw) as Array<{ name: string; state: string; conclusion: string | null }>;

    if (checks.length > 0) {
      const failed = checks.filter((c) => FAILING_CHECK_CONCLUSIONS.has(c.conclusion ?? ''));
      if (failed.length > 0) {
        return { pass: false, failed: failed.map((c) => c.name) };
      }

      const pending = checks.filter((c) => CHECK_PENDING_STATES.has(c.state));
      if (pending.length === 0) {
        return { pass: true };
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(CHECKS_POLL_INTERVAL_MS, remaining)));
  }

  return { pass: false, timedOut: true };
}

async function defaultRunReadyCheck(prNumber: number, repoDir: string): Promise<ReadyCheckResult> {
  const readyPolicy = getIntegrationReadyPolicy(repoDir);
  const integration = getIntegrationConfig(repoDir);
  const pr = getPullRequest(prNumber, { cwd: repoDir });
  const verdict = await evaluateReady({
    pr: {
      number: pr.number,
      url: pr.url,
      baseBranch: pr.baseRefName,
      body: pr.body ?? '',
      labels: pr.labels.map((l) => l.name),
      mergedAt: pr.mergedAt,
    },
    config: {
      ...readyPolicy,
      integrationBranch: readyPolicy.integrationBranch ?? integration.integrationBranch,
    },
    async fetchPrState(depPrNumber) {
      try {
        const depPr = getPullRequest(depPrNumber, { cwd: repoDir });
        const state = depPr.mergedAt ? 'MERGED' : depPr.state === 'OPEN' ? 'OPEN' : 'CLOSED';
        return { state, mergedAt: depPr.mergedAt };
      } catch (err) {
        if ((err as Error).message.includes('not found')) return null;
        throw err;
      }
    },
    async fetchLinearIssueState(identifier) {
      try {
        const issue = await getIssueCompletionState(identifier);
        return { completedAt: issue.completedAt ?? null, canceledAt: issue.canceledAt ?? null };
      } catch (err) {
        if ((err as Error).message.includes('Issue not found')) return null;
        throw err;
      }
    },
    readChallengeComparisons,
  });

  return {
    pass: verdict.status === 'pass' || verdict.status === 'warn',
    reasons: verdict.reasons,
  };
}

async function checkForActiveMerge(
  prFetcher: PrFetcher,
  integrationBranch: string,
  repoDir: string,
): Promise<number | null> {
  const allPrs = await prFetcher(integrationBranch, repoDir);
  const mergingPr = allPrs.find((p) => labelSet(p).has(WM_LABELS.merging));
  return mergingPr?.number ?? null;
}

export async function executeMerge(options: ExecuteMergeOptions): Promise<TendOutcome> {
  const { repoDir, checksTimeoutMs = 30 * 60 * 1000 } = options;
  const ops = options.ops ?? {};

  const integrationBranch = getConfiguredIntegrationBranch(repoDir);
  const config = getIntegrationConfig(repoDir);

  const healthChecker = ops.healthChecker ?? defaultHealthChecker;
  const prFetcher = ops.prFetcher ?? defaultPrFetcher;
  const doSetMerging = ops.setMerging ?? ((n: number) => { setWavemillMerging(n); });
  const doSetBlocked = ops.setBlocked ?? ((n: number) => { setWavemillBlocked(n); });
  const doSetMerged = ops.setMerged ?? ((n: number) => { setWavemillMerged(n); });
  const gitFetch = ops.gitFetch ?? defaultGitFetch;
  const gitWorktreeAdd = ops.gitWorktreeAdd ?? defaultGitWorktreeAdd;
  const gitWorktreeRemove = ops.gitWorktreeRemove ?? defaultGitWorktreeRemove;
  const gitRebase = ops.gitRebase ?? defaultGitRebase;
  const gitRebaseAbort = ops.gitRebaseAbort ?? defaultGitRebaseAbort;
  const gitGetRemoteSha = ops.gitGetRemoteSha ?? defaultGitGetRemoteSha;
  const gitForcePush = ops.gitForcePush ?? defaultGitForcePush;
  const pollPrChecks = ops.pollPrChecks ?? defaultPollPrChecks;
  const runReadyCheck = ops.runReadyCheck ?? defaultRunReadyCheck;
  const mergePr = ops.mergePr ?? defaultMergePr;
  const postComment = ops.postComment ?? defaultPostComment;

  // Bail early if integration is already unhealthy
  const initialHealth = await healthChecker(integrationBranch, repoDir);
  if (initialHealth.state === 'unhealthy') {
    return { status: 'idle' };
  }

  // Serialization: refuse if another PR is already being merged
  const activeMergePr = await checkForActiveMerge(prFetcher, integrationBranch, repoDir);
  if (activeMergePr !== null) {
    return { status: 'skipped', reason: 'merging-in-progress', activePr: activeMergePr };
  }

  // Select the next eligible PR
  const decision = await selectNextCandidate({ repoDir, prFetcher, healthChecker });
  if (decision.nextPR === null) {
    return { status: 'idle' };
  }

  const prNumber = decision.nextPR;
  const nextCandidate = decision.eligible.find((c) => c.number === prNumber);
  if (!nextCandidate) {
    return { status: 'idle' };
  }

  const headBranch = nextCandidate.headBranch;
  const worktreePath = join(repoDir, '.wavemill', 'tend-worktree');

  // Claim the PR (removes wm:ready)
  doSetMerging(prNumber);

  // Pre-cleanup: remove stale scratch worktree if present
  gitWorktreeRemove(worktreePath, repoDir);

  try {
    gitFetch(integrationBranch, repoDir);

    // Capture remote SHA before rebase for force-with-lease
    const expectedSha = gitGetRemoteSha(headBranch, repoDir);

    gitWorktreeAdd(worktreePath, headBranch, repoDir);

    // Rebase
    try {
      gitRebase(`origin/${integrationBranch}`, worktreePath);
    } catch (rebaseErr) {
      try { gitRebaseAbort(worktreePath); } catch { /* best effort */ }
      const msg = `Rebase onto \`origin/${integrationBranch}\` failed: ${errorMessage(rebaseErr)}`;
      postComment(prNumber, `[wavemill] Merge blocked: ${msg}`, repoDir);
      doSetBlocked(prNumber);
      return { status: 'continue', failure: 'rebase', prNumber };
    }

    // Force push with lease keyed to the pre-rebase remote SHA
    try {
      gitForcePush(headBranch, expectedSha, repoDir);
    } catch (pushErr) {
      const msg = `Force push failed (remote tip changed?): ${errorMessage(pushErr)}`;
      postComment(prNumber, `[wavemill] Merge blocked: ${msg}`, repoDir);
      doSetBlocked(prNumber);
      return { status: 'continue', failure: 'rebase', prNumber };
    }

    // Poll CI checks
    const checksResult = await pollPrChecks(prNumber, repoDir, checksTimeoutMs);
    if (!checksResult.pass) {
      const failure = checksResult.timedOut ? 'checks-timeout' : 'checks';
      const msg = checksResult.timedOut
        ? 'PR checks timed out waiting for completion'
        : `PR checks failed: ${(checksResult.failed ?? []).join(', ')}`;
      postComment(prNumber, `[wavemill] Merge blocked: ${msg}`, repoDir);
      doSetBlocked(prNumber);
      return { status: 'continue', failure, prNumber };
    }

    // Ready check
    const readyResult = await runReadyCheck(prNumber, repoDir);
    if (!readyResult.pass) {
      const reasons = (readyResult.reasons ?? []).join('; ');
      postComment(prNumber, `[wavemill] Merge blocked: Ready check failed: ${reasons}`, repoDir);
      doSetBlocked(prNumber);
      return { status: 'continue', failure: 'ready', prNumber };
    }

    // Merge
    try {
      mergePr(prNumber, config.mergeMethod, repoDir);
    } catch (mergeErr) {
      const msg = `Merge failed: ${errorMessage(mergeErr)}`;
      postComment(prNumber, `[wavemill] Merge blocked: ${msg}`, repoDir);
      doSetBlocked(prNumber);
      return { status: 'continue', failure: 'merge', prNumber };
    }

    doSetMerged(prNumber);

    // Verify integration health after merge (halt on red)
    const postMergeHealth = await healthChecker(integrationBranch, repoDir);
    if (postMergeHealth.state === 'unhealthy') {
      return { status: 'halt', reason: 'integration-red', integrationBranch };
    }

    return { status: 'merged', pr: prNumber };
  } finally {
    gitWorktreeRemove(worktreePath, repoDir);
  }
}
