import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AddLabelInput,
  type FindOpenPullRequestInput,
  GitHubClientError,
  type GitHubClient,
  type GitHubClientErrorCode,
  type GitHubPullRequestRefState,
  type GitHubPullRequestState,
  type LabelTargetInput,
  type PullRequestMutationInput,
  type UpdatePullRequestInput,
} from './github-client.ts';
import { githubAddLabelKey, githubCreatePrKey } from './dedupe.ts';
import { githubAddLabel, githubCreatePr } from './github-tools.ts';

interface FixtureState {
  pullRequests: Array<GitHubPullRequestState & { repo: string; head: string; base: string; title?: string; body?: string }>;
  labels: Record<string, string[]>;
}

class FixtureGitHubClient implements GitHubClient {
  readonly state: FixtureState;
  readonly calls = {
    findOpenPullRequest: 0,
    createPullRequest: 0,
    updatePullRequest: 0,
    listLabels: 0,
    addLabel: 0,
  };

  private readonly failures = new Map<string, GitHubClientErrorCode[]>();

  constructor(state?: Partial<FixtureState>) {
    this.state = {
      pullRequests: state?.pullRequests ? [...state.pullRequests] : [],
      labels: { ...(state?.labels ?? {}) },
    };
  }

  queueFailures(method: keyof FixtureGitHubClient['calls'], codes: GitHubClientErrorCode[]): void {
    this.failures.set(method, [...codes]);
  }

  async findOpenPullRequest(input: FindOpenPullRequestInput): Promise<GitHubPullRequestState | null> {
    this.calls.findOpenPullRequest += 1;
    this.throwQueuedFailure('findOpenPullRequest');
    return this.state.pullRequests.find((pullRequest) =>
      pullRequest.repo === input.repo
      && pullRequest.head === input.head
      && pullRequest.base === input.base,
    ) ?? null;
  }

  async createPullRequest(input: PullRequestMutationInput): Promise<GitHubPullRequestRefState> {
    this.calls.createPullRequest += 1;
    this.throwQueuedFailure('createPullRequest');
    const number = this.state.pullRequests.length + 1;
    const url = `https://github.com/${input.repo}/pull/${number}`;
    this.state.pullRequests.push({
      repo: input.repo,
      head: input.head,
      base: input.base,
      headSha: 'created-head-sha',
      title: input.title,
      body: input.body,
      number,
      url,
    });
    return { number, url };
  }

  async updatePullRequest(input: UpdatePullRequestInput): Promise<GitHubPullRequestRefState> {
    this.calls.updatePullRequest += 1;
    this.throwQueuedFailure('updatePullRequest');
    const pullRequest = this.state.pullRequests.find((candidate) => candidate.number === input.number);
    if (!pullRequest) {
      throw new GitHubClientError('not_found', `Pull request #${input.number} not found`);
    }
    pullRequest.title = input.title;
    pullRequest.body = input.body;
    pullRequest.headSha = `${pullRequest.headSha}-updated`;
    return { number: pullRequest.number, url: pullRequest.url };
  }

  async listLabels(input: LabelTargetInput): Promise<string[]> {
    this.calls.listLabels += 1;
    this.throwQueuedFailure('listLabels');
    return [...(this.state.labels[this.labelKey(input)] ?? [])];
  }

  async addLabel(input: AddLabelInput): Promise<void> {
    this.calls.addLabel += 1;
    this.throwQueuedFailure('addLabel');
    const key = this.labelKey(input);
    const labels = this.state.labels[key] ?? [];
    labels.push(input.label);
    this.state.labels[key] = labels;
  }

  private labelKey(input: LabelTargetInput): string {
    return `${input.repo}:${input.targetKind}:${input.targetNumber}`;
  }

  private throwQueuedFailure(method: keyof FixtureGitHubClient['calls']): void {
    const queue = this.failures.get(method);
    const code = queue?.shift();
    if (!code) {
      return;
    }
    if (queue && queue.length === 0) {
      this.failures.delete(method);
    }
    throw new GitHubClientError(code, `${method} failed with ${code}`);
  }
}

