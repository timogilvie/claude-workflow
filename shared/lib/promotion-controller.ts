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

  const integrationTip = resolveBranchTip(integrationBranch, options.repoDir, shellRunner);
  resolveBranchTip(promotionBranch, options.repoDir, shellRunner);

  if (isAlreadyPromoted(integrationTip, promotionBranch, options.repoDir, shellRunner)) {
    return { status: 'noop' };
  }

  let health: IntegrationHealth;
  try {
    health = await healthChecker(integrationBranch, options.repoDir);
  } catch (error) {
    health = { state: 'unhealthy', reason: `health-check-error: ${errorMessage(error)}` };
  }

  const recentPrs = listRecentMergedWavemillPrs(integrationBranch, options.repoDir, shellRunner);
  const recentCommits = listRecentIntegrationCommits(promotionBranch, integrationBranch, options.repoDir, shellRunner);
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
    const bodyFile = writeBodyToTempFile(nextBody, shellRunner, options.repoDir);
    try {
      if (currentPr) {
        shellRunner(
          `gh pr edit ${currentPr.number} --body-file ${escapeShellArg(bodyFile)}`,
          { encoding: 'utf-8', cwd: options.repoDir },
        );
      } else {
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
      }
    } finally {
      shellRunner(`rm -f ${escapeShellArg(bodyFile)}`, { encoding: 'utf-8', cwd: options.repoDir });
    }
  }

  const promotionPr = currentPr ?? findExistingPromotionPr(integrationBranch, promotionBranch, options.repoDir, shellRunner);
  const checkSummary = promotionPr
    ? formatCheckSummary(await waitForChecks(promotionPr.number, options.repoDir, shellRunner, 0))
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

function listRecentMergedWavemillPrs(
  integrationBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): MergedPrSummary[] {
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
    return (parsed as MergedPrSummary[]).filter((pr) =>
      Array.isArray(pr.labels) && pr.labels.some((label) => label.name === WM_LABELS.wavemill)
    );
  } catch {
    return [];
  }
}

function listRecentIntegrationCommits(
  promotionBranch: string,
  integrationBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): string[] {
  try {
    const output = String(shellRunner(
      `git log --no-merges --oneline -n ${RECENT_COMMIT_LIMIT} ${escapeShellArg(`${promotionBranch}..${integrationBranch}`)}`,
      { encoding: 'utf-8', cwd: repoDir },
    )).trim();
    return output ? output.split(/\r?\n/) : [];
  } catch {
    return [];
  }
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
  shellRunner(`cat > ${escapeShellArg(output)} <<'EOF'\n${body}\nEOF`, { encoding: 'utf-8', cwd: repoDir });
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
