/**
 * Acceptance diagnostic matrix + retry/no-dup tests (HOK-2362_c, deliverables #4 + acceptance).
 *
 * For each mutation kind — PR, label, comment, status (write_stage_result) — asserts
 * all three diagnostic classes are *distinguishable*:
 *
 *   idempotent_reuse  — transient failure after external side effect: retry, assert exactly
 *                       one external object created and outcome reused/skipped.
 *   policy_denied     — run in a denying phase: assert error === 'policy_denied', no external
 *                       call, registry untouched.
 *   api_failure       — exhaust retries: assert a non-policy error, distinct message.
 *
 * Each assertion carries an explicit diagnostic label so a failure names which class regressed.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { createInMemoryDedupeRegistry } from './dedupe.ts';
import { githubAddLabel, githubCreatePr } from './github.ts';
import {
  executeLinearComment,
  type LinearClient,
  type LinearToolsDeps,
  type WorkflowToolStageArtifactEntry,
  type WorkflowToolTranscriptEvent,
} from './linear-tools.ts';
import {
  executeWriteStageResult,
  type CommandToolsDeps,
} from './command-tools.ts';
import { isMutationAllowed } from './mutation-policy.ts';
import { createFixtureBackedGithubDeps } from './fixtures/github-mock.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeLinearClient(opts: { failCreate?: boolean } = {}): LinearClient {
  return {
    async getIssue(identifier: string) {
      return {
        id: `id-${identifier}`,
        identifier,
        title: `Issue ${identifier}`,
        url: `https://linear.app/acme/issue/${identifier}`,
      };
    },
    async createComment(_issueId: string, _body: string) {
      if (opts.failCreate) throw new Error('Linear API unavailable');
      return { id: 'comment-1', url: 'https://linear.app/acme/comment/1' };
    },
    async updateComment(_id: string, _body: string) {
      return { id: 'comment-1', url: 'https://linear.app/acme/comment/1' };
    },
  };
}

function makeNoopRecorder(): {
  transcript: LinearToolsDeps['transcript'];
  stageArtifact: LinearToolsDeps['stageArtifact'];
} {
  return {
    transcript: { append(_e: WorkflowToolTranscriptEvent) {} },
    stageArtifact: { append(_e: WorkflowToolStageArtifactEntry) {} },
  };
}

function makeCommandDeps(overrides: Partial<CommandToolsDeps> = {}): CommandToolsDeps {
  const { transcript, stageArtifact } = makeNoopRecorder();
  return {
    registry: overrides.registry ?? createInMemoryDedupeRegistry({ clock: () => 1_000 }),
    transcript,
    stageArtifact,
    sessionId: 'sess-test-1',
    phase: overrides.phase ?? 'coding',
    clock: () => 1_000,
    writeStageResultImpl: overrides.writeStageResultImpl,
    readStageResultImpl: overrides.readStageResultImpl,
    updateStageResultImpl: overrides.updateStageResultImpl,
  };
}

let tempDirs: string[] = [];

beforeEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ---------------------------------------------------------------------------
// github_create_pr — three diagnostic classes
// ---------------------------------------------------------------------------

describe('retry-idempotency: github_create_pr', () => {
  it('idempotent_reuse: transient failure after create side effect → reused, exactly 1 PR', async () => {
    const { deps, state } = createFixtureBackedGithubDeps({
      failCreatePullRequest: [new Error('network timeout while waiting for GitHub')],
      onCreateSideEffect(fixture) {
        fixture.pullRequests.push({
          number: 77,
          title: 'No-dup title',
          body: 'No-dup body',
          head: 'feature/no-dup',
          base: 'main',
          url: 'https://github.com/acme/widgets/pull/77',
        });
      },
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/no-dup',
      base: 'main',
      headSha: 'abc123',
      title: 'No-dup title',
      body: 'No-dup body',
    }, deps);

    assert.equal(result.ok, true, 'idempotent_reuse: github_create_pr — must succeed after transient failure with side effect');
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'reused', 'idempotent_reuse: github_create_pr — outcome must be reused, not created again');
    assert.equal(state.pullRequests.length, 1, 'idempotent_reuse: github_create_pr — exactly 1 PR must exist (no duplicate)');
    assert.equal(state.calls.createPullRequest, 1, 'idempotent_reuse: github_create_pr — createPullRequest called once (the failed attempt)');
  });

  it('policy_denied: ready phase denies general PR creation, no external call made', async () => {
    const { deps, state } = createFixtureBackedGithubDeps();

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      phase: 'ready',
      head: 'feature/no-dup',
      base: 'main',
      headSha: 'abc123',
      title: 'Policy denied title',
      body: 'Body',
    }, deps);

    assert.equal(result.ok, false, 'policy_denied: github_create_pr — must fail in ready phase');
    if (result.ok) return;
    assert.equal(result.error, 'policy_denied', 'policy_denied: github_create_pr — error must be policy_denied, distinguishable from api_failure and idempotent_reuse');
    assert.equal(state.calls.listOpenPullRequests, 0, 'policy_denied: github_create_pr — listOpenPullRequests must NOT be called on policy denial');
    assert.equal(state.calls.createPullRequest, 0, 'policy_denied: github_create_pr — createPullRequest must NOT be called on policy denial');
  });

  it('api_failure: exhausted retries → non-policy error, distinct from policy_denied and reuse', async () => {
    const { deps } = createFixtureBackedGithubDeps({
      failListOpenPullRequests: [
        new Error('HTTP 503 service unavailable'),
        new Error('HTTP 503 service unavailable'),
        new Error('HTTP 503 service unavailable'),
      ],
    });

    const result = await githubCreatePr({
      repo: 'acme/widgets',
      head: 'feature/no-dup',
      base: 'main',
      headSha: 'abc123',
      title: 'API failure title',
      body: 'Body',
    }, deps);

    assert.equal(result.ok, false, 'api_failure: github_create_pr — must fail after exhausted retries');
    if (result.ok) return;
    assert.notEqual(result.error, 'policy_denied', 'api_failure: github_create_pr — error must NOT be policy_denied (distinct diagnostic class)');
    assert.ok(
      result.error === 'external_error' || result.error === 'rate_limited',
      `api_failure: github_create_pr — error must be external_error or rate_limited, got: ${result.error}`,
    );
    assert.ok(result.message.length > 0, 'api_failure: github_create_pr — message must be non-empty for diagnostics');
  });
});

// ---------------------------------------------------------------------------
// github_add_label — three diagnostic classes
// ---------------------------------------------------------------------------

describe('retry-idempotency: github_add_label', () => {
  it('idempotent_reuse: transient failure after label add side effect → skipped, label exists once', async () => {
    const { deps, state } = createFixtureBackedGithubDeps({
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'pull_request',
        targetNumber: 22,
        labels: [],
        url: 'https://github.com/acme/widgets/pull/22',
      }],
      failAddLabel: [new Error('network timeout while adding label')],
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

    assert.equal(result.ok, true, 'idempotent_reuse: github_add_label — must succeed after transient failure with side effect');
    if (!result.ok) return;
    assert.equal(result.idempotency.outcome, 'skipped', 'idempotent_reuse: github_add_label — outcome must be skipped (label already present from side effect)');
    assert.equal(state.calls.addLabel, 1, 'idempotent_reuse: github_add_label — addLabel called once (the failed attempt)');
    const labels = state.labelsByTarget.get('acme/widgets:pull_request:22')?.labels ?? [];
    const reviewCount = labels.filter((l) => l.toLowerCase() === 'needs-review').length;
    assert.equal(reviewCount, 1, 'idempotent_reuse: github_add_label — label must appear exactly once (no duplicate)');
  });

  it('policy_denied: ready phase denies label add, no external call made', async () => {
    const { deps, state } = createFixtureBackedGithubDeps({
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

    assert.equal(result.ok, false, 'policy_denied: github_add_label — must fail in ready phase');
    if (result.ok) return;
    assert.equal(result.error, 'policy_denied', 'policy_denied: github_add_label — error must be policy_denied, distinguishable from api_failure and idempotent_reuse');
    assert.equal(state.calls.getLabels, 0, 'policy_denied: github_add_label — getLabels must NOT be called on policy denial');
    assert.equal(state.calls.addLabel, 0, 'policy_denied: github_add_label — addLabel must NOT be called on policy denial');
  });

  it('api_failure: exhausted retries → non-policy error, distinct from policy_denied', async () => {
    const { deps } = createFixtureBackedGithubDeps({
      failGetLabels: [
        new Error('HTTP 503 service unavailable'),
        new Error('HTTP 503 service unavailable'),
        new Error('HTTP 503 service unavailable'),
      ],
    });

    const result = await githubAddLabel({
      repo: 'acme/widgets',
      targetKind: 'pull_request',
      targetNumber: 22,
      label: 'needs-review',
    }, deps);

    assert.equal(result.ok, false, 'api_failure: github_add_label — must fail after exhausted retries');
    if (result.ok) return;
    assert.notEqual(result.error, 'policy_denied', 'api_failure: github_add_label — error must NOT be policy_denied (distinct diagnostic class)');
    assert.ok(result.message.length > 0, 'api_failure: github_add_label — message must be non-empty for diagnostics');
  });
});

// ---------------------------------------------------------------------------
// linear_comment — three diagnostic classes
// ---------------------------------------------------------------------------

describe('retry-idempotency: linear_comment', () => {
  it('idempotent_reuse: second call with same args → reused, createComment called exactly once', async () => {
    let createCallCount = 0;
    const client: LinearClient = {
      async getIssue(identifier) {
        return { id: `id-${identifier}`, identifier, title: 'T', url: 'https://linear.app/test' };
      },
      async createComment(_issueId, _body) {
        createCallCount++;
        return { id: 'comment-1', url: 'https://linear.app/acme/comment/1' };
      },
      async updateComment(_id, _body) {
        return { id: 'comment-1', url: 'https://linear.app/acme/comment/1' };
      },
    };
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const { transcript, stageArtifact } = makeNoopRecorder();
    const sharedDeps: LinearToolsDeps = {
      client,
      registry,
      transcript,
      stageArtifact,
      sessionId: 'sess-1',
      phase: 'coding',
      clock: () => 1_000,
    };

    const params = { issue: 'HOK-1', body: 'Progress update', sessionId: 'sess-1', phase: 'coding' as const };
    const r1 = await executeLinearComment(params, sharedDeps);
    const r2 = await executeLinearComment(params, sharedDeps);

    assert.equal(r1.ok, true, 'idempotent_reuse: linear_comment — first call must succeed');
    assert.equal(r2.ok, true, 'idempotent_reuse: linear_comment — second call must succeed');
    if (r1.ok) {
      assert.equal(r1.idempotency.outcome, 'created', 'idempotent_reuse: linear_comment — first call outcome must be created');
    }
    if (r2.ok) {
      assert.equal(r2.idempotency.outcome, 'reused', 'idempotent_reuse: linear_comment — second call outcome must be reused');
    }
    assert.equal(createCallCount, 1, 'idempotent_reuse: linear_comment — createComment must be called exactly once across both calls');
  });

  it('policy_denied: ready phase denies linear_comment, no API call, registry untouched', async () => {
    let createCallCount = 0;
    const client: LinearClient = {
      async getIssue(identifier) {
        return { id: `id-${identifier}`, identifier, title: 'T', url: 'https://linear.app/test' };
      },
      async createComment(_issueId, _body) {
        createCallCount++;
        return { id: 'comment-1', url: 'https://linear.app/acme/comment/1' };
      },
      async updateComment(_id, _body) {
        return { id: 'comment-1', url: 'https://linear.app/acme/comment/1' };
      },
    };
    const registry = createInMemoryDedupeRegistry();
    const { transcript, stageArtifact } = makeNoopRecorder();
    const deps: LinearToolsDeps = {
      client,
      registry,
      transcript,
      stageArtifact,
      sessionId: 'sess-1',
      phase: 'ready',
      clock: () => 1_000,
    };

    const result = await executeLinearComment(
      { issue: 'HOK-1', body: 'Denied comment', sessionId: 'sess-1', phase: 'ready' },
      deps,
    );

    assert.equal(result.ok, false, 'policy_denied: linear_comment — must fail in ready phase');
    if (result.ok) return;
    assert.equal(result.error, 'policy_denied', 'policy_denied: linear_comment — error must be policy_denied, distinguishable from api_failure');
    assert.equal(createCallCount, 0, 'policy_denied: linear_comment — createComment must NOT be called on policy denial');
    assert.equal(registry.size(), 0, 'policy_denied: linear_comment — registry must be untouched on policy denial');
  });

  it('api_failure: createComment throws → external_error, distinct from policy_denied and reuse', async () => {
    const client = makeLinearClient({ failCreate: true });
    const { transcript, stageArtifact } = makeNoopRecorder();
    const deps: LinearToolsDeps = {
      client,
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript,
      stageArtifact,
      sessionId: 'sess-1',
      phase: 'coding',
      clock: () => 1_000,
    };

    const result = await executeLinearComment(
      { issue: 'HOK-1', body: 'API failure body', sessionId: 'sess-1', phase: 'coding' },
      deps,
    );

    assert.equal(result.ok, false, 'api_failure: linear_comment — must fail when API throws');
    if (result.ok) return;
    assert.equal(result.error, 'external_error', 'api_failure: linear_comment — error must be external_error, not policy_denied');
    assert.notEqual(result.error, 'policy_denied', 'api_failure: linear_comment — must not be confused with policy_denied diagnostic class');
    assert.ok(result.message.length > 0, 'api_failure: linear_comment — message must be non-empty for diagnostics');
  });
});

// ---------------------------------------------------------------------------
// write_stage_result — idempotent_reuse + api_failure
// (write_stage_result is Wavemill-owned, allowed in all phases — no policy_denied path)
// ---------------------------------------------------------------------------

describe('retry-idempotency: write_stage_result', () => {
  it('idempotent_reuse: second call with same args → reused, registry has 1 entry (no duplicate)', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'retry-stage-'));
    tempDirs.push(featureDir);
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const deps = makeCommandDeps({ registry });
    const params = {
      featureDir,
      issueId: 'HOK-1',
      stage: 'coding',
      status: 'completed' as const,
      notes: 'All checks passed',
      artifacts: { type: 'coding' },
    };

    const r1 = await executeWriteStageResult(params, deps);
    const r2 = await executeWriteStageResult(params, deps);

    assert.equal(r1.ok, true, 'idempotent_reuse: write_stage_result — first call must succeed');
    assert.equal(r2.ok, true, 'idempotent_reuse: write_stage_result — second call must succeed');
    if (r1.ok) {
      assert.equal(r1.idempotency.outcome, 'created', 'idempotent_reuse: write_stage_result — first call outcome must be created');
    }
    if (r2.ok) {
      assert.equal(r2.idempotency.outcome, 'reused', 'idempotent_reuse: write_stage_result — second call outcome must be reused');
    }
    assert.equal(registry.size(), 1, 'idempotent_reuse: write_stage_result — registry must have exactly 1 entry (no duplicate)');
  });

  it('idempotent_reuse: failed write does not pollute registry — retry becomes created', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'retry-stage-'));
    tempDirs.push(featureDir);
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    let attempts = 0;
    const deps = makeCommandDeps({
      registry,
      writeStageResultImpl: async (dir, result) => {
        attempts++;
        if (attempts === 1) throw new Error('transient fs error');
        writeFileSync(join(dir, `.${result.stage}-result.json`), `${JSON.stringify(result, null, 2)}\n`);
      },
    });
    const params = {
      featureDir,
      issueId: 'HOK-1',
      stage: 'coding',
      status: 'completed' as const,
      notes: 'Recovery test',
      artifacts: { type: 'coding' },
    };

    const first = await executeWriteStageResult(params, deps);
    const second = await executeWriteStageResult(params, deps);

    assert.equal(first.ok, false, 'idempotent_reuse: write_stage_result — first call must fail (transient)');
    assert.equal(second.ok, true, 'idempotent_reuse: write_stage_result — retry must succeed');
    if (second.ok) {
      assert.equal(second.idempotency.outcome, 'created', 'idempotent_reuse: write_stage_result — retry outcome must be created (registry not polluted by failure)');
    }
    assert.equal(registry.size(), 1, 'idempotent_reuse: write_stage_result — registry must have exactly 1 entry after successful retry');
  });

  it('api_failure: writer throws → io_error, distinct from policy_denied', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'retry-stage-'));
    tempDirs.push(featureDir);
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const deps = makeCommandDeps({
      registry,
      writeStageResultImpl: async () => { throw new Error('disk full'); },
    });
    const params = {
      featureDir,
      issueId: 'HOK-1',
      stage: 'coding',
      status: 'completed' as const,
      notes: 'Failure test',
      artifacts: { type: 'coding' },
    };

    const result = await executeWriteStageResult(params, deps);

    assert.equal(result.ok, false, 'api_failure: write_stage_result — must fail when writer throws');
    if (result.ok) return;
    assert.equal(result.error, 'io_error', 'api_failure: write_stage_result — error must be io_error, not policy_denied');
    assert.notEqual(result.error, 'policy_denied', 'api_failure: write_stage_result — must not be confused with policy_denied diagnostic class');
    assert.equal(registry.size(), 0, 'api_failure: write_stage_result — registry must not be polluted on write failure');
  });

  it('write_stage_result is allowed in all phases — no policy_denied path exists (structural assertion)', () => {
    // write_stage_result is a Wavemill-owned artifact write, not an external provider mutation.
    // This test documents that policy_denied is not a valid diagnostic class for this tool:
    // the diagnostic surface is created/reused vs io_error only.
    for (const phase of ['planning', 'coding', 'review', 'ready'] as const) {
      const policy = isMutationAllowed(phase, 'write_stage_result', 'write_stage_result');
      assert.equal(policy.allowed, true, `api_failure: write_stage_result — must be allowed in ${phase} phase (no policy_denied path exists for this tool)`);
    }
  });
});
