/**
 * Integration test: review-phase sequence end-to-end (HOK-2362).
 *
 * Drives the review flow via runReviewFlow() using fixture-backed mocks
 * (createGitHubMock from fixtures/github-mock.ts). Focuses on integration-level
 * assertions not already covered by unit tests:
 *
 *   - isMutationAllowed('review', *, 'merge') is always false (policy invariant).
 *   - The flow halts before merge: result.haltedBeforeMerge is always true.
 *   - A terminal stage result is written to disk.
 *   - needsStrongerReviewer short-circuits before any PR mutation.
 *   - Call counts prove "exactly once" external creation.
 *
 * Does NOT re-test per-tool unit assertions already in github.test.ts,
 * linear-tools.test.ts, or command-tools.test.ts.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { WORKFLOW_TOOL_NAMES } from './contracts.ts';
import { createInMemoryDedupeRegistry } from './dedupe.ts';
import { createGitHubMock, loadGitHubFixture } from './fixtures/github-mock.ts';
import type { GitHubToolPullRequest } from './github.ts';
import type {
  LinearClient,
  WorkflowToolStageArtifactEntry,
  WorkflowToolTranscriptEvent,
} from './linear-tools.ts';
import { isMutationAllowed } from './mutation-policy.ts';
import { runReviewFlow } from './review-flow.ts';
import type { ReviewResult } from '../../review-engine.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLinearClient(opts: {
  comments: Array<{ id: string; body: string; issueId: string; url: string }>;
  calls: { create: number; update: number };
  failComment?: boolean;
}): LinearClient {
  return {
    async getIssue(identifier) {
      return {
        id: `linear-${identifier}`,
        identifier,
        title: `Issue ${identifier}`,
        url: `https://linear.app/acme/issue/${identifier}`,
      };
    },
    async createComment(issueId, body) {
      opts.calls.create += 1;
      if (opts.failComment) throw new Error('Linear comment API error');
      const comment = {
        id: `comment-${opts.comments.length + 1}`,
        issueId,
        body,
        url: `https://linear.app/acme/comment/${opts.comments.length + 1}`,
      };
      opts.comments.push(comment);
      return { id: comment.id, url: comment.url };
    },
    async updateComment(_commentId, _body) {
      opts.calls.update += 1;
      return { id: 'unused', url: 'https://linear.app/acme/comment/unused' };
    },
  };
}

function makeRecorder() {
  const transcriptEvents: WorkflowToolTranscriptEvent[] = [];
  const stageArtifactEntries: WorkflowToolStageArtifactEntry[] = [];
  return {
    transcript: {
      append(event: WorkflowToolTranscriptEvent) {
        transcriptEvents.push(event);
      },
    },
    stageArtifact: {
      append(entry: WorkflowToolStageArtifactEntry) {
        stageArtifactEntries.push(entry);
      },
    },
    transcriptEvents,
    stageArtifactEntries,
  };
}

function makeReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: 'not_ready',
    codeReviewFindings: [
      {
        severity: 'blocker',
        location: 'src/app.ts:10',
        category: 'correctness',
        description: 'Guard against null.',
      },
    ],
    ...overrides,
  };
}

function assertNoMergeInTranscript(events: WorkflowToolTranscriptEvent[]): void {
  for (const event of events) {
    assert.ok(
      !/merge/i.test(event.tool),
      `transcript contains merge tool "${event.tool}"`,
    );
    assert.ok(
      event.action !== 'merge' && !/^merge_pr$/i.test(event.action),
      `transcript contains merge action "${event.action}" in tool "${event.tool}"`,
    );
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Phase 2 — Policy invariant
// ---------------------------------------------------------------------------

describe('review-flow integration: merge policy invariant', () => {
  it('isMutationAllowed("review", *, "merge") is always false for all tools', () => {
    for (const tool of WORKFLOW_TOOL_NAMES) {
      const result = isMutationAllowed('review', tool, 'merge');
      assert.equal(
        result.allowed,
        false,
        `merge must be denied for review phase, tool=${tool}`,
      );
      assert.equal(
        result.code,
        'review_cannot_merge',
        `denial code must be review_cannot_merge for tool=${tool}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — End-to-end review flow (happy path)
// ---------------------------------------------------------------------------

describe('review-flow integration: end-to-end with fixture-backed mocks', () => {
  it('drives review through PR creation and records a terminal stage result', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-int-'));
    tempDirs.push(featureDir);

    const linearCalls = { create: 0, update: 0 };
    const linearComments: Array<{ id: string; body: string; issueId: string; url: string }> = [];
    const linearClient = makeLinearClient({ comments: linearComments, calls: linearCalls });

    const { deps: githubDeps, state: ghState } = createGitHubMock();
    const recorder = makeRecorder();
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });

    const result = await runReviewFlow({
      issueId: 'HOK-2362',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/retry-tests',
      headSha: 'abc123',
      title: 'Add retry tests',
      body: 'Fixture-backed retry and integration tests.',
      labels: ['needs-review'],
      sessionId: 'sess-int-1',
      registry,
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient,
      githubDeps,
      reviewChangesImpl: async () => makeReview(),
    });

    // Result must indicate halted before merge, never merged
    assert.equal(result.ok, true);
    assert.equal(result.haltedBeforeMerge, true);
    assert.equal(result.merged, false);

    // Terminal stage result must be written
    assert.equal(result.stageResult?.ok, true);
    const stageFile = path.join(featureDir, '.review-result.json');
    const stored = JSON.parse(readFileSync(stageFile, 'utf8')) as { status: string };
    assert.equal(stored.status, 'completed');

    // PR was created exactly once
    assert.equal(ghState.calls.createPullRequest, 1);
    assert.equal(result.pullRequest?.ok, true);
    if (result.pullRequest?.ok) {
      assert.equal(result.pullRequest.idempotency.outcome, 'created');
    }

    // Label added exactly once
    assert.equal(ghState.calls.addLabel, 1);

    // Linear comment created exactly once
    assert.equal(linearCalls.create, 1);

    // No merge anywhere in the transcript
    assertNoMergeInTranscript(recorder.transcriptEvents);
  });

  it('uses fixture-based pr-existing.json to verify reuse on second run', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-int-'));
    tempDirs.push(featureDir);

    const prFixture = loadGitHubFixture<GitHubToolPullRequest>('pr-existing');

    const linearCalls = { create: 0, update: 0 };
    const linearComments: Array<{ id: string; body: string; issueId: string; url: string }> = [];
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const recorder = makeRecorder();

    const { deps: githubDeps, state: ghState } = createGitHubMock({
      pullRequests: [{
        ...prFixture,
        head: 'task/retry-tests',
        base: 'auto/integration',
        url: 'https://github.com/acme/widgets/pull/42',
      }],
      labelTargets: [{
        repo: 'acme/widgets',
        targetKind: 'pull_request',
        targetNumber: 42,
        labels: [],
        url: 'https://github.com/acme/widgets/pull/42',
      }],
    });

    const sharedOptions = {
      issueId: 'HOK-2362',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/retry-tests',
      headSha: 'abc123',
      labels: ['needs-review'],
      sessionId: 'sess-int-1',
      registry,
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000 as number,
      linearClient: makeLinearClient({ comments: linearComments, calls: linearCalls }),
      githubDeps,
      reviewChangesImpl: async () => makeReview(),
    };

    // First run: PR has different title/body so it will be updated
    await runReviewFlow({
      ...sharedOptions,
      title: 'Add retry tests',
      body: 'Fixture-backed retry and integration tests.',
    });

    // Second run with same title/body (after first run updated PR): no second create/update
    const second = await runReviewFlow({
      ...sharedOptions,
      title: 'Add retry tests',
      body: 'Fixture-backed retry and integration tests.',
    });

    assert.equal(second.ok, true);
    // PR was never created fresh (it existed from the fixture)
    assert.equal(ghState.calls.createPullRequest, 0);
    // After first run updated PR, second run sees matching title/body and reuses
    assert.equal(second.pullRequest?.ok, true);
    if (second.pullRequest?.ok) {
      assert.equal(second.pullRequest.idempotency.outcome, 'reused');
    }
    assertNoMergeInTranscript(recorder.transcriptEvents);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — needsStrongerReviewer short-circuit (PR create spy = 0)
// ---------------------------------------------------------------------------

describe('review-flow integration: needsStrongerReviewer short-circuit', () => {
  it('no PR mutation when a stronger reviewer is requested', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-int-'));
    tempDirs.push(featureDir);

    const linearCalls = { create: 0, update: 0 };
    const { deps: githubDeps, state: ghState } = createGitHubMock();
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      issueId: 'HOK-2362',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/retry-tests',
      headSha: 'abc123',
      title: 'Add retry tests',
      body: 'Needs stronger reviewer test.',
      sessionId: 'sess-int-2',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: makeLinearClient({
        comments: [],
        calls: linearCalls,
      }),
      githubDeps,
      reviewChangesImpl: async () =>
        makeReview({ needsStrongerReviewer: true, strongerReviewerReason: 'Human review required' }),
    });

    // Flow must halt without any PR mutation
    assert.equal(result.ok, true);
    assert.equal(result.review.needsStrongerReviewer, true);
    assert.equal(result.pullRequest, undefined, 'pullRequest must be undefined when stronger reviewer needed');
    assert.equal(result.labels.length, 0, 'no labels should be applied');
    assert.equal(result.haltedBeforeMerge, true);
    assert.equal(result.merged, false);

    // Verify zero external calls for PR/label creation
    assert.equal(ghState.calls.createPullRequest, 0, 'createPullRequest must not be called');
    assert.equal(ghState.calls.addLabel, 0, 'addLabel must not be called');
    assert.equal(linearCalls.create, 0, 'linear createComment must not be called');

    // Terminal stage result still written
    assert.equal(result.stageResult?.ok, true);

    // Diagnostics: review.needsStrongerReviewer is the distinguishing field
    assert.equal(result.review.needsStrongerReviewer, true);

    assertNoMergeInTranscript(recorder.transcriptEvents);
  });

  it('terminal stage result notes distinguish stronger-reviewer halt from normal completion', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-int-'));
    tempDirs.push(featureDir);

    const { deps: githubDeps } = createGitHubMock();
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      issueId: 'HOK-2362',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/retry-tests',
      headSha: 'abc123',
      title: 'Add retry tests',
      body: 'Stronger reviewer test.',
      sessionId: 'sess-int-3',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: makeLinearClient({ comments: [], calls: { create: 0, update: 0 } }),
      githubDeps,
      reviewChangesImpl: async () => makeReview({ needsStrongerReviewer: true }),
    });

    assert.equal(result.stageResult?.ok, true);
    const stageFile = path.join(featureDir, '.review-result.json');
    const stored = JSON.parse(readFileSync(stageFile, 'utf8')) as {
      status: string;
      notes: string;
    };
    // Stage result is completed (not failed) even with stronger reviewer
    assert.equal(stored.status, 'completed');
    // Notes must mention stronger reviewer to distinguish from normal completion
    assert.match(stored.notes, /stronger reviewer/i);
  });
});
