import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createGithubAddLabelTool,
  createGithubCreatePrTool,
  githubAddLabel,
  githubCreatePr,
  type GitHubToolDeps,
  type GitHubToolLabelTarget,
  type GitHubToolPullRequest,
} from './github.ts';
import { githubAddLabelKey, githubCreatePrKey } from './dedupe.ts';
import { isMutationAllowed } from './mutation-policy.ts';
import type { NetworkPolicy } from '../network-policy.ts';

interface FixtureState {
  pullRequests: GitHubToolPullRequest[];
  labelsByTarget: Map<string, GitHubToolLabelTarget>;
  failListOpenPullRequests: Error[];
  failCreatePullRequest: Error[];
  failUpdatePullRequest: Error[];
  failGetLabels: Error[];
  failAddLabel: Error[];
  calls: Record<string, number>;
  sleepCalls: number[];
}

function createFixtureDeps(seed?: {
  pullRequests?: GitHubToolPullRequest[];
  labelTargets?: Array<{
    repo: string;
    targetKind: 'pull_request' | 'issue';
    targetNumber: number;
    labels: string[];
    url: string;
  }>;
  failListOpenPullRequests?: Error[];
  failCreatePullRequest?: Error[];
  failUpdatePullRequest?: Error[];
  failGetLabels?: Error[];
  failAddLabel?: Error[];
  onCreateSideEffect?: (state: FixtureState) => void;
  onAddLabelSideEffect?: (state: FixtureState) => void;
}): { deps: GitHubToolDeps; state: FixtureState } {
  const state: FixtureState = {
    pullRequests: seed?.pullRequests ? [...seed.pullRequests] : [],
    labelsByTarget: new Map(
      (seed?.labelTargets ?? []).map((target) => [
        targetKey(target.repo, target.targetKind, target.targetNumber),
        {
          number: target.targetNumber,
          labels: [...target.labels],
          url: target.url,
        },
      ]),
    ),
    failListOpenPullRequests: [...(seed?.failListOpenPullRequests ?? [])],
    failCreatePullRequest: [...(seed?.failCreatePullRequest ?? [])],
    failUpdatePullRequest: [...(seed?.failUpdatePullRequest ?? [])],
    failGetLabels: [...(seed?.failGetLabels ?? [])],
    failAddLabel: [...(seed?.failAddLabel ?? [])],
    calls: {
      listOpenPullRequests: 0,
      createPullRequest: 0,
      updatePullRequest: 0,
      getLabels: 0,
      addLabel: 0,
    },
    sleepCalls: [],
  };

  const deps: GitHubToolDeps = {
    async listOpenPullRequests({ repo, head, base }) {
      state.calls.listOpenPullRequests += 1;
      const failure = state.failListOpenPullRequests.shift();
      if (failure) {
        throw failure;
      }
      return state.pullRequests.filter((pr) => (
        pr.url.includes(repo) && pr.head === head && pr.base === base
      ));
    },
    async createPullRequest({ repo, head, base, title, body }) {
      state.calls.createPullRequest += 1;
      const failure = state.failCreatePullRequest.shift();
      if (failure) {
        seed?.onCreateSideEffect?.(state);
        throw failure;
      }
      const nextNumber = Math.max(0, ...state.pullRequests.map((pr) => pr.number)) + 1;
      const pr: GitHubToolPullRequest = {
        number: nextNumber,
        title,
        body,
        head,
        base,
        url: `https://github.com/${repo}/pull/${nextNumber}`,
      };
      state.pullRequests.push(pr);
      return pr;
    },
    async updatePullRequest({ repo, number, title, body }) {
      state.calls.updatePullRequest += 1;
      const failure = state.failUpdatePullRequest.shift();
      if (failure) {
        throw failure;
      }
      const current = state.pullRequests.find((pr) => pr.number === number && pr.url.includes(repo));
      if (!current) {
        throw new Error(`Pull request #${number} not found`);
      }
      current.title = title;
      current.body = body;
      return current;
    },
    async getLabels({ repo, targetKind, targetNumber }) {
      state.calls.getLabels += 1;
      const failure = state.failGetLabels.shift();
      if (failure) {
        throw failure;
      }
      const current = state.labelsByTarget.get(targetKey(repo, targetKind, targetNumber));
      if (!current) {
        throw new Error(`${targetKind} #${targetNumber} not found`);
      }
      return {
        number: current.number,
        labels: [...current.labels],
        url: current.url,
      };
    },
    async addLabel({ repo, targetKind, targetNumber, label }) {
      state.calls.addLabel += 1;
      const failure = state.failAddLabel.shift();
      if (failure) {
        seed?.onAddLabelSideEffect?.(state);
        throw failure;
      }
      const key = targetKey(repo, targetKind, targetNumber);
      const current = state.labelsByTarget.get(key);
      if (!current) {
        throw new Error(`${targetKind} #${targetNumber} not found`);
      }
      if (!current.labels.some((existing) => existing.toLowerCase() === label.toLowerCase())) {
        current.labels.push(label);
      }
      return {
        number: current.number,
        labels: [...current.labels],
        url: current.url,
      };
    },
    async sleep(ms) {
      state.sleepCalls.push(ms);
    },
    maxAttempts: 3,
    retryDelayMs: 10,
    getSecretEnvNames() {
      return [];
    },
  };

  return { deps, state };
}

