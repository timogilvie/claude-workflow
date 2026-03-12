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

    const output = execShellCommand(buildShellCommand(args), { encoding: 'utf-8' }).trim();

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

    const output = execShellCommand(buildShellCommand(args), { encoding: 'utf-8' }).trim();
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

    const diff = execShellCommand(buildShellCommand(args), { encoding: 'utf-8' });

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

// Re-export for backward compatibility
export { ensureCleanTree, runBuildCheck };
export type { BuildCheckConfig };
