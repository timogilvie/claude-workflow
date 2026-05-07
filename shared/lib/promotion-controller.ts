import { writeFileSync } from 'fs';
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
  status: 'opened' | 'updated' | 'noop';
  prUrl?: string;
  checkSummary?: string;
}

export interface PromotionOptions {
  repoDir: string;
  dryRun?: boolean;
  shellRunner?: (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;
  healthChecker?: HealthChecker;
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

  let integrationTip = resolveBranchTip(integrationBranch, options.repoDir, shellRunner);
  const promotionTip = resolveBranchTip(promotionBranch, options.repoDir, shellRunner);
  const promotionTipIsIntegrated = isAncestor(promotionTip, integrationTip, options.repoDir, shellRunner);
  const promotionTree = resolveCommitTree(promotionTip, options.repoDir, shellRunner);
  const matchingPromotionTreeCommit = promotionTipIsIntegrated
    ? null
    : findIntegrationCommitWithTree(
      integrationBranch,
      promotionTree,
      options.repoDir,
      shellRunner,
    );
  const comparisonBase =
    matchingPromotionTreeCommit && matchingPromotionTreeCommit !== integrationTip
      ? matchingPromotionTreeCommit
      : promotionBranch;

  integrationTip = reconcileSquashMergedPromotion({
    integrationBranch,
    promotionBranch,
    integrationTip,
    promotionTip,
    promotionTree,
    matchingPromotionTreeCommit,
    repoDir: options.repoDir,
    shellRunner,
    dryRun: options.dryRun,
  });

  if (isAlreadyPromoted(integrationTip, promotionBranch, options.repoDir, shellRunner)) {
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
  const currentPr = findExistingPromotionPr(integrationBranch, promotionBranch, options.repoDir, shellRunner);
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
    pushBranchRef(branchRef, input.integrationTip, input.repoDir, input.shellRunner);
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
  pushBranchRef(branchRef, input.integrationTip, input.repoDir, input.shellRunner);
  return reconciledTip;
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