describe('githubCreatePr', () => {
  it('creates a new pull request when none exists', async () => {
    const { deps } = createFixtureDeps();
    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Implement idempotent PR tool',
      body: 'Body',
    }, deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'created');
    assert.equal(result.idempotency.key, githubCreatePrKey({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
    }));
    assert.equal(result.idempotency.ref?.number, 1);
    assert.match(String(result.idempotency.ref?.url), /pull\/1$/);
  });

  it('rejects invalid wavemill metadata before GitHub calls', async () => {
    const { deps, state } = createFixtureDeps();
    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Implement idempotent PR tool',
      body: [
        '<!-- wavemill-meta',
        'task: HOK-2929',
        'review-infrastructure-note: native-context-window-exceeded',
        '-->',
      ].join('\n'),
    }, deps);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'invalid_input');
    assert.match(result.message, /review-infrastructure-note/);
    assert.match(result.message, /outside the managed wavemill-meta block/);
    assert.equal(result.message.includes('native-context-window-exceeded'), false);
    assert.equal(state.calls.listOpenPullRequests, 0);
    assert.equal(state.calls.createPullRequest, 0);
    assert.equal(state.calls.updatePullRequest, 0);
  });

  it('reuses an existing matching pull request', async () => {
    const { deps, state } = createFixtureDeps({
      pullRequests: [{
        number: 42,
        title: 'Implement idempotent PR tool',
        body: 'Body',
        head: 'feature/idempotent-pr',
        base: 'main',
        url: 'https://github.com/acme/widgets/pull/42',
      }],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Implement idempotent PR tool',
      body: 'Body',
    }, deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'reused');
    assert.equal(result.idempotency.ref?.number, 42);
    assert.equal(state.calls.createPullRequest, 0);
    assert.equal(state.calls.updatePullRequest, 0);
  });

  it('updates an existing pull request when title or body differ', async () => {
    const { deps, state } = createFixtureDeps({
      pullRequests: [{
        number: 42,
        title: 'Old title',
        body: 'Old body',
        head: 'feature/idempotent-pr',
        base: 'main',
        url: 'https://github.com/acme/widgets/pull/42',
      }],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'New title',
      body: 'New body',
    }, deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'updated');
    assert.equal(result.idempotency.ref?.number, 42);
    assert.equal(state.pullRequests[0]?.title, 'New title');
    assert.equal(state.pullRequests[0]?.body, 'New body');
  });

  it('retries after rate limiting and then succeeds', async () => {
    const { deps, state } = createFixtureDeps({
      failListOpenPullRequests: [new Error('HTTP 429 rate limit exceeded')],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Retry title',
      body: 'Retry body',
    }, deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'created');
    assert.equal(state.calls.listOpenPullRequests, 2);
    assert.deepEqual(state.sleepCalls, [10]);
  });

  it('does not duplicate a pull request when create partially succeeds before a transient failure', async () => {
    const { deps, state } = createFixtureDeps({
      failCreatePullRequest: [new Error('network timeout while waiting for GitHub')],
      onCreateSideEffect(fixture) {
        fixture.pullRequests.push({
          number: 77,
          title: 'Transient title',
          body: 'Transient body',
          head: 'feature/idempotent-pr',
          base: 'main',
          url: 'https://github.com/acme/widgets/pull/77',
        });
      },
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Transient title',
      body: 'Transient body',
    }, deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'reused');
    assert.equal(result.idempotency.ref?.number, 77);
    assert.equal(state.pullRequests.length, 1);
    assert.equal(state.calls.createPullRequest, 1);
  });

  it('maps duplicate open pull requests to conflict', async () => {
    const { deps } = createFixtureDeps({
      pullRequests: [
        {
          number: 41,
          title: 'One',
          body: 'Body',
          head: 'feature/idempotent-pr',
          base: 'main',
          url: 'https://github.com/acme/widgets/pull/41',
        },
        {
          number: 42,
          title: 'Two',
          body: 'Body',
          head: 'feature/idempotent-pr',
          base: 'main',
          url: 'https://github.com/acme/widgets/pull/42',
        },
      ],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Title',
      body: 'Body',
    }, deps);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.tool, 'github_create_pr');
    assert.equal(result.error, 'conflict');
    assert.equal(result.message, 'Multiple open pull requests already exist for acme/widgets:feature/idempotent-pr->main');
    assert.equal(result.metadata?.trust?.sourceKind, 'wavemill_artifact');
  });

  it('maps not_found errors', async () => {
    const { deps } = createFixtureDeps({
      failCreatePullRequest: [new Error('Repository not found')],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Title',
      body: 'Body',
    }, deps);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.tool, 'github_create_pr');
    assert.equal(result.error, 'not_found');
    assert.equal(result.message, 'Repository not found');
    assert.equal(result.metadata?.trust?.sourceKind, 'wavemill_artifact');
  });

  it('denies ready-phase general PR mutations', async () => {
    const { deps } = createFixtureDeps();
    const result = await githubCreatePr({
      repo: 'acme/widgets',
      phase: 'ready',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Title',
      body: 'Body',
    }, deps);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.tool, 'github_create_pr');
    assert.equal(result.error, 'policy_denied');
    assert.equal(result.message, 'ready_mutation_denied: general PR creation not allowed in ready phase; only stale_base or merge_conflict remediation');
    assert.equal(result.metadata?.trust?.sourceKind, 'wavemill_artifact');
  });

  it('denies when review-phase network policy blocks GitHub access before any transport call', async () => {
    const { deps, state } = createFixtureDeps();
    const result = await githubCreatePr({
      repo: 'acme/widgets',
      phase: 'review',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Title',
      body: 'Body',
    }, {
      ...deps,
      networkPolicy: {
        review: {
          github_create_pr: { kind: 'deny' },
        },
      } satisfies NetworkPolicy,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'policy_denied');
    assert.equal(state.calls.listOpenPullRequests, 0);
    assert.equal((result.diagnostics as { category: string }).category, 'network');
  });
});

