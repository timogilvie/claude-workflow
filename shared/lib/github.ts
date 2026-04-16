/**
 * GitHub CLI wrapper utilities for pull request operations.
 *
 * Provides type-safe wrappers around `gh` CLI commands for listing,
 * fetching, and diffing pull requests.
 *
 * @module github
 */

import { ensureCleanTree } from './git.ts';
import { runBuildCheck, type BuildCheckConfig } from './checks.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';

/**
 * Options for listing pull requests.
 */
export interface PullRequestListOptions {
  /** PR state filter */
  state?: 'open' | 'closed' | 'merged' | 'all';
  /** Filter by PR author username */
  author?: string;
  /** Maximum number of PRs to return */
  limit?: number;
  /** Repository in 'owner/name' format (defaults to current repo) */
  repo?: string;
}

/**
 * Options for getting a single pull request or diff.
 */
export interface PullRequestViewOptions {
  /** Repository in 'owner/name' format (defaults to current repo) */
  repo?: string;
}

/**
 * Pull request metadata.
 */
export interface PullRequest {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** PR body/description (only included in getPullRequest) */
  body?: string;
  /** PR state (OPEN, CLOSED, MERGED) */
  state: string;
  /** Author login */
  author: string;
  /** Head branch name */
  headRefName: string;
  /** Base branch name */
  baseRefName: string;
  /** PR labels */
  labels: Array<{ name: string }>;
  /** PR URL */
  url: string;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
  /** Merge timestamp (null if not merged) */
  mergedAt: string | null;
  /** Close timestamp (null if not closed) */
  closedAt: string | null;
}

/**
 * PR review from GitHub API.
 */
export interface PrReview {
  author: string;
  body: string;
  state: string;
  submittedAt: string;
}

/**
 * Pull request diff result.
 */
export interface PullRequestDiff {
  /** PR number */
  prNumber: number;
  /** Unified diff content */
  diff: string;
}

/**
 * Build a shell command from an array of arguments, properly escaping each one.
 *
 * @param args - Array of command arguments
 * @returns Escaped shell command string
 */
const buildShellCommand = (args: Array<string | number>): string => {
  return args.map((arg) => escapeShellArg(String(arg))).join(' ');
};

/**
 * Dependency injection surface for github helpers.
 *
 * Exported to allow deterministic unit tests via `mock.method(...)`.
 */
export const githubDeps = {
  execShellCommand,
};

const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const resolveApiRepo = (repo?: string): string => {
  if (!repo) {
    // gh api resolves owner/repo from the current git remote.
    return '{owner}/{repo}';
  }

  if (!OWNER_REPO_PATTERN.test(repo)) {
    throw new Error('Repository must be in owner/name format');
  }

  return repo;
};

const validatePrNumber = (prNumber: number): void => {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('PR number must be a positive integer');
  }
};

const normalizeLabels = (labels: string[]): string[] => {
  if (!Array.isArray(labels)) {
    throw new Error('labels must be an array');
  }

  const normalized = labels.map((label) => label.trim()).filter(Boolean);
  const deduped = [...new Set(normalized)];

  if (deduped.length !== normalized.length) {
    return deduped;
  }

  return normalized;
};

const normalizeGitHubLabelError = (error: Error, prNumber: number, operation: string): Error => {
  const message = error.message;
  const lower = message.toLowerCase();

  if (
    lower.includes('http 401') ||
    lower.includes('http 403') ||
    lower.includes('requires authentication') ||
    lower.includes('authentication failed') ||
    lower.includes('gh auth login') ||
    lower.includes('not logged into any github hosts')
  ) {
    return new Error('GitHub CLI (gh) is not authenticated');
  }

  if (
    lower.includes('http 404') ||
    lower.includes('not found') ||
    lower.includes('could not resolve to an issue')
  ) {
    return new Error(`Pull request #${prNumber} not found`);
  }

  return new Error(`Failed to ${operation} labels for pull request #${prNumber}: ${message}`);
};

/**
 * Add one or more labels to a pull request using GitHub REST API.
 *
 * Uses `gh api` instead of `gh pr edit --add-label` to avoid GraphQL
 * `projectCards` deprecation failures.
 *
 * @param prNumber - Pull request number (> 0)
 * @param labels - Labels to add (empty array is a no-op)
 * @param options - Optional repository override
 *
 * @example
 * ```typescript
 * await addLabelsToPr(229, ['HOK-1305']);
 * await addLabelsToPr(229, ['HOK-1305', 'Bug'], { repo: 'timogilvie/wavemill' });
 * ```
 */
export async function addLabelsToPr(
  prNumber: number,
  labels: string[],
  options: PullRequestViewOptions = {},
): Promise<void> {
  validatePrNumber(prNumber);

  const normalizedLabels = normalizeLabels(labels);
  if (normalizedLabels.length === 0) {
    return;
  }

  const repo = resolveApiRepo(options.repo);
  const endpoint = `repos/${repo}/issues/${prNumber}/labels`;
  const body = JSON.stringify({ labels: normalizedLabels });
  const command = `printf '%s' ${escapeShellArg(body)} | ${buildShellCommand([
    'gh',
    'api',
    '--method',
    'POST',
    endpoint,
    '--input',
    '-',
  ])}`;

  try {
    githubDeps.execShellCommand(command, { encoding: 'utf-8' });
  } catch (error) {
    throw normalizeGitHubLabelError(error as Error, prNumber, 'add');
  }
}

