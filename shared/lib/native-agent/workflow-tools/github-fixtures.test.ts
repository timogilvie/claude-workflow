/**
 * Fixture-backed GitHub mock suite (HOK-2362_c, deliverable #1).
 *
 * Proves the mock suite is driven by fixture data loaded from fixtures/github/,
 * mirroring the loadFixture() pattern in linear-tools.test.ts. No inline
 * hand-built state — all seed data comes from the JSON fixture files.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { githubAddLabel, githubCreatePr } from './github.ts';
import type { GitHubToolLabelTarget, GitHubToolPullRequest } from './github.ts';
import {
  createFixtureBackedGithubDeps,
  loadGithubErrors,
  loadGithubFixture,
} from './fixtures/github-mock.ts';

describe('github-fixtures: fixture-backed PR suite', () => {
  it('open-prs-empty.json is an empty array (fixture integrity)', () => {
    const openPrs = loadGithubFixture<GitHubToolPullRequest[]>('open-prs-empty.json');
    assert.deepEqual(openPrs, [], 'open-prs-empty fixture must be an empty array');
  });

  it('creates a PR when no existing PRs (fixture: open-prs-empty.json)', async () => {
    const openPrs = loadGithubFixture<GitHubToolPullRequest[]>('open-prs-empty.json');
    // Seed from the fixture: no PRs
    const { deps, state } = createFixtureBackedGithubDeps({
      pullRequests: [...openPrs],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Implement idempotent PR tool',
      body: 'Body text for the pull request.',
    }, deps);

    assert.equal(result.ok, true, 'idempotent_reuse: created should succeed when no PRs exist');
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'created', 'idempotent_reuse: outcome must be created');
    assert.equal(state.calls.createPullRequest, 1, 'idempotent_reuse: createPullRequest must be called exactly once');
    assert.equal(state.pullRequests.length, 1, 'idempotent_reuse: exactly one PR must exist after create');
  });

  it('reuses existing PR seeded from fixture (fixture: pr-existing.json)', async () => {
    const prExisting = loadGithubFixture<GitHubToolPullRequest>('pr-existing.json');
    const { deps, state } = createFixtureBackedGithubDeps({
      pullRequests: [prExisting],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: prExisting.head,
      base: prExisting.base,
      headSha: 'abc123',
      title: prExisting.title,
      body: prExisting.body,
    }, deps);

    assert.equal(result.ok, true, 'idempotent_reuse: reuse should succeed when matching PR exists');
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'reused', 'idempotent_reuse: outcome must be reused');
    assert.equal(result.idempotency.ref?.number, prExisting.number, 'idempotent_reuse: ref must point to the existing PR');
    assert.equal(state.calls.createPullRequest, 0, 'idempotent_reuse: createPullRequest must NOT be called on reuse');
    assert.equal(state.calls.updatePullRequest, 0, 'idempotent_reuse: updatePullRequest must NOT be called on reuse');
  });

  it('updates existing PR when title or body differ (fixture: pr-existing.json + pr-updated.json)', async () => {
    const prExisting = loadGithubFixture<GitHubToolPullRequest>('pr-existing.json');
    const prUpdated = loadGithubFixture<GitHubToolPullRequest>('pr-updated.json');
    const { deps, state } = createFixtureBackedGithubDeps({
      pullRequests: [prExisting],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: prExisting.head,
      base: prExisting.base,
      headSha: 'abc123',
      title: prUpdated.title,
      body: prUpdated.body,
    }, deps);

    assert.equal(result.ok, true, 'update: should succeed when title/body differ from existing PR');
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'updated', 'update: outcome must be updated');
    assert.equal(result.idempotency.ref?.number, prExisting.number, 'update: ref must point to the original PR number');
    assert.equal(state.calls.updatePullRequest, 1, 'update: updatePullRequest must be called exactly once');
    assert.equal(state.calls.createPullRequest, 0, 'update: createPullRequest must NOT be called when updating');
    assert.equal(state.pullRequests[0]?.title, prUpdated.title, 'update: PR title must be updated in state');
  });

  it('maps rate_limited error and retries to success (fixture: errors.json)', async () => {
    const errors = loadGithubErrors();
    const { deps, state } = createFixtureBackedGithubDeps({
      failListOpenPullRequests: [new Error(errors.rate_limited)],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Rate limit test',
      body: 'Body',
    }, deps);

    assert.equal(result.ok, true, 'api_failure: rate-limited retries should succeed');
    assert.equal(state.calls.listOpenPullRequests, 2, 'api_failure: must retry after rate limit (2 total calls)');
    assert.equal(state.sleepCalls.length, 1, 'api_failure: must sleep between retries');
  });

  it('maps not_found error from errors fixture (fixture: errors.json)', async () => {
    const errors = loadGithubErrors();
    const { deps } = createFixtureBackedGithubDeps({
      failCreatePullRequest: [new Error(errors.not_found)],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/idempotent-pr',
      base: 'main',
      headSha: 'abc123',
      title: 'Not found test',
      body: 'Body',
    }, deps);

    assert.equal(result.ok, false, 'api_failure: not_found error should produce ok:false');
    if (result.ok) return;
    assert.equal(result.error, 'not_found', 'api_failure: error class must be not_found');
    assert.match(result.message, /not found/i, 'api_failure: message must describe the not-found condition');
  });

  it('does not duplicate a PR after transient failure + side effect (fixture: pr-created.json + errors.json)', async () => {
    const prCreated = loadGithubFixture<GitHubToolPullRequest>('pr-created.json');
    const errors = loadGithubErrors();
    const { deps, state } = createFixtureBackedGithubDeps({
      failCreatePullRequest: [new Error(errors.transient_network)],
      onCreateSideEffect(fixture) {
        // Simulate: the external call went through before the error was surfaced
        fixture.pullRequests.push({ ...prCreated });
      },
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: prCreated.head,
      base: prCreated.base,
      headSha: 'abc123',
      title: prCreated.title,
      body: prCreated.body,
    }, deps);

    assert.equal(result.ok, true, 'idempotent_reuse: should recover after transient failure with side effect');
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'reused', 'idempotent_reuse: outcome must be reused (not created again)');
    assert.equal(result.idempotency.ref?.number, prCreated.number, 'idempotent_reuse: must reference the PR created by the side effect');
    assert.equal(state.pullRequests.length, 1, 'idempotent_reuse: must not duplicate PR');
    assert.equal(state.calls.createPullRequest, 1, 'idempotent_reuse: createPullRequest called once (the failed attempt)');
  });
});

describe('github-fixtures: fixture-backed label suite', () => {
  it('adds a missing label to a PR seeded from fixture (fixture: labels-before.json → labels-after.json)', async () => {
    const labelsBefore = loadGithubFixture<GitHubToolLabelTarget>('labels-before.json');
    const labelsAfter = loadGithubFixture<GitHubToolLabelTarget>('labels-after.json');

    const { deps, state } = createFixtureBackedGithubDeps({
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'pull_request',
        targetNumber: labelsBefore.number,
        labels: [...labelsBefore.labels],
        url: labelsBefore.url,
      }],
    });

    const result = await githubAddLabel({
      repo: 'acme/widgets',
      targetKind: 'pull_request',
      targetNumber: labelsBefore.number,
      label: 'needs-review',
    }, deps);

    assert.equal(result.ok, true, 'idempotent_reuse: label add should succeed');
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'created', 'idempotent_reuse: outcome must be created for a new label');
    assert.equal(state.calls.addLabel, 1, 'idempotent_reuse: addLabel must be called once');
    const labelTarget = state.labelsByTarget.get(`acme/widgets:pull_request:${labelsBefore.number}`);
    assert.deepEqual(
      labelTarget?.labels.slice().sort(),
      labelsAfter.labels.slice().sort(),
      'idempotent_reuse: resulting labels must match the labels-after fixture',
    );
  });

  it('skips when label already present (fixture: labels-after.json)', async () => {
    const labelsAfter = loadGithubFixture<GitHubToolLabelTarget>('labels-after.json');
    const { deps, state } = createFixtureBackedGithubDeps({
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'pull_request',
        targetNumber: labelsAfter.number,
        labels: [...labelsAfter.labels],
        url: labelsAfter.url,
      }],
    });

    const result = await githubAddLabel({
      repo: 'acme/widgets',
      targetKind: 'pull_request',
      targetNumber: labelsAfter.number,
      label: 'needs-review',
    }, deps);

    assert.equal(result.ok, true, 'idempotent_reuse: skip should return ok:true');
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'skipped', 'idempotent_reuse: outcome must be skipped when label already present');
    assert.equal(state.calls.addLabel, 0, 'idempotent_reuse: addLabel must NOT be called when label is already present');
  });

  it('maps not_found error for label target (fixture: errors.json)', async () => {
    const errors = loadGithubErrors();
    const { deps } = createFixtureBackedGithubDeps({
      failGetLabels: [new Error(errors.not_found)],
    });

    const result = await githubAddLabel({
      repo: 'acme/widgets',
      targetKind: 'pull_request',
      targetNumber: 99,
      label: 'needs-review',
    }, deps);

    assert.equal(result.ok, false, 'api_failure: not_found for label target should produce ok:false');
    if (result.ok) return;
    assert.equal(result.error, 'not_found', 'api_failure: error class must be not_found');
  });

  it('does not duplicate a label after transient failure + side effect (fixture: errors.json)', async () => {
    const errors = loadGithubErrors();
    const { deps, state } = createFixtureBackedGithubDeps({
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'pull_request',
        targetNumber: 22,
        labels: [],
        url: 'https://github.com/acme/widgets/pull/22',
      }],
      failAddLabel: [new Error(errors.transient_network)],
      onAddLabelSideEffect(fixture) {
        const current = fixture.labelsByTarget.get('acme/widgets:pull_request:22');
        current?.labels.push('needs-review');
      },
    });

    const result = await githubAddLabel({
      repo: 'acme/widgets',
      targetKind: 'pull_request',
      targetNumber: 22,
      label: 'needs-review',
    }, deps);

    assert.equal(result.ok, true, 'idempotent_reuse: should recover after transient label add failure with side effect');
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'skipped', 'idempotent_reuse: outcome must be skipped (label already present from side effect)');
    assert.equal(state.calls.addLabel, 1, 'idempotent_reuse: addLabel called once (the failed attempt)');
    const labels = state.labelsByTarget.get('acme/widgets:pull_request:22')?.labels ?? [];
    const count = labels.filter((l) => l.toLowerCase() === 'needs-review').length;
    assert.equal(count, 1, 'idempotent_reuse: label must appear exactly once (no duplicate)');
  });
});