describe('githubAddLabel', () => {
  it('adds a missing label', async () => {
    const { deps } = createFixtureDeps({
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'pull_request',
        targetNumber: 22,
        labels: ['existing'],
        url: 'https://github.com/acme/widgets/pull/22',
      }],
    });

    const result = await githubAddLabel({
      repo: 'acme/widgets',
      targetKind: 'pull_request',
      targetNumber: 22,
      label: 'needs-review',
    }, deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'created');
    assert.equal(result.idempotency.key, githubAddLabelKey({
      repo: 'acme/widgets',
      targetKind: 'pull_request',
      targetNumber: 22,
      label: 'needs-review',
    }));
    assert.equal(result.idempotency.ref?.id, 'acme/widgets#22:needs-review');
    assert.match(String(result.idempotency.ref?.url), /pull\/22$/);
  });

  it('skips when the label is already present case-insensitively', async () => {
    const { deps, state } = createFixtureDeps({
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'pull_request',
        targetNumber: 22,
        labels: ['Needs-Review'],
        url: 'https://github.com/acme/widgets/pull/22',
      }],
    });

    const result = await githubAddLabel({
      repo: 'acme/widgets',
      targetKind: 'pull_request',
      targetNumber: 22,
      label: 'needs-review',
    }, deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'skipped');
    assert.equal(result.idempotency.ref, null);
    assert.match(String(result.idempotency.reason), /already present/);
    assert.equal(state.calls.addLabel, 0);
  });

  it('retries and becomes a no-op when the label was added before the transient failure surfaced', async () => {
    const { deps, state } = createFixtureDeps({
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'pull_request',
        targetNumber: 22,
        labels: [],
        url: 'https://github.com/acme/widgets/pull/22',
      }],
      failAddLabel: [new Error('network timeout while adding label')],
      onAddLabelSideEffect(fixture) {
        const current = fixture.labelsByTarget.get(targetKey('acme/widgets', 'pull_request', 22));
        current?.labels.push('needs-review');
      },
    });

    const result = await githubAddLabel({
      repo: 'acme/widgets',
      targetKind: 'pull_request',
      targetNumber: 22,
      label: 'needs-review',
    }, deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'skipped');
    assert.equal(state.calls.addLabel, 1);
    assert.deepEqual(state.sleepCalls, [10]);
  });

  it('maps not_found errors', async () => {
    const { deps } = createFixtureDeps({
      failGetLabels: [new Error('Issue #99 not found')],
    });

    const result = await githubAddLabel({
      repo: 'acme/widgets',
      targetKind: 'issue',
      targetNumber: 99,
      label: 'needs-review',
    }, deps);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.tool, 'github_add_label');
    assert.equal(result.error, 'not_found');
    assert.equal(result.message, 'Issue #99 not found');
    assert.equal(result.metadata?.trust?.sourceKind, 'wavemill_artifact');
  });

  it('denies non-review label mutations', async () => {
    const { deps } = createFixtureDeps({
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'issue',
        targetNumber: 99,
        labels: [],
        url: 'https://github.com/acme/widgets/issues/99',
      }],
    });

    const result = await githubAddLabel({
      repo: 'acme/widgets',
      phase: 'ready',
      targetKind: 'issue',
      targetNumber: 99,
      label: 'needs-review',
    }, deps);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.tool, 'github_add_label');
    assert.equal(result.error, 'policy_denied');
    assert.equal(result.message, 'ready_mutation_denied: label add not allowed in ready phase');
    assert.equal(result.metadata?.trust?.sourceKind, 'wavemill_artifact');
  });

  it('distinguishes network policy denial from transport failure for label adds', async () => {
    const { deps, state } = createFixtureDeps({
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'issue',
        targetNumber: 99,
        labels: [],
        url: 'https://github.com/acme/widgets/issues/99',
      }],
    });

    const denied = await githubAddLabel({
      repo: 'acme/widgets',
      phase: 'review',
      targetKind: 'issue',
      targetNumber: 99,
      label: 'needs-review',
    }, {
      ...deps,
      networkPolicy: {
        review: {
          github_add_label: { kind: 'deny' },
        },
      } satisfies NetworkPolicy,
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'policy_denied');
    assert.equal(state.calls.getLabels, 0);
    assert.equal((denied.diagnostics as { category: string }).category, 'network');

    const failed = await githubAddLabel({
      repo: 'acme/widgets',
      phase: 'review',
      targetKind: 'issue',
      targetNumber: 99,
      label: 'needs-review',
    }, {
      ...deps,
      getLabels: async () => {
        throw new Error('network timeout');
      },
      networkPolicy: {
        review: {
          github_add_label: { kind: 'allowlist', hosts: ['api.github.com'] },
        },
      } satisfies NetworkPolicy,
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'external_error');
  });
});