/**
 * Remove a single label from a pull request using GitHub REST API.
 *
 * @param prNumber - Pull request number (> 0)
 * @param label - Label name to remove
 * @param options - Optional repository override
 *
 * @example
 * ```typescript
 * await removeLabelFromPr(229, 'HOK-1305');
 * ```
 */
export async function removeLabelFromPr(
  prNumber: number,
  label: string,
  options: PullRequestViewOptions = {},
): Promise<void> {
  validatePrNumber(prNumber);

  const normalizedLabel = label.trim();
  if (!normalizedLabel) {
    throw new Error('Label is required');
  }

  const repo = resolveApiRepo(options.repo);
  const encodedLabel = encodeURIComponent(normalizedLabel);
  const endpoint = `repos/${repo}/issues/${prNumber}/labels/${encodedLabel}`;

  try {
    githubDeps.execShellCommand(
      buildShellCommand(['gh', 'api', '--method', 'DELETE', endpoint]),
      { encoding: 'utf-8' },
    );
  } catch (error) {
    throw normalizeGitHubLabelError(error as Error, prNumber, 'remove');
  }
}

/**
 * Replace all labels on a pull request using GitHub REST API.
 *
 * @param prNumber - Pull request number (> 0)
 * @param labels - Full label set to apply
 * @param options - Optional repository override
 *
 * @example
 * ```typescript
 * await setLabelsOnPr(229, ['bug', 'priority:high']);
 * await setLabelsOnPr(229, []); // clears all labels
 * ```
 */
export async function setLabelsOnPr(
  prNumber: number,
  labels: string[],
  options: PullRequestViewOptions = {},
): Promise<void> {
  validatePrNumber(prNumber);

  const normalizedLabels = normalizeLabels(labels);
  const repo = resolveApiRepo(options.repo);
  const endpoint = `repos/${repo}/issues/${prNumber}/labels`;
  const body = JSON.stringify({ labels: normalizedLabels });
  const command = `printf '%s' ${escapeShellArg(body)} | ${buildShellCommand([
    'gh',
    'api',
    '--method',
    'PUT',
    endpoint,
    '--input',
    '-',
  ])}`;

  try {
    githubDeps.execShellCommand(command, { encoding: 'utf-8' });
  } catch (error) {
    throw normalizeGitHubLabelError(error as Error, prNumber, 'set');
  }
}

/**
 * Lists pull requests for a GitHub repository.
 *
 * @param options - Filter options
 * @returns Array of PR objects with structured data
 * @throws {Error} If gh CLI is not available or authenticated
 *
 * @example
 * ```typescript
 * // List open PRs
 * const openPRs = listPullRequests();
 *
 * // List closed PRs by specific author
 * const authorPRs = listPullRequests({ state: 'closed', author: 'timogilvie' });
 *
 * // List first 10 PRs
 * const recentPRs = listPullRequests({ limit: 10 });
 * ```
 */
