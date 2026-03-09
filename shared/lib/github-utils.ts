import { escapeShellArg, execShellCommand } from './shell-utils.ts';

export interface PrReview {
  author: string;
  body: string;
  state: string;
  submittedAt: string;
}

/**
 * Resolve the GitHub owner/repo string (e.g. "timogilvie/wavemill") from
 * the git remote in the given directory.
 */
export function resolveOwnerRepo(repoDir?: string): string | undefined {
  const cwd = repoDir || process.cwd();

  try {
    const nwo = execShellCommand(
      'gh repo view --json nameWithOwner --jq .nameWithOwner',
      { encoding: 'utf-8', cwd, timeout: 10_000 },
    ).trim();
    return nwo || undefined;
  } catch {
    try {
      const remoteUrl = execShellCommand('git remote get-url origin', {
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

  const reviewsRaw = execShellCommand(
    `gh api repos/${escapeShellArg(repo)}/pulls/${escapeShellArg(prNumber)}/reviews --jq '[.[] | {author: .user.login, state: .state, body: (.body // ""), submittedAt: (.submitted_at // "")}]'`,
    { encoding: 'utf-8', cwd, timeout: 15_000 },
  ).trim();

  if (!reviewsRaw) {
    return [];
  }

  const reviews = JSON.parse(reviewsRaw) as unknown;
  return Array.isArray(reviews) ? (reviews as PrReview[]) : [];
}
