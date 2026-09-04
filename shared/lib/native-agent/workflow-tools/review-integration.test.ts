/**
 * Review-phase integration test — stops before merge (HOK-2362_c, deliverable #2).
 *
 * Drives runReviewFlow end-to-end using:
 *   - fixture-backed GitHub deps (createFixtureBackedGithubDeps from Phase 1)
 *   - fixture-backed Linear client
 *   - in-memory write_stage_result sink
 *
 * Asserts the full sequence executes (review → fixes → linear comment →
 * PR create → label → stage result) and that the merge boundary holds across
 * the combined transcript + stage artifacts on every path.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import type { ReviewResult } from '../../review-engine.ts';
import { createInMemoryDedupeRegistry } from './dedupe.ts';
import { isMutationAllowed } from './mutation-policy.ts';
import { createFixtureBackedGithubDeps } from './fixtures/github-mock.ts';
import type { NetworkPolicy } from '../network-policy.ts';
import type {
  LinearClient,
  WorkflowToolStageArtifactEntry,
  WorkflowToolTranscriptEvent,
} from './linear-tools.ts';
import { runReviewFlow } from './review-flow.ts';
import type { BranchPublicationExecutor } from '../../branch-publication.ts';

// Fixture dirs are not git repos, so the publication preflight is stubbed;
// the real helper is covered by branch-publication.test.ts.
const stubPublishBranch: BranchPublicationExecutor = async ({ branch, reviewedSha }) => ({
  ok: true,
  outcome: 'pushed',
  remote: 'origin',
  branch,
  localSha: reviewedSha,
  remoteSha: reviewedSha,
});

// ---------------------------------------------------------------------------
// Merge boundary guard
// ---------------------------------------------------------------------------

const MERGE_TOOL_PATTERNS = [/merge/i, /^github_merge/i];
const MERGE_ACTION_PATTERNS = [/merge/i, /^merge_pr$/i, /^enable_auto_merge$/i];

function assertNoMergeOperations(
  transcriptEvents: WorkflowToolTranscriptEvent[],
  stageArtifactEntries: WorkflowToolStageArtifactEntry[],
): void {
  for (const event of transcriptEvents) {
    for (const pattern of MERGE_TOOL_PATTERNS) {
      assert.ok(
        !pattern.test(event.tool),
        `merge_boundary: transcript recorded merge tool "${event.tool}"; flow must halt before merge`,
      );
    }
    for (const pattern of MERGE_ACTION_PATTERNS) {
      assert.ok(
        !pattern.test(event.action),
        `merge_boundary: transcript recorded merge action "${event.action}"; flow must halt before merge`,
      );
    }
  }
  for (const entry of stageArtifactEntries) {
    for (const pattern of MERGE_TOOL_PATTERNS) {
      assert.ok(
        !pattern.test(entry.tool),
        `merge_boundary: stage artifact recorded merge tool "${entry.tool}"; flow must halt before merge`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLinearClient(opts: { failComment?: boolean } = {}): LinearClient & {
  createCallCount: number;
  updateCallCount: number;
} {
  let createCallCount = 0;
  let updateCallCount = 0;
  return {
    get createCallCount() { return createCallCount; },
    get updateCallCount() { return updateCallCount; },
    async getIssue(identifier: string) {
      return {
        id: `linear-${identifier}`,
        identifier,
        title: `Issue ${identifier}`,
        url: `https://linear.app/acme/issue/${identifier}`,
      };
    },
    async createComment(_issueId: string, _body: string) {
      createCallCount++;
      if (opts.failComment) throw new Error('Linear API error');
      return { id: 'comment-1', url: 'https://linear.app/acme/comment/1' };
    },
    async updateComment(_commentId: string, _body: string) {
      updateCallCount++;
      return { id: 'comment-1', url: 'https://linear.app/acme/comment/1' };
    },
  };
}

function makeRecorder(): {
  transcript: { append(event: WorkflowToolTranscriptEvent): void };
  stageArtifact: { append(entry: WorkflowToolStageArtifactEntry): void };
  transcriptEvents: WorkflowToolTranscriptEvent[];
  stageArtifactEntries: WorkflowToolStageArtifactEntry[];
} {
  const transcriptEvents: WorkflowToolTranscriptEvent[] = [];
  const stageArtifactEntries: WorkflowToolStageArtifactEntry[] = [];
  return {
    transcript: { append(event) { transcriptEvents.push(event); } },
    stageArtifact: { append(entry) { stageArtifactEntries.push(entry); } },
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
        location: 'src/api.ts:22',
        category: 'correctness',
        description: 'Missing null check on user response.',
      },
      {
        severity: 'warning',
        location: 'src/api.ts:45',
        category: 'maintainability',
        description: 'Consider extracting the validation helper.',
      },
    ],
    needsStrongerReviewer: false,
    ...overrides,
  };
}

const ALLOW_REVIEW_INTEGRATION_NETWORK_POLICY: NetworkPolicy = {
  review: {
    review_changes: { kind: 'allow' },
    linear_comment: { kind: 'allowlist', hosts: ['api.linear.app'] },
  },
};

let tempDirs: string[] = [];

beforeEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('review-integration: fixture-backed full sequence + merge boundary', () => {
  it('drives the full sequence and halts before merge (fixture-backed GitHub + Linear deps)', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-integration-'));
    tempDirs.push(featureDir);

    const { deps: githubDeps, state: githubState } = createFixtureBackedGithubDeps({
      retryDelayMs: 1,
    });
    const linearClient = makeLinearClient();
    const recorder = makeRecorder();
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });

    const result = await runReviewFlow({
      issueId: 'HOK-2362',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-integration',
      headSha: 'def456',
      title: 'Review integration test PR',
      body: 'Integration test PR body.',
      labels: ['needs-review', 'native-review'],
      sessionId: 'sess-integration-1',
      phase: 'review',
      registry,
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient,
      githubDeps,
      networkPolicy: ALLOW_REVIEW_INTEGRATION_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => makeReview(),
    });

    // Merge boundary: must always be true/false
    assert.equal(result.haltedBeforeMerge, true, 'merge_boundary: haltedBeforeMerge must be true');
    assert.equal(result.merged, false, 'merge_boundary: merged must be false');

    // Full sequence ran
    assert.equal(result.ok, true, 'integration: flow must complete successfully');
    assert.ok(result.linearComment?.ok, 'integration: linear comment must succeed');
    assert.ok(result.pullRequest?.ok, 'integration: PR creation must succeed');
    if (result.pullRequest?.ok) {
      assert.equal(result.pullRequest.idempotency.outcome, 'created', 'integration: PR outcome must be created');
    }
    assert.equal(result.labels.length, 2, 'integration: both labels must be processed');
    assert.ok(result.labels.every((l) => l.ok), 'integration: all labels must succeed');
    assert.ok(result.stageResult?.ok, 'integration: stage result must be written');

    // No merge operations anywhere in combined transcript + stage artifacts
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);

    // Policy invariant: merge remains denied in review phase
    const mergePolicy = isMutationAllowed('review', 'github_create_pr', 'merge');
    assert.equal(mergePolicy.allowed, false, 'policy_denied: merge must be denied in review phase');

    // Fixture-backed state shows no duplicates
    assert.equal(githubState.calls.createPullRequest, 1, 'idempotent_reuse: createPullRequest must be called exactly once');
    assert.equal(githubState.calls.addLabel, 2, 'idempotent_reuse: addLabel must be called once per label');
    assert.equal(githubState.pullRequests.length, 1, 'idempotent_reuse: exactly one PR must exist');

    // Linear comment made exactly once
    assert.equal(linearClient.createCallCount, 1, 'idempotent_reuse: createComment must be called exactly once');

    // All expected tools appear in the transcript
    const toolNames = recorder.transcriptEvents.map((e) => e.tool);
    assert.ok(toolNames.includes('review_changes'), 'integration: transcript must include review_changes');
    assert.ok(toolNames.includes('linear_comment'), 'integration: transcript must include linear_comment');
    assert.ok(toolNames.includes('github_create_pr'), 'integration: transcript must include github_create_pr');
    assert.ok(toolNames.includes('github_add_label'), 'integration: transcript must include github_add_label');
    assert.ok(toolNames.includes('write_stage_result'), 'integration: transcript must include write_stage_result');
  });

  it('rerun produces reused/updated outcomes without creating new external objects', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-integration-'));
    tempDirs.push(featureDir);

    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const linearClient = makeLinearClient();
    const recorder = makeRecorder();
    const { deps: githubDeps, state: githubState } = createFixtureBackedGithubDeps({
      retryDelayMs: 1,
    });

    const commonOptions = {
      issueId: 'HOK-2362',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-integration',
      headSha: 'def456',
      title: 'Review integration test PR',
      body: 'Integration test PR body.',
      labels: ['needs-review'],
      sessionId: 'sess-integration-1',
      phase: 'review' as const,
      registry,
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: (): number => 1_000,
      linearClient,
      githubDeps,
      networkPolicy: ALLOW_REVIEW_INTEGRATION_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => makeReview(),
    };

    const first = await runReviewFlow(commonOptions);
    assert.equal(first.ok, true, 'integration: first run must succeed');
    assert.equal(first.haltedBeforeMerge, true, 'merge_boundary: first run must halt before merge');
    assert.equal(first.merged, false, 'merge_boundary: first run merged must be false');
    if (first.pullRequest?.ok) {
      assert.equal(first.pullRequest.idempotency.outcome, 'created', 'idempotent_reuse: first PR outcome must be created');
    }

    const second = await runReviewFlow(commonOptions);
    assert.equal(second.ok, true, 'idempotent_reuse: second run must succeed');
    assert.equal(second.haltedBeforeMerge, true, 'merge_boundary: second run must halt before merge');
    assert.equal(second.merged, false, 'merge_boundary: second run merged must be false');
    if (second.pullRequest?.ok) {
      assert.equal(second.pullRequest.idempotency.outcome, 'reused', 'idempotent_reuse: PR outcome must be reused on second run');
    }
    if (second.labels[0]?.ok) {
      assert.equal(second.labels[0].idempotency.outcome, 'skipped', 'idempotent_reuse: label must be skipped on second run');
    }
    if (second.linearComment?.ok) {
      assert.equal(second.linearComment.idempotency.outcome, 'reused', 'idempotent_reuse: comment must be reused on second run');
    }
    if (second.stageResult?.ok) {
      assert.equal(second.stageResult.idempotency.outcome, 'updated', 'idempotent_reuse: stage result must be updated (status may differ)');
    }

    // No new PRs created on second run
    assert.equal(githubState.calls.createPullRequest, 1, 'idempotent_reuse: createPullRequest called once across both runs');
    assert.equal(githubState.pullRequests.length, 1, 'idempotent_reuse: exactly one PR exists after two runs');

    // Stage file reflects the reused PR state
    const stageFile = path.join(featureDir, '.review-result.json');
    const stored = JSON.parse(readFileSync(stageFile, 'utf8')) as {
      artifacts: { pullRequest: { idempotency: { outcome: string } } };
    };
    assert.equal(stored.artifacts.pullRequest.idempotency.outcome, 'reused', 'idempotent_reuse: stage file must record reused outcome');

    // Merge boundary holds across both runs
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);
  });

  it('halts before merge when stronger reviewer needed (no PR or label mutations)', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-integration-'));
    tempDirs.push(featureDir);

    const { deps: githubDeps, state: githubState } = createFixtureBackedGithubDeps();
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      issueId: 'HOK-2362',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-integration',
      headSha: 'def456',
      title: 'Review integration test PR',
      body: 'Integration test PR body.',
      sessionId: 'sess-integration-2',
      phase: 'review',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: makeLinearClient(),
      githubDeps,
      networkPolicy: ALLOW_REVIEW_INTEGRATION_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => makeReview({ needsStrongerReviewer: true }),
    });

    assert.equal(result.ok, true, 'integration: stronger-reviewer path must return ok:true');
    assert.equal(result.review.needsStrongerReviewer, true, 'integration: needsStrongerReviewer must be true');
    assert.equal(result.pullRequest, undefined, 'merge_boundary: no PR must be created when stronger reviewer needed');
    assert.equal(result.haltedBeforeMerge, true, 'merge_boundary: haltedBeforeMerge must be true');
    assert.equal(result.merged, false, 'merge_boundary: merged must be false');
    assert.equal(githubState.calls.createPullRequest, 0, 'merge_boundary: createPullRequest must not be called when stronger reviewer needed');
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);
  });
});
