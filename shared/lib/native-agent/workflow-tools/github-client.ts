import { addLabelsToPullRequest, getPullRequest, resolveOwnerRepo } from '../../github.ts';
import { escapeShellArg, execShellCommand } from '../../shell-utils.ts';

export type GitHubClientErrorCode =
  | 'rate_limited'
  | 'not_found'
  | 'conflict'
  | 'external_error';

export class GitHubClientError extends Error {
  readonly code: GitHubClientErrorCode;

  constructor(code: GitHubClientErrorCode, message: string) {
    super(message);
    this.name = 'GitHubClientError';
    this.code = code;
  }
}

export interface GitHubRepoTarget {
  repo: string;
}

export interface FindOpenPullRequestInput extends GitHubRepoTarget {
  head: string;
  base: string;
}

export interface PullRequestMutationInput extends FindOpenPullRequestInput {
  title: string;
  body: string;
  draft?: boolean;
}

export interface UpdatePullRequestInput extends GitHubRepoTarget {
  number: number;
  title: string;
  body: string;
}

export interface LabelTargetInput extends GitHubRepoTarget {
  targetKind: 'pull_request' | 'issue';
  targetNumber: number;
}

export interface AddLabelInput extends LabelTargetInput {
  label: string;
}

export interface GitHubPullRequestState {
  number: number;
  url: string;
  headSha: string;
}

export interface GitHubPullRequestRefState {
  number: number;
  url: string;
}

export interface GitHubClient {
  findOpenPullRequest(input: FindOpenPullRequestInput): Promise<GitHubPullRequestState | null>;
  createPullRequest(input: PullRequestMutationInput): Promise<GitHubPullRequestRefState>;
  updatePullRequest(input: UpdatePullRequestInput): Promise<GitHubPullRequestRefState>;
  listLabels(input: LabelTargetInput): Promise<string[]>;
  addLabel(input: AddLabelInput): Promise<void>;
}

function buildShellCommand(args: Array<string | number>): string {
  return args.map((arg) => escapeShellArg(String(arg))).join(' ');
}

function normalizeRepo(repo: string): string {
  const normalized = repo.trim() || resolveOwnerRepo();
  if (!normalized) {
    throw new GitHubClientError(
      'external_error',
      'Unable to determine GitHub repository. Pass repo in owner/name form or run from a GitHub checkout.',
    );
  }
  return normalized;
}

function normalizeGitHubError(error: unknown, fallback: string): GitHubClientError {
  if (error instanceof GitHubClientError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes('secondary rate limit')
    || lower.includes('rate limit')
    || lower.includes('too many requests')
    || lower.includes('http 429')
  ) {
    return new GitHubClientError('rate_limited', fallback);
  }

  if (
    lower.includes('http 404')
    || lower.includes('not found')
    || lower.includes('could not resolve to a pullrequest')
    || lower.includes('could not resolve to an issue')
    || lower.includes('no pull requests found')
  ) {
    return new GitHubClientError('not_found', fallback);
  }

  if (
    lower.includes('http 409')
    || lower.includes('already exists')
    || lower.includes('a pull request already exists')
    || lower.includes('multiple matching pull requests')
  ) {
    return new GitHubClientError('conflict', fallback);
  }

  if (
    lower.includes('http 502')
    || lower.includes('http 503')
    || lower.includes('http 504')
    || lower.includes('econnreset')
    || lower.includes('etimedout')
    || lower.includes('connection reset')
    || lower.includes('temporarily unavailable')
  ) {
    return new GitHubClientError('external_error', fallback);
  }

  return new GitHubClientError('external_error', `${fallback}: ${message}`);
}

function parseCreatePullRequestNumber(url: string): number {
  const match = url.match(/\/pull\/(\d+)(?:\/?|$)/);
  if (!match) {
    throw new GitHubClientError('external_error', `Failed to parse pull request number from URL: ${url}`);
  }
  return Number.parseInt(match[1], 10);
}

function targetPath(repo: string, targetNumber: number): string {
  return `repos/${repo}/issues/${targetNumber}`;
}