export const listPullRequests = (options: PullRequestListOptions = {}): PullRequest[] => {
  const {
    state = 'open',
    author,
    limit,
    repo,
  } = options;

  try {
    const args: Array<string | number> = ['gh', 'pr', 'list'];

    // Add state filter
    args.push('--state', state);

    // Add author filter if provided
    if (author) {
      args.push('--author', author);
    }

    // Add limit if provided
    if (limit) {
      args.push('--limit', limit.toString());
    }

    // Add repo if provided
    if (repo) {
      args.push('--repo', repo);
    }

    // Request JSON output with all needed fields
    args.push(
      '--json',
      'number,title,state,author,headRefName,baseRefName,labels,url,createdAt,updatedAt,mergedAt,closedAt'
    );

    const output = githubDeps.execShellCommand(buildShellCommand(args), { encoding: 'utf-8' }).trim();

    if (!output) {
      return [];
    }

    const prs = JSON.parse(output) as Array<{
      number: number;
      title: string;
      state: string;
      author?: { login?: string } | string;
      headRefName: string;
      baseRefName: string;
      labels?: Array<{ name: string }>;
      url: string;
      createdAt: string;
      updatedAt: string;
      mergedAt?: string | null;
      closedAt?: string | null;
    }>;

    // Transform to structured format
    return prs.map(pr => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: typeof pr.author === 'object' && pr.author?.login
        ? pr.author.login
        : String(pr.author || ''),
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      labels: pr.labels || [],
      url: pr.url,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt || null,
      closedAt: pr.closedAt || null,
    }));
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to list pull requests: ${err.message}`);
  }
};

/**
 * Fetches detailed metadata for a specific pull request.
 *
 * @param prNumber - The PR number
 * @param options - Options
 * @returns PR metadata object
 * @throws {Error} If PR is not found or gh CLI fails
 *
 * @example
 * ```typescript
 * // Get PR #42
 * const pr = getPullRequest(42);
 * console.log(pr.title, pr.author, pr.labels);
 * ```
 */
export const getPullRequest = (prNumber: number | string, options: PullRequestViewOptions = {}): PullRequest => {
  const { repo } = options;

  if (!prNumber) {
    throw new Error('PR number is required');
  }

  try {
    const args: Array<string | number> = ['gh', 'pr', 'view', prNumber.toString()];

    // Add repo if provided
    if (repo) {
      args.push('--repo', repo);
    }

    // Request JSON output with all needed fields
    args.push(
      '--json',
      'number,title,body,state,author,headRefName,baseRefName,labels,url,createdAt,updatedAt,mergedAt,closedAt'
    );

    const output = githubDeps.execShellCommand(buildShellCommand(args), { encoding: 'utf-8' }).trim();
    const pr = JSON.parse(output) as {
      number: number;
      title: string;
      body?: string;
      state: string;
      author?: { login?: string } | string;
      headRefName: string;
      baseRefName: string;
      labels?: Array<{ name: string }>;
      url: string;
      createdAt: string;
      updatedAt: string;
      mergedAt?: string | null;
      closedAt?: string | null;
    };

    // Transform to structured format
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      state: pr.state,
      author: typeof pr.author === 'object' && pr.author?.login
        ? pr.author.login
        : String(pr.author || ''),
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      labels: pr.labels || [],
      url: pr.url,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt || null,
      closedAt: pr.closedAt || null,
    };
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('Could not resolve to a PullRequest') ||
        err.message.includes('no pull requests found')) {
      throw new Error(`Pull request #${prNumber} not found`);
    }
    if (err.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to get pull request #${prNumber}: ${err.message}`);
  }
};

/**
 * Fetches the diff content for a pull request.
 *
 * @param prNumber - The PR number
 * @param options - Options
 * @returns Object containing PR number and diff content
 * @throws {Error} If PR is not found or diff is unavailable
 *
 * @example
 * ```typescript
 * // Get diff for PR #42
 * const { diff } = getPullRequestDiff(42);
 * console.log(diff); // Unified diff format
 * ```
 */
export const getPullRequestDiff = (prNumber: number | string, options: PullRequestViewOptions = {}): PullRequestDiff => {
  const { repo } = options;

  if (!prNumber) {
    throw new Error('PR number is required');
  }

  try {
    const args: Array<string | number> = ['gh', 'pr', 'diff', prNumber.toString()];

    // Add repo if provided
    if (repo) {
      args.push('--repo', repo);
    }

    const diff = githubDeps.execShellCommand(buildShellCommand(args), { encoding: 'utf-8' });

    return {
      prNumber: parseInt(prNumber.toString(), 10),
      diff,
    };
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('could not find pull request') ||
        err.message.includes('HTTP 404') ||
        err.message.includes('Could not resolve to a PullRequest')) {
      throw new Error(`Pull request #${prNumber} not found`);
    }
    if (err.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to get diff for pull request #${prNumber}: ${err.message}`);
  }
};

/**
 * Resolve the GitHub owner/repo string (e.g. "timogilvie/wavemill") from
 * the git remote in the given directory.
 */
export function resolveOwnerRepo(repoDir?: string): string | undefined {
  const cwd = repoDir || process.cwd();

  try {
    const nwo = githubDeps.execShellCommand(
      'gh repo view --json nameWithOwner --jq .nameWithOwner',
      { encoding: 'utf-8', cwd, timeout: 10_000 },
    ).trim();
    return nwo || undefined;
  } catch {
    try {
      const remoteUrl = githubDeps.execShellCommand('git remote get-url origin', {
        encoding: 'utf-8',
        cwd,
        timeout: 5_000,
      }).trim();
      const match = remoteUrl.match(
        /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/,
      );
      return match?.[1];
    } catch {
      return undefined;
    }
  }
}

/**
 * Fetch normalized top-level PR reviews from GitHub.
 */
export function fetchPrReviews(
  prNumber: string,
  repoDir?: string,
  nwo?: string,
): PrReview[] {
  const cwd = repoDir || process.cwd();
  const repo = nwo || resolveOwnerRepo(cwd);

  if (!repo) {
    return [];
  }

  const reviewsRaw = githubDeps.execShellCommand(
    `gh api repos/${escapeShellArg(repo)}/pulls/${escapeShellArg(prNumber)}/reviews --jq '[.[] | {author: .user.login, state: .state, body: (.body // ""), submittedAt: (.submitted_at // "")}]'`,
    { encoding: 'utf-8', cwd, timeout: 15_000 },
  ).trim();

  if (!reviewsRaw) {
    return [];
  }

  const reviews = JSON.parse(reviewsRaw) as unknown;
  return Array.isArray(reviews) ? (reviews as PrReview[]) : [];
}

// Re-export for backward compatibility
export { ensureCleanTree, runBuildCheck };
export type { BuildCheckConfig };