describe('workflow-tools: githubCreatePr', () => {
  const request = {
    repo: 'owner/repo',
    head: 'feature-branch',
    base: 'main',
    headSha: 'abc123',
    title: 'Title',
    body: 'Body',
  } as const;

  it('creates a pull request when none exists', async () => {
    const client = new FixtureGitHubClient();

    const result = await githubCreatePr(request, { phase: 'review', client });

    assert.equal(result.ok, true);
    assert.equal(result.idempotency.outcome, 'created');
    assert.equal(result.idempotency.key, githubCreatePrKey(request));
    assert.equal(result.idempotency.ref?.url, 'https://github.com/owner/repo/pull/1');
    assert.equal(client.calls.createPullRequest, 1);
    assert.equal(client.calls.updatePullRequest, 0);
  });

  it('reuses an existing pull request when head SHA matches', async () => {
    const client = new FixtureGitHubClient({
      pullRequests: [{
        repo: request.repo,
        head: request.head,
        base: request.base,
        headSha: request.headSha,
        number: 42,
        url: 'https://github.com/owner/repo/pull/42',
      }],
    });

    const result = await githubCreatePr(request, { phase: 'review', client });

    assert.equal(result.ok, true);
    assert.equal(result.idempotency.outcome, 'reused');
    assert.equal(result.idempotency.ref?.id, '42');
    assert.equal(client.calls.createPullRequest, 0);
    assert.equal(client.calls.updatePullRequest, 0);
  });

  it('updates an existing pull request when head SHA changes', async () => {
    const client = new FixtureGitHubClient({
      pullRequests: [{
        repo: request.repo,
        head: request.head,
        base: request.base,
        headSha: 'older-sha',
        number: 7,
        url: 'https://github.com/owner/repo/pull/7',
      }],
    });

    const result = await githubCreatePr(request, { phase: 'review', client });

    assert.equal(result.ok, true);
    assert.equal(result.idempotency.outcome, 'updated');
    assert.equal(result.idempotency.ref?.number, 7);
    assert.equal(client.calls.updatePullRequest, 1);
    assert.equal(client.calls.createPullRequest, 0);
  });

  it('retries transient create failures and still succeeds', async () => {
    const client = new FixtureGitHubClient();
    client.queueFailures('findOpenPullRequest', ['rate_limited']);

    const result = await githubCreatePr(request, { phase: 'review', client });

    assert.equal(result.ok, true);
    assert.equal(result.idempotency.outcome, 'created');
    assert.equal(client.calls.findOpenPullRequest, 2);
  });

  it('returns policy_denied outside review', async () => {
    const client = new FixtureGitHubClient();

    const result = await githubCreatePr(request, { phase: 'ready', client });

    assert.deepEqual(result, {
      ok: false,
      tool: 'github_create_pr',
      error: 'policy_denied',
      message: 'ready_mutation_denied: general PR creation not allowed in ready phase; only stale_base or merge_conflict remediation',
    });
  });

  it('returns invalid_input for malformed requests', async () => {
    const client = new FixtureGitHubClient();

    const result = await githubCreatePr({ ...request, title: '   ' }, { phase: 'review', client });

    assert.deepEqual(result, {
      ok: false,
      tool: 'github_create_pr',
      error: 'invalid_input',
      message: 'repo, head, base, headSha, title, and body must be valid values',
    });
  });
});

describe('workflow-tools: githubAddLabel', () => {
  const request = {
    repo: 'owner/repo',
    targetKind: 'pull_request' as const,
    targetNumber: 42,
    label: 'needs-review',
  };

  it('adds a missing label', async () => {
    const client = new FixtureGitHubClient();

    const result = await githubAddLabel(request, { phase: 'review', client });

    assert.equal(result.ok, true);
    assert.equal(result.idempotency.outcome, 'created');
    assert.equal(result.idempotency.key, githubAddLabelKey(request));
    assert.equal(result.idempotency.ref?.id, 'owner/repo:pull_request:42:needs-review');
    assert.equal(client.calls.addLabel, 1);
  });

  it('skips when the label is already present, ignoring case', async () => {
    const client = new FixtureGitHubClient({
      labels: {
        'owner/repo:pull_request:42': ['Needs-Review'],
      },
    });

    const result = await githubAddLabel(request, { phase: 'review', client });

    assert.equal(result.ok, true);
    assert.equal(result.idempotency.outcome, 'skipped');
    assert.equal(result.idempotency.ref, null);
    assert.equal(result.idempotency.reason, 'label already present');
    assert.equal(client.calls.addLabel, 0);
  });

  it('retries transient add-label failures', async () => {
    const client = new FixtureGitHubClient();
    client.queueFailures('addLabel', ['external_error']);

    const result = await githubAddLabel(request, { phase: 'review', client });

    assert.equal(result.ok, true);
    assert.equal(result.idempotency.outcome, 'created');
    assert.equal(client.calls.addLabel, 2);
  });

  it('returns invalid_input for malformed label requests', async () => {
    const client = new FixtureGitHubClient();

    const result = await githubAddLabel({ ...request, targetNumber: 0 }, { phase: 'review', client });

    assert.deepEqual(result, {
      ok: false,
      tool: 'github_add_label',
      error: 'invalid_input',
      message: 'repo, targetKind, targetNumber, and label must be valid values',
    });
  });
});
