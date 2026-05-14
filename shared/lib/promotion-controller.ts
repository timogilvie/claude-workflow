import { writeFileSync } from 'fs';
import { confirm } from './cli-prompt.ts';
import { getIntegrationConfig } from './config.ts';
import { WM_LABELS } from './pr-state-labels.ts';
import { errorMessage } from './error-utils.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import {
  defaultHealthChecker,
  waitForChecks,
  type CheckWaitResult,
  type HealthChecker,
  type IntegrationHealth,
} from './tend-controller.ts';

export interface PromotionResult {
  status: 'opened' | 'updated' | 'noop' | 'blocked';
  prUrl?: string;
  checkSummary?: string;
  blockReason?: 'base-behind' | 'base-behind-conflicts' | 'base-unknown';
  blockSummary?: string;
}

export interface PromotionOptions {
  repoDir: string;
  dryRun?: boolean;
  shellRunner?: (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;
  healthChecker?: HealthChecker;
  confirmUpdate?: (message: string) => Promise<boolean>;
  interactive?: boolean;
}

type ShellRunner = NonNullable<PromotionOptions['shellRunner']>;

interface PromotionPr {
  number: number;
  url: string;
  body?: string;
}

interface MergedPrSummary {
  number: number;
  title: string;
  url?: string;
  mergedAt?: string;
  labels?: Array<{ name: string }>;
}

type PromotionBlockReason = NonNullable<PromotionResult['blockReason']>;

interface PromotionBaseState {
  remoteRef: string;
  tip: string;
}

interface BaseContainment {
  status: 'up-to-date' | 'behind';
}

interface MergePrediction {
  status: 'clean' | 'conflicts' | 'unknown';
  detail?: string;
}

export interface BranchBaseUpdateResult {
  status: 'success' | 'conflict' | 'push-failed' | 'fetch-failed' | 'dirty-worktree' | 'unknown-failed';
  detail: string;
}

const PROMOTION_SECTION_BEGIN = '<!-- wavemill-promote:begin -->';
const PROMOTION_SECTION_END = '<!-- wavemill-promote:end -->';
const RECENT_PR_LIMIT = 10;
const RECENT_COMMIT_LIMIT = 10;

export async function runPromotion(options: PromotionOptions): Promise<PromotionResult> {
  const shellRunner = options.shellRunner ?? ((cmd, opts) => String(execShellCommand(cmd, opts)));
  const healthChecker = options.healthChecker ?? defaultHealthChecker;
  const config = getIntegrationConfig(options.repoDir);
  const integrationBranch = config.integrationBranch;
  const promotionBranch = config.promotionBranch;
  const interactive = options.interactive ?? process.stdin.isTTY === true;
  const confirmUpdate = options.confirmUpdate ?? ((message: string) => confirm(message));

  const currentPr = findExistingPromotionPr(integrationBranch, promotionBranch, options.repoDir, shellRunner);
  let promotionBase: PromotionBaseState;
  try {
    promotionBase = fetchPromotionBase(promotionBranch, options.repoDir, shellRunner);
  } catch (error) {
    return buildBlockedPromotionResult({
      blockReason: 'base-unknown',
      blockSummary: formatBaseBehindSummary(
        'base-unknown',
        integrationBranch,
        remoteBranchRef(promotionBranch),
        errorMessage(error),
      ),
      prUrl: currentPr?.url,
      checkSummary: currentPr
        ? formatCheckSummary(await waitForChecks(
          currentPr.number,
          options.repoDir,
          shellRunner,
          { timeoutMs: 0, requiredChecks: config.requiredChecks },
        ))
        : undefined,
    });
  }
  let integrationTip = resolveBranchTip(integrationBranch, options.repoDir, shellRunner);
  const promotionTip = promotionBase.tip;
  const promotionTree = resolveCommitTree(promotionTip, options.repoDir, shellRunner);
  const promotionTipIsIntegrated = isAncestor(promotionTip, integrationTip, options.repoDir, shellRunner);
  const matchingPromotionTreeCommit = promotionTipIsIntegrated
    ? null
    : findIntegrationCommitWithTree(
      integrationBranch,
      promotionTree,
      options.repoDir,
      shellRunner,
    );
  const baseContainment = classifyBaseContainment(
    promotionTip,
    integrationTip,
    options.repoDir,
    shellRunner,
  );

  if (baseContainment.status === 'behind' && !matchingPromotionTreeCommit) {
    const blockedResult = await handleBaseBehind({
      config,
      integrationBranch,
      promotionBranch,
      promotionBase,
      integrationTip,
      repoDir: options.repoDir,
      shellRunner,
      currentPr,
      interactive,
      dryRun: options.dryRun,
      confirmUpdate,
    });

    if (blockedResult) {
      return blockedResult;
    }

    integrationTip = resolveBranchTip(integrationBranch, options.repoDir, shellRunner);
  }

  const comparisonBase =
    matchingPromotionTreeCommit && matchingPromotionTreeCommit !== integrationTip
      ? matchingPromotionTreeCommit
      : promotionBase.remoteRef;

  integrationTip = reconcileSquashMergedPromotion({
    integrationBranch,
    promotionBranch: promotionBase.remoteRef,
    integrationTip,
    promotionTip,
    promotionTree,
    matchingPromotionTreeCommit,
    repoDir: options.repoDir,
    shellRunner,
    dryRun: options.dryRun,
  });

  if (isAlreadyPromoted(integrationTip, promotionBase.remoteRef, options.repoDir, shellRunner)) {
    return { status: 'noop' };
  }

  let health: IntegrationHealth;
  try {
    health = await healthChecker(integrationBranch, options.repoDir);
  } catch (error) {
    health = { state: 'unhealthy', reason: `health-check-error: ${errorMessage(error)}` };
  }

  const recentCommits = listRecentIntegrationCommits(comparisonBase, integrationBranch, options.repoDir, shellRunner);
  const recentPrs = listRecentMergedWavemillPrs(
    integrationBranch,
    extractPrNumbers(recentCommits),
    options.repoDir,
    shellRunner,
  );
  const nextBody = updatePromotionSection(
    currentPr?.body ?? '',
    renderPromotionSection({
      integrationBranch,
      promotionBranch,
      health,
      recentPrs,
      recentCommits,
    }),
  );

  const status: PromotionResult['status'] = currentPr ? 'updated' : 'opened';
  if (!options.dryRun) {
    if (currentPr) {
      updatePromotionPrBody(currentPr.number, nextBody, shellRunner, options.repoDir);
    } else {
      const bodyFile = writeBodyToTempFile(nextBody, shellRunner, options.repoDir);
      try {
        const title = `chore: promote ${integrationBranch} to ${promotionBranch}`;
        shellRunner(
          [
            'gh',
            'pr',
            'create',
            '--head',
            escapeShellArg(integrationBranch),
            '--base',
            escapeShellArg(promotionBranch),
            '--title',
            escapeShellArg(title),
            '--body-file',
            escapeShellArg(bodyFile),
          ].join(' '),
          { encoding: 'utf-8', cwd: options.repoDir },
        );
      } finally {
        shellRunner(`rm -f ${escapeShellArg(bodyFile)}`, { encoding: 'utf-8', cwd: options.repoDir });
      }
    }
  }

  const promotionPr = currentPr ?? findExistingPromotionPr(integrationBranch, promotionBranch, options.repoDir, shellRunner);
  const checkSummary = promotionPr
    ? formatCheckSummary(await waitForChecks(
      promotionPr.number,
      options.repoDir,
      shellRunner,
      { timeoutMs: 0, requiredChecks: config.requiredChecks },
    ))
    : undefined;

  return {
    status,
    prUrl: promotionPr?.url,
    checkSummary,
  };
}

function fetchPromotionBase(
  promotionBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): PromotionBaseState {
  try {
    shellRunner(
      `git fetch --quiet origin ${escapeShellArg(promotionBranch)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
  } catch (error) {
    throw new Error(`promote: failed to fetch origin/${promotionBranch}: ${errorMessage(error)}`);
  }

  const remoteRef = remoteBranchRef(promotionBranch);
  try {
    return {
      remoteRef,
      tip: resolveBranchTip(remoteRef, repoDir, shellRunner),
    };
  } catch {
    throw new Error(`promote: remote promotion branch not found: ${remoteRef}`);
  }
}

function remoteBranchRef(branch: string): string {
  return `origin/${branch}`;
}

function resolveBranchTip(
  branch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): string {
  try {
    return String(shellRunner(
      `git rev-parse ${escapeShellArg(branch)} 2>/dev/null`,
      { encoding: 'utf-8', cwd: repoDir },
    )).trim();
  } catch {
    throw new Error(`promote: branch not found: ${branch}`);
  }
}

function classifyBaseContainment(
  promotionTip: string,
  integrationTip: string,
  repoDir: string,
  shellRunner: ShellRunner,
): BaseContainment {
  return isAncestor(promotionTip, integrationTip, repoDir, shellRunner)
    ? { status: 'up-to-date' }
    : { status: 'behind' };
}

function isAlreadyPromoted(
  integrationTip: string,
  promotionBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): boolean {
  try {
    shellRunner(
      `git merge-base --is-ancestor ${escapeShellArg(integrationTip)} ${escapeShellArg(promotionBranch)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    return true;
  } catch {
    return false;
  }
}

function isAncestor(
  ancestor: string,
  descendant: string,
  repoDir: string,
  shellRunner: ShellRunner,
): boolean {
  try {
    shellRunner(
      `git merge-base --is-ancestor ${escapeShellArg(ancestor)} ${escapeShellArg(descendant)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    return true;
  } catch {
    return false;
  }
}

function reconcileSquashMergedPromotion(input: {
  integrationBranch: string;
  promotionBranch: string;
  integrationTip: string;
  promotionTip: string;
  promotionTree: string;
  matchingPromotionTreeCommit: string | null;
  repoDir: string;
  shellRunner: ShellRunner;
  dryRun?: boolean;
}): string {
  const integrationTree = resolveCommitTree(input.integrationTip, input.repoDir, input.shellRunner);
  const matchingIntegrationCommit = input.matchingPromotionTreeCommit;

  if (!matchingIntegrationCommit) {
    return input.integrationTip;
  }

  const branchRef = `refs/heads/${input.integrationBranch}`;
  if (integrationTree === input.promotionTree) {
    if (input.dryRun) {
      return input.integrationTip;
    }
    input.shellRunner(
      `git update-ref ${escapeShellArg(branchRef)} ${escapeShellArg(input.promotionTip)} ${escapeShellArg(input.integrationTip)}`,
      { encoding: 'utf-8', cwd: input.repoDir },
    );
    pushBranchRefWithLocalRollback({
      branchRef,
      localTipBeforePush: input.promotionTip,
      restoreTip: input.integrationTip,
      expectedRemoteTip: input.integrationTip,
      repoDir: input.repoDir,
      shellRunner: input.shellRunner,
      integrationBranch: input.integrationBranch,
    });
    return input.promotionTip;
  }

  if (matchingIntegrationCommit === input.integrationTip) {
    return input.integrationTip;
  }

  if (input.dryRun) {
    return input.integrationTip;
  }

  const message = `chore: reconcile ${input.integrationBranch} after squash promotion`;
  const reconciledTip = String(input.shellRunner(
    [
      'git',
      'commit-tree',
      escapeShellArg(`${input.integrationTip}^{tree}`),
      '-p',
      escapeShellArg(input.promotionTip),
      '-m',
      escapeShellArg(message),
    ].join(' '),
    { encoding: 'utf-8', cwd: input.repoDir },
  )).trim();

  input.shellRunner(
    `git update-ref ${escapeShellArg(branchRef)} ${escapeShellArg(reconciledTip)} ${escapeShellArg(input.integrationTip)}`,
    { encoding: 'utf-8', cwd: input.repoDir },
  );
  pushBranchRefWithLocalRollback({
    branchRef,
    localTipBeforePush: reconciledTip,
    restoreTip: input.integrationTip,
    expectedRemoteTip: input.integrationTip,
    repoDir: input.repoDir,
    shellRunner: input.shellRunner,
    integrationBranch: input.integrationBranch,
  });
  return reconciledTip;
}

async function handleBaseBehind(input: {
  config: ReturnType<typeof getIntegrationConfig>;
  integrationBranch: string;
  promotionBranch: string;
  promotionBase: PromotionBaseState;
  integrationTip: string;
  repoDir: string;
  shellRunner: ShellRunner;
  currentPr: PromotionPr | null;
  interactive: boolean;
  dryRun?: boolean;
  confirmUpdate: (message: string) => Promise<boolean>;
}): Promise<PromotionResult | null> {
  const prediction = predictPromotionBaseMerge(
    input.integrationBranch,
    input.promotionBase.remoteRef,
    input.repoDir,
    input.shellRunner,
  );

  if (!input.dryRun && prediction.status === 'clean') {
    const shouldUpdate =
      input.config.autoUpdatePromotionBranch ||
      (input.interactive && await input.confirmUpdate(formatBaseBehindPrompt(
        input.integrationBranch,
        input.promotionBase.remoteRef,
      )));

    if (shouldUpdate) {
      try {
        updateIntegrationWithPromotionBase(
          input.integrationBranch,
          input.promotionBranch,
          input.repoDir,
          input.shellRunner,
        );
        return null;
      } catch (error) {
        return buildBlockedPromotionResult({
          blockReason: 'base-unknown',
          blockSummary: formatBaseBehindSummary(
            'base-unknown',
            input.integrationBranch,
            input.promotionBase.remoteRef,
            errorMessage(error),
          ),
          prUrl: input.currentPr?.url,
          checkSummary: input.currentPr
            ? formatCheckSummary(await waitForChecks(
              input.currentPr.number,
              input.repoDir,
              input.shellRunner,
              { timeoutMs: 0, requiredChecks: input.config.requiredChecks },
            ))
            : undefined,
        });
      }
    }
  }

  let blockReason: PromotionBlockReason = 'base-behind';
  if (prediction.status === 'conflicts') {
    blockReason = 'base-behind-conflicts';
  } else if (prediction.status === 'unknown') {
    blockReason = 'base-unknown';
  }

  return buildBlockedPromotionResult({
    blockReason,
    blockSummary: formatBaseBehindSummary(
      blockReason,
      input.integrationBranch,
      input.promotionBase.remoteRef,
      prediction.detail,
    ),
    prUrl: input.currentPr?.url,
    checkSummary: input.currentPr
      ? formatCheckSummary(await waitForChecks(
        input.currentPr.number,
        input.repoDir,
        input.shellRunner,
        { timeoutMs: 0, requiredChecks: input.config.requiredChecks },
      ))
      : undefined,
  });
}

function predictPromotionBaseMerge(
  integrationBranch: string,
  promotionRemoteRef: string,
  repoDir: string,
  shellRunner: ShellRunner,
): MergePrediction {
  try {
    shellRunner(
      `git merge-tree --write-tree ${escapeShellArg(integrationBranch)} ${escapeShellArg(promotionRemoteRef)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    return { status: 'clean' };
  } catch (error) {
    const message = errorMessage(error);
    if (/conflict/i.test(message)) {
      return { status: 'conflicts', detail: message };
    }
    return { status: 'unknown', detail: message };
  }
}

export function updateBranchWithBase(
  branch: string,
  baseBranch: string,
  repoDir: string,
  shellRunner: ShellRunner = (cmd, opts) => String(execShellCommand(cmd, opts)),
): BranchBaseUpdateResult {
  const dirtyState = String(shellRunner(
    'git status --porcelain',
    { encoding: 'utf-8', cwd: repoDir },
  )).trim();
  if (dirtyState) {
    return {
      status: 'dirty-worktree',
      detail: `refusing to update ${branch} because the worktree has uncommitted changes`,
    };
  }

  try {
    shellRunner(
      `git fetch --quiet origin ${escapeShellArg(baseBranch)} ${escapeShellArg(branch)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
  } catch (error) {
    return {
      status: 'fetch-failed',
      detail: `failed to fetch origin/${baseBranch}: ${errorMessage(error)}`,
    };
  }

  try {
    shellRunner(
      `git switch ${escapeShellArg(branch)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    shellRunner(
      `git merge-tree --write-tree ${escapeShellArg(branch)} ${escapeShellArg(remoteBranchRef(baseBranch))}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    shellRunner(
      `git merge --no-edit ${escapeShellArg(remoteBranchRef(baseBranch))}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
  } catch (error) {
    const detail = errorMessage(error);
    try {
      shellRunner('git merge --abort', { encoding: 'utf-8', cwd: repoDir });
    } catch {
      // Best-effort cleanup if merge started.
    }

    return {
      status: /conflict/i.test(detail) ? 'conflict' : 'unknown-failed',
      detail,
    };
  }

  try {
    shellRunner(
      `git push origin ${escapeShellArg(branch)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    return {
      status: 'success',
      detail: `updated ${branch} with origin/${baseBranch} and pushed successfully`,
    };
  } catch (error) {
    return {
      status: 'push-failed',
      detail: errorMessage(error),
    };
  }
}

function updateIntegrationWithPromotionBase(
  integrationBranch: string,
  promotionBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): void {
  const result = updateBranchWithBase(integrationBranch, promotionBranch, repoDir, shellRunner);
  if (result.status !== 'success') {
    throw new Error(`promote: ${result.detail}`);
  }
}

function formatBaseBehindPrompt(
  integrationBranch: string,
  promotionRemoteRef: string,
): string {
  return `Promotion is blocked because ${integrationBranch} is behind protected base ${promotionRemoteRef}. Merge and push the latest base now?`;
}

function formatBaseBehindSummary(
  reason: PromotionBlockReason,
  integrationBranch: string,
  promotionRemoteRef: string,
  detail?: string,
): string {
  if (reason === 'base-behind-conflicts') {
    return `branch behind protected base; merging ${promotionRemoteRef} into ${integrationBranch} is expected to conflict`;
  }
  if (reason === 'base-unknown') {
    return detail
      ? `unable to verify or update protected base ${promotionRemoteRef}: ${detail}`
      : `unable to verify protected base ${promotionRemoteRef}`;
  }
  return `branch behind protected base; merge ${promotionRemoteRef} into ${integrationBranch} and push before promoting`;
}

function buildBlockedPromotionResult(input: {
  blockReason: PromotionBlockReason;
  blockSummary: string;
  prUrl?: string;
  checkSummary?: string;
}): PromotionResult {
  return {
    status: 'blocked',
    blockReason: input.blockReason,
    blockSummary: input.blockSummary,
    prUrl: input.prUrl,
    checkSummary: input.checkSummary,
  };
}

function resolveCommitTree(
  commitish: string,
  repoDir: string,
  shellRunner: ShellRunner,
): string {
  return String(shellRunner(
    `git rev-parse ${escapeShellArg(`${commitish}^{tree}`)}`,
    { encoding: 'utf-8', cwd: repoDir },
  )).trim();
}

function findIntegrationCommitWithTree(
  integrationBranch: string,
  tree: string,
  repoDir: string,
  shellRunner: ShellRunner,
): string | null {
  const output = String(shellRunner(
    `git log --format='%H %T' ${escapeShellArg(integrationBranch)}`,
    { encoding: 'utf-8', cwd: repoDir },
  )).trim();

  for (const line of output.split(/\r?\n/)) {
    const [commit, commitTree] = line.trim().split(/\s+/, 2);
    if (commit && commitTree === tree) {
      return commit;
    }
  }
  return null;
}

function pushBranchRef(
  branchRef: string,
  expectedRemoteTip: string,
  repoDir: string,
  shellRunner: ShellRunner,
): void {
  shellRunner(
    [
      'git',
      'push',
      `--force-with-lease=${escapeShellArg(`${branchRef}:${expectedRemoteTip}`)}`,
      'origin',
      escapeShellArg(`${branchRef}:${branchRef}`),
    ].join(' '),
    { encoding: 'utf-8', cwd: repoDir },
  );
}

function pushBranchRefWithLocalRollback(input: {
  branchRef: string;
  localTipBeforePush: string;
  restoreTip: string;
  expectedRemoteTip: string;
  repoDir: string;
  shellRunner: ShellRunner;
  integrationBranch: string;
}): void {
  try {
    pushBranchRef(input.branchRef, input.expectedRemoteTip, input.repoDir, input.shellRunner);
  } catch (error) {
    try {
      input.shellRunner(
        `git update-ref ${escapeShellArg(input.branchRef)} ${escapeShellArg(input.restoreTip)} ${escapeShellArg(input.localTipBeforePush)}`,
        { encoding: 'utf-8', cwd: input.repoDir },
      );
    } catch (rollbackError) {
      throw new Error(formatProtectedBranchPushFailure(input.integrationBranch, error, rollbackError));
    }
    throw new Error(formatProtectedBranchPushFailure(input.integrationBranch, error));
  }
}

function formatProtectedBranchPushFailure(
  integrationBranch: string,
  pushError: unknown,
  rollbackError?: unknown,
): string {
  const message = errorMessage(pushError);
  const likelyProtectedBranch =
    message.includes('GH006') ||
    message.includes('Protected branch update failed') ||
    message.includes('Cannot force-push');
  const rollbackNote = rollbackError
    ? `\n\nAlso failed to restore the local branch ref: ${errorMessage(rollbackError)}`
    : '\n\nThe local branch ref was restored to its pre-promote tip.';

  if (!likelyProtectedBranch) {
    return `promote: failed to push reconciled integration branch: ${message}${rollbackNote}`;
  }

  return [
    `promote: GitHub rejected the required reconciliation push to protected branch \`${integrationBranch}\`.`,
    '',
    'Why: the promotion branch appears to already contain an earlier squash-merged snapshot, so Wavemill tried to rewrite the integration branch onto the current promotion branch before opening/updating the promotion PR. GitHub branch protection blocked that force push.',
    '',
    'What to do: allow Wavemill/automation to force-push this integration branch, or have an admin temporarily unprotect/reset the integration branch before running `wavemill promote` again.',
    '',
    'Cleanup if your checkout still looks diverged and you have no local commits to keep:',
    `  git fetch origin ${integrationBranch}`,
    `  git switch ${integrationBranch}`,
    `  git reset --hard origin/${integrationBranch}`,
    rollbackNote.trimStart(),
    '',
    `Original push error: ${message}`,
  ].join('\n');
}

function listRecentMergedWavemillPrs(
  integrationBranch: string,
  allowedPrNumbers: Set<number>,
  repoDir: string,
  shellRunner: ShellRunner,
): MergedPrSummary[] {
  if (allowedPrNumbers.size === 0) {
    return [];
  }

  try {
    const output = shellRunner(
      [
        'gh',
        'pr',
        'list',
        '--state',
        'merged',
        '--base',
        escapeShellArg(integrationBranch),
        '--limit',
        String(RECENT_PR_LIMIT),
        '--json',
        'number,title,url,mergedAt,labels',
      ].join(' '),
      { encoding: 'utf-8', cwd: repoDir },
    );
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return (parsed as MergedPrSummary[]).filter((pr) => {
      if (allowedPrNumbers.size > 0 && !allowedPrNumbers.has(pr.number)) {
        return false;
      }
      return Array.isArray(pr.labels) && pr.labels.some((label) => label.name === WM_LABELS.wavemill);
    });
  } catch {
    return [];
  }
}

function listRecentIntegrationCommits(
  comparisonBase: string,
  integrationBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): string[] {
  try {
    const output = String(shellRunner(
      `git log --first-parent --oneline -n ${RECENT_COMMIT_LIMIT} ${escapeShellArg(`${comparisonBase}..${integrationBranch}`)}`,
      { encoding: 'utf-8', cwd: repoDir },
    )).trim();
    return output ? output.split(/\r?\n/) : [];
  } catch {
    return [];
  }
}

function extractPrNumbers(commits: string[]): Set<number> {
  const numbers = new Set<number>();
  for (const commit of commits) {
    for (const match of commit.matchAll(/(?:#|pull request #)(\d+)/gi)) {
      numbers.add(Number(match[1]));
    }
  }
  return numbers;
}

function findExistingPromotionPr(
  integrationBranch: string,
  promotionBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): PromotionPr | null {
  const output = shellRunner(
    [
      'gh',
      'pr',
      'list',
      '--head',
      escapeShellArg(integrationBranch),
      '--base',
      escapeShellArg(promotionBranch),
      '--state',
      'open',
      '--json',
      'number,url,body',
    ].join(' '),
    { encoding: 'utf-8', cwd: repoDir },
  );
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  return parsed[0] as PromotionPr;
}

function renderPromotionSection(input: {
  integrationBranch: string;
  promotionBranch: string;
  health: IntegrationHealth;
  recentPrs: MergedPrSummary[];
  recentCommits: string[];
}): string {
  const lines = [
    PROMOTION_SECTION_BEGIN,
    '## Promotion Summary',
    '',
    `*${input.integrationBranch} -> ${input.promotionBranch} · Updated at ${new Date().toISOString()}*`,
    '',
    `Branch health: ${formatHealth(input.health)}`,
    '',
  ];

  if (input.recentPrs.length > 0) {
    lines.push('Recently merged Wavemill PRs:');
    for (const pr of input.recentPrs) {
      lines.push(`- PR #${pr.number}: ${pr.title}`);
    }
    lines.push('');
  }

  if (input.recentCommits.length > 0) {
    lines.push('Recent integration commits not yet on promotion branch:');
    for (const commit of input.recentCommits) {
      lines.push(`- ${commit}`);
    }
    lines.push('');
  }

  if (input.recentPrs.length === 0 && input.recentCommits.length === 0) {
    lines.push('No recent merged Wavemill PRs detected.');
    lines.push('');
  }

  lines.push(PROMOTION_SECTION_END);
  return lines.join('\n');
}

function formatHealth(health: IntegrationHealth): string {
  if (health.state === 'healthy') {
    return 'healthy';
  }
  return health.reason ? `unhealthy (${health.reason})` : 'unhealthy';
}

function updatePromotionSection(body: string, section: string): string {
  const trimmed = body.trim();
  const sectionPattern = new RegExp(
    `${escapeRegExp(PROMOTION_SECTION_BEGIN)}[\\s\\S]*?${escapeRegExp(PROMOTION_SECTION_END)}`,
    'm',
  );

  if (sectionPattern.test(body)) {
    return body.replace(sectionPattern, section).trim();
  }

  if (!trimmed) {
    return section;
  }

  return `${trimmed}\n\n${section}`;
}

function formatCheckSummary(result: CheckWaitResult): string {
  const state =
    result.outcome === 'pass'
      ? 'passing'
      : result.outcome === 'fail'
        ? 'failing'
        : 'pending';
  return `${state}: ${result.summary}`;
}

function writeBodyToTempFile(
  body: string,
  shellRunner: ShellRunner,
  repoDir: string,
): string {
  const output = String(shellRunner('mktemp', { encoding: 'utf-8', cwd: repoDir })).trim();
  writeFileSync(output, body);
  return output;
}

function updatePromotionPrBody(
  prNumber: number,
  body: string,
  shellRunner: ShellRunner,
  repoDir: string,
): void {
  const repo = String(shellRunner(
    'gh repo view --json nameWithOwner --jq .nameWithOwner',
    { encoding: 'utf-8', cwd: repoDir },
  )).trim();
  const bodyJsonFile = writeBodyToTempFile(JSON.stringify({ body }), shellRunner, repoDir);
  try {
    shellRunner(
      `gh api --method PATCH ${escapeShellArg(`repos/${repo}/pulls/${prNumber}`)} --input ${escapeShellArg(bodyJsonFile)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
  } finally {
    shellRunner(`rm -f ${escapeShellArg(bodyJsonFile)}`, { encoding: 'utf-8', cwd: repoDir });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