describe('workflow tool descriptors', () => {
  it('createGithubCreatePrTool returns the contract details payload', async () => {
    const { deps } = createFixtureDeps();
    const tool = createGithubCreatePrTool(deps);
    const result = await tool.execute('call-1', {
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Title',
      body: 'Body',
    });

    assert.equal(tool.metadata.name, 'github_create_pr');
    assert.equal(result.details.ok, true);
    assert.match(result.content[0]?.text ?? '', /created/);
  });

  it('createGithubAddLabelTool returns the contract details payload', async () => {
    const { deps } = createFixtureDeps({
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'issue',
        targetNumber: 99,
        labels: [],
        url: 'https://github.com/acme/widgets/issues/99',
      }],
    });
    const tool = createGithubAddLabelTool(deps);
    const result = await tool.execute('call-1', {
      repo: 'acme/widgets',
      targetKind: 'issue',
      targetNumber: 99,
      label: 'needs-review',
    });

    assert.equal(tool.metadata.name, 'github_add_label');
    assert.equal(result.details.ok, true);
    assert.match(result.content[0]?.text ?? '', /created/);
  });
});

describe('workflow policy invariants', () => {
  it('merge remains denied for review and no merge helper is exported', () => {
    assert.equal(isMutationAllowed('review', 'github_create_pr', 'merge').allowed, false);
  });
});