export function createGhGitHubClient(): GitHubClient {
  return {
    async findOpenPullRequest(input) {
      const repo = normalizeRepo(input.repo);
      try {
        const args: Array<string | number> = [
          'gh',
          'pr',
          'list',
          '--repo',
          repo,
          '--state',
          'open',
          '--head',
          input.head,
          '--base',
          input.base,
          '--json',
          'number,url,headRefOid',
        ];

        const output = execShellCommand(buildShellCommand(args), { encoding: 'utf-8' }).trim();
        if (!output) {
          return null;
        }

        const pullRequests = JSON.parse(output) as Array<{
          number: number;
          url: string;
          headRefOid: string;
        }>;

        if (pullRequests.length === 0) {
          return null;
        }
        if (pullRequests.length > 1) {
          throw new GitHubClientError(
            'conflict',
            `Multiple open pull requests already exist for ${repo}:${input.head}->${input.base}`,
          );
        }

        const [pullRequest] = pullRequests;
        return {
          number: pullRequest.number,
          url: pullRequest.url,
          headSha: pullRequest.headRefOid,
        };
      } catch (error) {
        throw normalizeGitHubError(
          error,
          `Failed to find open pull request for ${repo}:${input.head}->${input.base}`,
        );
      }
    },

    async createPullRequest(input) {
      const repo = normalizeRepo(input.repo);
      try {
        const args: Array<string | number> = [
          'gh',
          'pr',
          'create',
          '--repo',
          repo,
          '--head',
          input.head,
          '--base',
          input.base,
          '--title',
          input.title,
          '--body',
          input.body,
        ];
        if (input.draft) {
          args.push('--draft');
        }

        const output = execShellCommand(buildShellCommand(args), { encoding: 'utf-8' }).trim();
        const url = output.split('\n').map((line) => line.trim()).find((line) => line.includes('/pull/'));
        if (!url) {
          throw new GitHubClientError('external_error', `Failed to parse pull request URL from gh output: ${output}`);
        }
        return {
          number: parseCreatePullRequestNumber(url),
          url,
        };
      } catch (error) {
        throw normalizeGitHubError(
          error,
          `Failed to create pull request for ${repo}:${input.head}->${input.base}`,
        );
      }
    },

    async updatePullRequest(input) {
      const repo = normalizeRepo(input.repo);
      try {
        const args: Array<string | number> = [
          'gh',
          'pr',
          'edit',
          input.number,
          '--repo',
          repo,
          '--title',
          input.title,
          '--body',
          input.body,
        ];
        execShellCommand(buildShellCommand(args), { encoding: 'utf-8' });
        const pullRequest = getPullRequest(input.number, { repo });
        return {
          number: pullRequest.number,
          url: pullRequest.url,
        };
      } catch (error) {
        throw normalizeGitHubError(
          error,
          `Failed to update pull request #${input.number} in ${repo}`,
        );
      }
    },

    async listLabels(input) {
      const repo = normalizeRepo(input.repo);
      void input.targetKind;
      try {
        const args: Array<string | number> = [
          'gh',
          'api',
          targetPath(repo, input.targetNumber) + '/labels',
          '--jq',
          '.[].name',
        ];
        const output = execShellCommand(buildShellCommand(args), { encoding: 'utf-8' }).trim();
        if (!output) {
          return [];
        }
        return output
          .split('\n')
          .map((label) => label.trim())
          .filter(Boolean);
      } catch (error) {
        throw normalizeGitHubError(
          error,
          `Failed to list labels on ${repo}#${input.targetNumber}`,
        );
      }
    },

    async addLabel(input) {
      const repo = normalizeRepo(input.repo);
      try {
        if (input.targetKind === 'pull_request') {
          addLabelsToPullRequest(input.targetNumber, [input.label], { repo });
          return;
        }

        const payload = JSON.stringify([input.label]);
        const args: Array<string> = [
          'gh',
          'api',
          '--method',
          'POST',
          targetPath(repo, input.targetNumber) + '/labels',
          '--input',
          '-',
        ];
        execShellCommand(
          `printf '%s' ${escapeShellArg(payload)} | ${buildShellCommand(args)}`,
          { encoding: 'utf-8' },
        );
      } catch (error) {
        throw normalizeGitHubError(
          error,
          `Failed to add label ${input.label} on ${repo}#${input.targetNumber}`,
        );
      }
    },
  };
}
