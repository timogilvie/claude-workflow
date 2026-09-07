/**
 * Merged PR Fetcher - Shared GitHub enumeration for the scan pipeline
 *
 * Extracted from tools/measure-repo-attribution.ts (Arbiter R4, HOK-2791) so the
 * attribution scan step (HOK-2808) and the R4 measurement tool share a single
 * fetch/parse path. Runs with no wavemill state: only `gh` and its inputs.
 *
 * Compared to the original R4 fetch path, parsed pull requests additionally
 * carry `body` and `headSha` (both already present in the list response at zero
 * extra API cost, both tolerated absent for backward compatibility). These feed
 * the first-party `wavemill-meta` / `executed_route` attribution signals.
 *
 * @module merged-pr-fetcher
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { errorMessage } from './error-utils.ts';

const execFileAsync = promisify(execFile);

/**
 * A merged pull request as consumed by the attribution engine.
 *
 * Superset of the R4 tool's `PullRequestInput`: adds `body` (PR description,
 * needed for the `wavemill-meta` block) and `headSha` (freshness check for
 * executed-route evidence). Both are null when the API response omits them.
 */
export interface MergedPullRequest {
  number: number;
  title?: string;
  authorLogin: string | null;
  authorType: string | null;
  headRef: string | null;
  labels: string[];
  mergedAt: string;
  commitMessages: string[];
  body: string | null;
  headSha: string | null;
}

interface GitHubPullRequest {
  number: unknown;
  title?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
  head?: { ref?: unknown; sha?: unknown } | null;
  labels?: Array<{ name?: unknown }> | null;
  merged_at?: unknown;
  body?: unknown;
}

interface GitHubCommit {
  commit?: { message?: unknown } | null;
}

/** Injectable `gh` runner so tests never touch the network. */
export interface Fetcher {
  gh(args: string[]): Promise<string>;
}

async function defaultGh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      maxBuffer: 1024 * 1024 * 32,
    });
    return stdout;
  } catch (err) {
    throw new Error(`gh ${args.join(' ')} failed: ${errorMessage(err)}`);
  }
}

/** Default fetcher backed by the local `gh` CLI. */
export function createDefaultFetcher(): Fetcher {
  return { gh: defaultGh };
}

async function fetchJson(fetcher: Fetcher, args: string[]): Promise<unknown> {
  const stdout = await fetcher.gh(args);
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Malformed gh JSON response for "${args.join(' ')}": ${errorMessage(err)}`);
  }
}

/** Fails fast (with gh's own message) when gh auth is unavailable. */
export async function assertGhAvailable(fetcher: Fetcher): Promise<void> {
  await fetcher.gh(['auth', 'status']);
}

/** Validates an `owner/name` repository slug, returning the trimmed form. */
export function validateRepoSlug(repo: string): string {
  const trimmed = repo.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`Invalid repository slug: ${repo}`);
  }
  return trimmed;
}

/**
 * Parses a repos file: either a JSON string array or newline-separated slugs
 * with `#` comments. Every entry is slug-validated.
 */
export function parseReposFileContent(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('Repository JSON file must be an array of slugs');
    }
    return parsed.map(validateRepoSlug);
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map(validateRepoSlug);
}

/** Parses one GitHub REST pull request object plus its commit messages. */
export function parseGitHubPullRequest(raw: unknown, commitMessages: string[]): MergedPullRequest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Malformed pull request response: expected object');
  }
  const pr = raw as GitHubPullRequest;
  if (typeof pr.number !== 'number') {
    throw new Error('Malformed pull request response: missing numeric number');
  }
  if (typeof pr.merged_at !== 'string' || pr.merged_at.length === 0) {
    throw new Error(`Malformed pull request response for #${pr.number}: missing merged_at`);
  }
  if (!Array.isArray(pr.labels)) {
    throw new Error(`Malformed pull request response for #${pr.number}: missing labels array`);
  }

  return {
    number: pr.number,
    title: typeof pr.title === 'string' ? pr.title : undefined,
    authorLogin: typeof pr.user?.login === 'string' ? pr.user.login : null,
    authorType: typeof pr.user?.type === 'string' ? pr.user.type : null,
    headRef: typeof pr.head?.ref === 'string' ? pr.head.ref : null,
    labels: pr.labels.map((label) => {
      if (typeof label?.name !== 'string') {
        throw new Error(`Malformed pull request response for #${pr.number}: label without name`);
      }
      return label.name;
    }),
    mergedAt: pr.merged_at,
    commitMessages,
    body: typeof pr.body === 'string' ? pr.body : null,
    headSha: typeof pr.head?.sha === 'string' ? pr.head.sha : null,
  };
}

/** Parses the commits listing for a PR into its commit messages. */
export function parseGitHubCommitMessages(raw: unknown, prNumber: number): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Malformed commits response for PR #${prNumber}: expected array`);
  }

  return raw.map((commit, index) => {
    const message = (commit as GitHubCommit)?.commit?.message;
    if (typeof message !== 'string') {
      throw new Error(`Malformed commits response for PR #${prNumber}: commit ${index + 1} missing message`);
    }
    return message;
  });
}

/**
 * Fetches up to `limit` most-recently-updated merged PRs for a repository,
 * including each PR's full commit message list.
 */
export async function fetchMergedPulls(
  repo: string,
  limit: number,
  fetcher: Fetcher = createDefaultFetcher(),
): Promise<MergedPullRequest[]> {
  const collected: MergedPullRequest[] = [];

  for (let page = 1; collected.length < limit; page += 1) {
    const rawPulls = await fetchJson(fetcher, [
      'api',
      `repos/${repo}/pulls`,
      '--method',
      'GET',
      '-f',
      'state=closed',
      '-f',
      'sort=updated',
      '-f',
      'direction=desc',
      '-f',
      'per_page=100',
      '-f',
      `page=${String(page)}`,
    ]);
    if (!Array.isArray(rawPulls)) {
      throw new Error(`Malformed pull request response for ${repo}: expected array`);
    }

    const mergedPulls = rawPulls.filter((raw) => {
      const pr = raw as GitHubPullRequest;
      return typeof pr.merged_at === 'string' && pr.merged_at.length > 0;
    });

    for (const raw of mergedPulls) {
      if (collected.length >= limit) break;
      const prNumber = (raw as GitHubPullRequest).number;
      if (typeof prNumber !== 'number') {
        throw new Error(`Malformed pull request response for ${repo}: missing numeric number`);
      }
      const commitMessages = await fetchPullRequestCommitMessages(repo, prNumber, fetcher);
      collected.push(parseGitHubPullRequest(raw, commitMessages));
    }

    if (rawPulls.length < 100) break;
  }

  return collected;
}

/** Fetches every commit message for one PR (paged). */
export async function fetchPullRequestCommitMessages(
  repo: string,
  prNumber: number,
  fetcher: Fetcher = createDefaultFetcher(),
): Promise<string[]> {
  const messages: string[] = [];

  for (let page = 1; ; page += 1) {
    const rawCommits = await fetchJson(fetcher, [
      'api',
      `repos/${repo}/pulls/${String(prNumber)}/commits`,
      '--method',
      'GET',
      '-f',
      'per_page=100',
      '-f',
      `page=${String(page)}`,
    ]);
    const pageMessages = parseGitHubCommitMessages(rawCommits, prNumber);
    messages.push(...pageMessages);
    if (pageMessages.length < 100) break;
  }

  return messages;
}