// ---------------------------------------------------------------------------
// Secret redaction in github_create_pr
// ---------------------------------------------------------------------------

describe('github_create_pr: secret redaction', () => {
  it('redacts secrets in body before calling createPullRequest', async () => {
    let capturedBody: string | undefined;
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const { deps } = createFixtureDeps({
      onCreateSideEffect: () => {},
    });
    const captureCreateDeps: Partial<GitHubToolDeps> = {
      ...deps,
      async listOpenPullRequests() { return []; },
      async createPullRequest(input) {
        capturedBody = input.body;
        return {
          number: 99,
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          url: 'https://github.com/org/repo/pull/99',
        };
      },
    };

    const result = await githubCreatePr(
      {
        repo: 'org/repo',
        head: 'feature/branch',
        base: 'main',
        headSha: 'abc1234',
        title: 'Add feature',
        body: `## Summary\nUsed token: ${token}`,
        phase: 'review',
      },
      captureCreateDeps,
    );

    assert.equal(result.ok, true);
    assert.ok(capturedBody !== undefined, 'createPullRequest must have been called');
    assert.ok(!capturedBody.includes(token), 'original token must not appear in PR body');
    assert.ok(capturedBody.includes('[REDACTED:github_pat]'), 'redacted placeholder must appear');
  });

  it('redacts configured secret env values in body before calling createPullRequest', async () => {
    let capturedBody: string | undefined;
    process.env.HOKUSAI_PR_SECRET = 'pr-configured-value-without-known-pattern';
    const { deps } = createFixtureDeps();
    const captureCreateDeps: Partial<GitHubToolDeps> = {
      ...deps,
      getSecretEnvNames: () => ['HOKUSAI_PR_SECRET'],
      async listOpenPullRequests() { return []; },
      async createPullRequest(input) {
        capturedBody = input.body;
        return {
          number: 99,
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          url: 'https://github.com/org/repo/pull/99',
        };
      },
    };

    try {
      const result = await githubCreatePr(
        {
          repo: 'org/repo',
          head: 'feature/branch',
          base: 'main',
          headSha: 'abc1234',
          title: 'Add feature',
          body: 'Secret: pr-configured-value-without-known-pattern',
          phase: 'review',
        },
        captureCreateDeps,
      );

      assert.equal(result.ok, true);
      assert.ok(capturedBody !== undefined, 'createPullRequest must have been called');
      assert.equal(capturedBody, 'Secret: [REDACTED:configured_secret]');
    } finally {
      delete process.env.HOKUSAI_PR_SECRET;
    }
  });
});

function targetKey(repo: string, targetKind: 'pull_request' | 'issue', targetNumber: number): string {
  return `${repo}:${targetKind}:${targetNumber}`;
}
