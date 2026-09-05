import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  deriveFeatureState,
  materializeFeatureState,
  deriveAndMaterialize,
  FEATURE_STATE_SCHEMA_VERSION,
  FEATURE_STATE_FILENAME,
  type DeriveFeatureStateOptions,
} from './feature-state.ts';
import { writeStageResult, type StageResult } from './stage-result.ts';
import { writeRouteArtifact } from './route-artifact.ts';

// ────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'feature-state-test-'));
}

function cleanup(dirs: string[]): void {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
}

function writePlanningResult(featureDir: string, overrides: Partial<StageResult> = {}): void {
  writeFileSync(
    join(featureDir, '.planning-result.json'),
    JSON.stringify({
      stage: 'planning',
      status: 'completed',
      startedAt: '2026-06-01T10:00:00.000Z',
      finishedAt: '2026-06-01T10:05:00.000Z',
      agent: 'claude',
      model: 'claude-opus-4-6',
      notes: 'Plan created',
      artifacts: { type: 'planning', planFile: 'features/slug/plan.md' },
      ...overrides,
    } satisfies StageResult),
    'utf-8',
  );
}

function writeCodingResult(featureDir: string, overrides: Partial<StageResult> = {}): void {
  writeFileSync(
    join(featureDir, '.coding-result.json'),
    JSON.stringify({
      stage: 'coding',
      status: 'completed',
      startedAt: '2026-06-01T10:05:00.000Z',
      finishedAt: '2026-06-01T10:30:00.000Z',
      agent: 'claude',
      model: 'claude-opus-4-6',
      notes: 'Implementation complete',
      artifacts: { type: 'coding', filesChanged: 3, linesAdded: 120, linesRemoved: 10, commitCount: 2 },
      ...overrides,
    } satisfies StageResult),
    'utf-8',
  );
}

function writeReviewResult(featureDir: string, overrides: Partial<StageResult> = {}): void {
  writeFileSync(
    join(featureDir, '.review-result.json'),
    JSON.stringify({
      stage: 'review',
      status: 'completed',
      startedAt: '2026-06-01T10:30:00.000Z',
      finishedAt: '2026-06-01T10:35:00.000Z',
      agent: 'claude',
      model: 'claude-opus-4-6',
      notes: 'Review passed',
      artifacts: {
        type: 'review',
        prNumber: 123,
        findingsCount: 2,
        blockingIssues: 0,
        exitCode: 0,
        verdict: 'ready',
        iterations: 1,
        blockerCount: 0,
        warningCount: 2,
      },
      ...overrides,
    } satisfies StageResult),
    'utf-8',
  );
}

function writeReadyResult(featureDir: string, overrides: Partial<StageResult> = {}): void {
  writeFileSync(
    join(featureDir, '.ready-result.json'),
    JSON.stringify({
      stage: 'ready',
      status: 'completed',
      startedAt: '2026-06-01T10:35:00.000Z',
      finishedAt: '2026-06-01T10:36:00.000Z',
      agent: 'wavemill',
      model: '',
      notes: 'Ready checks passed',
      artifacts: {
        type: 'ready',
        verdict: 'pass',
        checksRun: 3,
        checksPassed: 3,
        prNumber: 123,
        queueState: 'ready',
      },
      ...overrides,
    } satisfies StageResult),
    'utf-8',
  );
}

function writeBootstrapRoute(featureDir: string): void {
  writeRouteArtifact(join(featureDir, '.initial-route.json'), {
    coder: 'claude-opus-4-6',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'full',
  });
}

function writeExpandedRoute(featureDir: string): void {
  writeRouteArtifact(join(featureDir, '.post-expansion-route.json'), {
    coder: 'claude-opus-4-6',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'full',
  });
}

// ────────────────────────────────────────────────────────────────
// Test: planning-only
// ────────────────────────────────────────────────────────────────

test('planning-only: derives planning phase from stage result', async () => {
  const featureDir = makeTempDir();
  const dirs = [featureDir];
  try {
    writePlanningResult(featureDir);
    writeFileSync(join(featureDir, 'plan.md'), '# Plan\nHello.', 'utf-8');

    const state = await deriveFeatureState({ featureDir, issueId: 'HOK-1', slug: 'test-slug' });

    assert.equal(state.schemaVersion, FEATURE_STATE_SCHEMA_VERSION);
    assert.equal(state.issueId, 'HOK-1');
    assert.equal(state.slug, 'test-slug');
    assert.equal(state.currentPhase, 'planning');
    assert.equal(state.normalizedState, 'completed');
    assert.ok(state.stages.planning);
    assert.equal(state.stages.planning.status, 'completed');
    assert.equal(state.stages.coding, null);
    assert.equal(state.stages.review, null);
    assert.equal(state.stages.ready, null);
    assert.ok(state.contract?.planFile);
    assert.equal(state.failureReason, null);
    assert.equal(state.blockers.length, 0);
    assert.ok(state.artifactSources.stagesFromWorktree);
    assert.ok(!state.artifactSources.evalRecordUsed);
  } finally {
    cleanup(dirs);
  }
});

test('planning-only: stage duration is computed from timestamps', async () => {
  const featureDir = makeTempDir();
  try {
    writePlanningResult(featureDir);
    const state = await deriveFeatureState({ featureDir });

    assert.ok(state.stages.planning?.durationSeconds);
    assert.equal(state.stages.planning?.durationSeconds, 300); // 5 minutes
  } finally {
    cleanup([featureDir]);
  }
});

// ────────────────────────────────────────────────────────────────
// Test: coding-complete
// ────────────────────────────────────────────────────────────────

test('coding-complete: derives coding phase from stage result', async () => {
  const featureDir = makeTempDir();
  try {
    writePlanningResult(featureDir);
    writeCodingResult(featureDir);
    writeBootstrapRoute(featureDir);
    writeExpandedRoute(featureDir);

    const state = await deriveFeatureState({ featureDir, issueId: 'HOK-2', slug: 'coding-slug' });

    assert.equal(state.currentPhase, 'coding');
    assert.equal(state.normalizedState, 'completed');
    assert.ok(state.stages.coding);
    assert.equal(state.stages.coding.status, 'completed');
    assert.ok(state.stages.coding.artifactSummary);
    assert.equal(state.stages.coding.artifactSummary?.filesChanged, 3);
    assert.ok(state.route);
    assert.ok(state.artifactSources.routeFromWorktree);
  } finally {
    cleanup([featureDir]);
  }
});

test('coding-complete: uses .coding-complete marker when no stage result', async () => {
  const featureDir = makeTempDir();
  try {
    writeFileSync(join(featureDir, '.coding-complete'), '', 'utf-8');

    const state = await deriveFeatureState({ featureDir });

    assert.equal(state.currentPhase, 'coding');
    assert.equal(state.normalizedState, 'completed');
    assert.ok(state.stages.coding);
    assert.equal(state.stages.coding.notes, 'derived from .coding-complete marker');
    const markerEvidence = state.evidence.find((e) => e.label === '.coding-complete');
    assert.ok(markerEvidence);
    assert.equal(markerEvidence.status, 'pass');
  } finally {
    cleanup([featureDir]);
  }
});

test('coding-complete: blocked-completion artifact contributes blocker', async () => {
  const featureDir = makeTempDir();
  try {
    writePlanningResult(featureDir);
    writeCodingResult(featureDir);
    writeFileSync(
      join(featureDir, '.coding-blocked-completion.json'),
      JSON.stringify({
        stage: 'coding',
        implementationComplete: true,
        committed: true,
        commit: 'abc1234',
        passingChecks: ['node --test shared/lib/feature-state.test.ts'],
        blockingChecks: ['npm test'],
        blockingReason: 'baseline_tests_failing',
        evidence: 'Unrelated baseline test failure.',
        recommendedAction: 'advance_to_review',
      }),
      'utf-8',
    );

    const state = await deriveFeatureState({ featureDir });

    const blockerCodes = state.blockers.map((b) => b.code);
    assert.ok(blockerCodes.includes('baseline_tests_failing'), `expected baseline_tests_failing in ${JSON.stringify(blockerCodes)}`);

    const blockedEv = state.evidence.find((e) => e.kind === 'blocked_completion');
    assert.ok(blockedEv);
    assert.ok(blockedEv.detail?.includes('baseline_tests_failing'));
  } finally {
    cleanup([featureDir]);
  }
});

// ────────────────────────────────────────────────────────────────
// Test: ready-failed
// ────────────────────────────────────────────────────────────────

test('ready-failed: derives ready_failed blocker and failure reason', async () => {
  const featureDir = makeTempDir();
  try {
    writePlanningResult(featureDir);
    writeCodingResult(featureDir);
    writeReviewResult(featureDir);
    writeReadyResult(featureDir, {
      status: 'failed',
      notes: 'CI checks failed',
      failureReason: 'ci_checks_failed',
      artifacts: {
        type: 'ready',
        verdict: 'fail',
        checksRun: 3,
        checksPassed: 2,
        prNumber: 123,
      },
    });

    const state = await deriveFeatureState({ featureDir, issueId: 'HOK-3' });

    assert.equal(state.currentPhase, 'ready');
    assert.equal(state.normalizedState, 'failed');
    assert.equal(state.failureReason, 'ready_failed');

    const readyBlocker = state.blockers.find((b) => b.code === 'ready_failed');
    assert.ok(readyBlocker, 'should have ready_failed blocker');

    const readyEvidence = state.evidence.find((e) => e.label === 'ready_verdict');
    assert.ok(readyEvidence);
    assert.equal(readyEvidence.status, 'fail');
  } finally {
    cleanup([featureDir]);
  }
});

test('ready-failed: merge conflict is captured as blocker', async () => {
  const featureDir = makeTempDir();
  try {
    writePlanningResult(featureDir);
    writeCodingResult(featureDir);
    writeReadyResult(featureDir, {
      status: 'failed',
      notes: 'Merge conflict',
      artifacts: {
        type: 'ready',
        verdict: 'fail',
        mergeConflict: 'src/foo.ts',
        prNumber: 456,
      },
    });

    const state = await deriveFeatureState({ featureDir });

    const mergeBlocker = state.blockers.find((b) => b.code === 'merge_conflict');
    assert.ok(mergeBlocker, 'should have merge_conflict blocker');
    assert.equal(mergeBlocker.detail, 'src/foo.ts');
  } finally {
    cleanup([featureDir]);
  }
});

// ────────────────────────────────────────────────────────────────
// Test: merged/evaled with eval record
// ────────────────────────────────────────────────────────────────

test('merged/evaled: eval record fields populate outcome', async () => {
  const featureDir = makeTempDir();
  try {
    writePlanningResult(featureDir);
    writeCodingResult(featureDir);
    writeReviewResult(featureDir);
    writeReadyResult(featureDir);

    const evalRecord: DeriveFeatureStateOptions['evalRecord'] = {
      score: 0.87,
      interventionRequired: false,
      interventionCount: 0,
      workflowCost: 1.23,
      timeSeconds: 3600,
      outcomes: { delivery: { merged: true } },
      prUrl: 'https://github.com/acme/repo/pull/123',
    };

    const state = await deriveFeatureState({ featureDir, issueId: 'HOK-4', evalRecord });

    assert.equal(state.currentPhase, 'done');
    assert.equal(state.outcome.completed, true);
    assert.equal(state.outcome.merged, true);
    assert.equal(state.outcome.evalScore, 0.87);
    assert.equal(state.outcome.costUsd, 1.23);
    assert.equal(state.outcome.durationSeconds, 3600);
    assert.equal(state.outcome.manualIntervention, false);
    assert.equal(state.outcome.interventionCount, 0);
    assert.equal(state.prUrl, 'https://github.com/acme/repo/pull/123');
    assert.ok(state.artifactSources.evalRecordUsed);

    const evalEv = state.evidence.find((e) => e.kind === 'eval_outcome' && e.label === 'eval_score');
    assert.ok(evalEv);
    assert.equal(evalEv.status, 'pass');
  } finally {
    cleanup([featureDir]);
  }
});

test('merged/evaled: archive-only artifacts work when featureDir is absent', async () => {
  const archiveDir = makeTempDir();
  try {
    // Write stage results in archive dir with archive-style names
    writeFileSync(
      join(archiveDir, '.planning-result.json'),
      JSON.stringify({
        stage: 'planning',
        status: 'completed',
        startedAt: '2026-06-01T10:00:00.000Z',
        finishedAt: '2026-06-01T10:05:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'Archived planning result',
        artifacts: { type: 'planning' },
      } satisfies StageResult),
      'utf-8',
    );
    writeFileSync(
      join(archiveDir, '.coding-result.json'),
      JSON.stringify({
        stage: 'coding',
        status: 'completed',
        startedAt: '2026-06-01T10:05:00.000Z',
        finishedAt: '2026-06-01T11:05:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'Archived coding result',
        artifacts: { type: 'coding', filesChanged: 5 },
      } satisfies StageResult),
      'utf-8',
    );
    writeFileSync(join(archiveDir, 'plan.md'), '# Archived Plan', 'utf-8');

    const evalRecord: DeriveFeatureStateOptions['evalRecord'] = {
      score: 0.75,
      interventionRequired: true,
      interventionCount: 2,
      workflowCost: 0.55,
      timeSeconds: 4200,
      outcomes: { delivery: { merged: true } },
    };

    const state = await deriveFeatureState({
      featureDir: '/nonexistent/path/to/feature',
      archiveDir,
      issueId: 'HOK-5',
      evalRecord,
    });

    assert.equal(state.artifactSources.stagesFromArchive, true);
    assert.equal(state.artifactSources.stagesFromWorktree, false);
    assert.ok(state.stages.planning);
    assert.ok(state.stages.coding);
    assert.equal(state.outcome.merged, true);
    assert.equal(state.outcome.evalScore, 0.75);
    assert.equal(state.outcome.interventionCount, 2);
    assert.ok(state.contract?.planFile);
  } finally {
    cleanup([archiveDir]);
  }
});

// ────────────────────────────────────────────────────────────────
// Test: legacy-marker-only
// ────────────────────────────────────────────────────────────────

test('legacy-marker-only: no stage results, only .coding-complete marker', async () => {
  const featureDir = makeTempDir();
  try {
    writeFileSync(join(featureDir, '.coding-complete'), '', 'utf-8');
    writeFileSync(join(featureDir, '.plan-approved'), '', 'utf-8');

    const state = await deriveFeatureState({ featureDir, issueId: 'HOK-6', slug: 'legacy-slug' });

    assert.equal(state.artifactSources.stagesFromWorktree, false);
    assert.equal(state.stages.planning?.notes, 'derived from .plan-approved marker');
    assert.equal(state.stages.coding?.notes, 'derived from .coding-complete marker');
    assert.equal(state.stages.review, null);
    assert.equal(state.currentPhase, 'coding');
    assert.equal(state.normalizedState, 'completed');
    assert.equal(state.failureReason, null);

    const planEv = state.evidence.find((e) => e.label === '.plan-approved');
    const codingEv = state.evidence.find((e) => e.label === '.coding-complete');
    assert.ok(planEv, 'should have .plan-approved evidence');
    assert.ok(codingEv, 'should have .coding-complete evidence');
    assert.equal(planEv.status, 'pass');
    assert.equal(codingEv.status, 'pass');
  } finally {
    cleanup([featureDir]);
  }
});

test('legacy-marker-only: aborted marker sets aborted phase and failure reason', async () => {
  const featureDir = makeTempDir();
  try {
    writeFileSync(join(featureDir, '.workflow-aborted'), '', 'utf-8');

    const state = await deriveFeatureState({ featureDir });

    assert.equal(state.currentPhase, 'aborted');
    assert.equal(state.normalizedState, 'aborted');
    assert.equal(state.failureReason, 'workflow_aborted');
    assert.ok(state.blockers.some((b) => b.code === 'workflow_aborted'));
    const ev = state.evidence.find((e) => e.label === '.workflow-aborted');
    assert.ok(ev);
    assert.equal(ev.status, 'fail');
  } finally {
    cleanup([featureDir]);
  }
});

// ────────────────────────────────────────────────────────────────
// Test: missing/malformed artifacts degrade gracefully
// ────────────────────────────────────────────────────────────────

test('missing featureDir and archive: returns unknown phase with null fields', async () => {
  const state = await deriveFeatureState({
    issueId: 'HOK-7',
    slug: 'no-artifact-slug',
    featureDir: '/nonexistent/dir',
  });

  assert.equal(state.currentPhase, 'unknown');
  assert.equal(state.normalizedState, 'unknown');
  assert.equal(state.stages.planning, null);
  assert.equal(state.stages.coding, null);
  assert.equal(state.stages.review, null);
  assert.equal(state.stages.ready, null);
  assert.equal(state.failureReason, null);
  assert.equal(state.route, null);
  assert.equal(state.contract, null);
  assert.equal(state.artifactSources.stagesFromWorktree, false);
  assert.equal(state.artifactSources.stagesFromArchive, false);
});

test('malformed stage result JSON is skipped gracefully', async () => {
  const featureDir = makeTempDir();
  try {
    writeFileSync(join(featureDir, '.planning-result.json'), '{not json}', 'utf-8');
    writeCodingResult(featureDir);

    const state = await deriveFeatureState({ featureDir });

    // Malformed planning result should be null; valid coding result should be present
    assert.equal(state.stages.planning, null);
    assert.ok(state.stages.coding);
  } finally {
    cleanup([featureDir]);
  }
});

test('malformed blocked-completion JSON is skipped gracefully', async () => {
  const featureDir = makeTempDir();
  try {
    writeCodingResult(featureDir);
    writeFileSync(join(featureDir, '.coding-blocked-completion.json'), '{bad json}', 'utf-8');

    const state = await deriveFeatureState({ featureDir });

    assert.ok(state.stages.coding, 'coding result should still be present');
    const blockerCodes = state.blockers.map((b) => b.code);
    assert.ok(!blockerCodes.includes('baseline_tests_failing'), 'no blocked-completion blocker from malformed file');
  } finally {
    cleanup([featureDir]);
  }
});

// ────────────────────────────────────────────────────────────────
// Test: materializeFeatureState
// ────────────────────────────────────────────────────────────────

test('materializeFeatureState writes valid JSON to target path', async () => {
  const featureDir = makeTempDir();
  const outputDir = makeTempDir();
  const dirs = [featureDir, outputDir];
  try {
    writePlanningResult(featureDir);
    writeCodingResult(featureDir);

    const state = await deriveFeatureState({ featureDir, issueId: 'HOK-8', slug: 'materialize-test' });
    const targetPath = join(outputDir, FEATURE_STATE_FILENAME);
    await materializeFeatureState(state, targetPath);

    assert.ok(existsSync(targetPath), 'feature-state.json should exist');
    const raw = JSON.parse(readFileSync(targetPath, 'utf-8'));
    assert.equal(raw.schemaVersion, FEATURE_STATE_SCHEMA_VERSION);
    assert.equal(raw.issueId, 'HOK-8');
    assert.equal(raw.slug, 'materialize-test');
  } finally {
    cleanup(dirs);
  }
});

test('deriveAndMaterialize writes feature-state.json to featureDir', async () => {
  const featureDir = makeTempDir();
  try {
    writePlanningResult(featureDir);

    const { state, path: outPath } = await deriveAndMaterialize({ featureDir, issueId: 'HOK-9' }, featureDir);

    assert.ok(existsSync(outPath));
    assert.equal(outPath, join(featureDir, FEATURE_STATE_FILENAME));
    assert.equal(state.issueId, 'HOK-9');
  } finally {
    cleanup([featureDir]);
  }
});

// ────────────────────────────────────────────────────────────────
// Test: route provenance
// ────────────────────────────────────────────────────────────────

test('route lifecycle is captured when both bootstrap and expanded routes exist', async () => {
  const featureDir = makeTempDir();
  try {
    writePlanningResult(featureDir);
    writeBootstrapRoute(featureDir);
    writeExpandedRoute(featureDir);

    const state = await deriveFeatureState({ featureDir });

    assert.ok(state.route, 'should have route provenance');
    assert.ok(state.route.bootstrapRoute, 'should have bootstrap route');
    assert.ok(state.route.expandedRoute, 'should have expanded route');
    assert.equal(state.route.bootstrapRoute.coder, 'claude-opus-4-6');
    assert.ok(state.artifactSources.routeFromWorktree);
  } finally {
    cleanup([featureDir]);
  }
});

// ────────────────────────────────────────────────────────────────
// Test: worktree overrides archive
// ────────────────────────────────────────────────────────────────

test('worktree stages take precedence over archive stages', async () => {
  const featureDir = makeTempDir();
  const archiveDir = makeTempDir();
  try {
    // Worktree has completed planning; archive has failed planning
    writePlanningResult(featureDir, { status: 'completed', notes: 'worktree version' });
    writeFileSync(
      join(archiveDir, '.planning-result.json'),
      JSON.stringify({
        stage: 'planning',
        status: 'failed',
        startedAt: '2026-06-01T09:00:00.000Z',
        finishedAt: '2026-06-01T09:01:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'archive version',
      } satisfies StageResult),
      'utf-8',
    );

    const state = await deriveFeatureState({ featureDir, archiveDir });

    assert.equal(state.stages.planning?.notes, 'worktree version');
    assert.equal(state.stages.planning?.status, 'completed');
    assert.ok(state.artifactSources.stagesFromWorktree);
    assert.ok(!state.artifactSources.stagesFromArchive);
  } finally {
    cleanup([featureDir, archiveDir]);
  }
});

// ────────────────────────────────────────────────────────────────
// Test: full happy path (planning → coding → review → ready)
// ────────────────────────────────────────────────────────────────

test('full happy path produces done phase with readyPassed=true', async () => {
  const featureDir = makeTempDir();
  try {
    writePlanningResult(featureDir);
    writeCodingResult(featureDir);
    writeReviewResult(featureDir);
    writeReadyResult(featureDir);
    writeBootstrapRoute(featureDir);

    const state = await deriveFeatureState({
      featureDir,
      issueId: 'HOK-10',
      slug: 'full-happy-path',
      branch: 'task/full-happy-path',
      prNumber: 999,
      prUrl: 'https://github.com/acme/repo/pull/999',
    });

    assert.equal(state.currentPhase, 'done');
    assert.equal(state.normalizedState, 'completed');
    assert.equal(state.prNumber, 999);
    assert.equal(state.prUrl, 'https://github.com/acme/repo/pull/999');
    assert.equal(state.outcome.completed, true);
    assert.equal(state.outcome.readyPassed, true);
    assert.equal(state.outcome.reviewPassed, true);
    assert.equal(state.failureReason, null);
    assert.equal(state.blockers.length, 0);

    // Duration should be sum of planning + coding + review
    // 300 + 1500 + 300 = 2100
    assert.ok(typeof state.outcome.durationSeconds === 'number');
    assert.equal(state.outcome.durationSeconds, 2100);
  } finally {
    cleanup([featureDir]);
  }
});

test('review completion without explicit verdict does not count as reviewPassed', async () => {
  const featureDir = makeTempDir();
  try {
    writeReviewResult(featureDir, {
      artifacts: { type: 'review', prNumber: 123, findingsCount: 0, blockingIssues: 0 },
    });

    const state = await deriveFeatureState({ featureDir, issueId: 'HOK-11', slug: 'legacy-review' });
    const verdict = state.evidence.find((item) => item.kind === 'review_verdict');

    assert.equal(state.outcome.reviewPassed, false);
    assert.equal(verdict?.status, 'fail');
    assert.match(verdict?.detail ?? '', /exitCode=missing|review outcome missing/);
  } finally {
    cleanup([featureDir]);
  }
});

test('review tool error is surfaced as failed review evidence', async () => {
  const featureDir = makeTempDir();
  try {
    writeReviewResult(featureDir, {
      artifacts: {
        type: 'review',
        prNumber: 123,
        exitCode: 2,
        verdict: 'error',
        iterations: 2,
        blockerCount: 0,
        warningCount: 0,
        reviewToolError: 'provider failed',
      },
    });

    const state = await deriveFeatureState({ featureDir, issueId: 'HOK-12', slug: 'error-review' });
    const verdict = state.evidence.find((item) => item.kind === 'review_verdict');

    assert.equal(state.outcome.reviewPassed, false);
    assert.equal(verdict?.status, 'fail');
    assert.match(verdict?.detail ?? '', /exitCode=2/);
    assert.match(verdict?.detail ?? '', /verdict=error/);
  } finally {
    cleanup([featureDir]);
  }
});

test('all-dismissed blockers pass review and surface dismissal counts in evidence (HOK-2932)', async () => {
  const featureDir = makeTempDir();
  try {
    writeReviewResult(featureDir, {
      artifacts: {
        type: 'review',
        prNumber: 1282,
        exitCode: 1,
        verdict: 'not_ready',
        iterations: 2,
        blockerCount: 1,
        warningCount: 0,
        dismissedBlockers: [
          {
            location: 'scope-guard',
            description: 'Diff includes files from already-merged PRs',
            justification: 'False positive: stale diff base; PR diff is in scope.',
            evidence: 'git log auto/integration..HEAD',
          },
        ],
      },
    });

    const state = await deriveFeatureState({ featureDir, issueId: 'HOK-2932', slug: 'dismissed-review' });
    const verdict = state.evidence.find((item) => item.kind === 'review_verdict');

    assert.equal(state.outcome.reviewPassed, true);
    assert.equal(verdict?.status, 'pass');
    assert.match(verdict?.detail ?? '', /blockers=1/);
    assert.match(verdict?.detail ?? '', /dismissedBlockers=1/);
    assert.match(verdict?.detail ?? '', /effectiveBlockers=0/);
  } finally {
    cleanup([featureDir]);
  }
});

test('undismissed blocker still fails review even alongside a valid dismissal', async () => {
  const featureDir = makeTempDir();
  try {
    writeReviewResult(featureDir, {
      artifacts: {
        type: 'review',
        prNumber: 1282,
        exitCode: 1,
        verdict: 'not_ready',
        iterations: 2,
        blockerCount: 2,
        warningCount: 0,
        dismissedBlockers: [
          { justification: 'One finding disproved with a verified repro attempt.' },
        ],
      },
    });

    const state = await deriveFeatureState({ featureDir, issueId: 'HOK-2932', slug: 'mixed-review' });
    const verdict = state.evidence.find((item) => item.kind === 'review_verdict');

    assert.equal(state.outcome.reviewPassed, false);
    assert.equal(verdict?.status, 'fail');
    assert.match(verdict?.detail ?? '', /effectiveBlockers=1/);
  } finally {
    cleanup([featureDir]);
  }
});

test('native agent/model: stage results with native agent round-trip through feature state', async () => {
  const featureDir = makeTempDir();
  try {
    mkdirSync(featureDir, { recursive: true });

    // Write stage results with native agent and model
    writePlanningResult(featureDir, {
      agent: 'native',
      model: 'pi-standard-20260101',
    });

    writeCodingResult(featureDir, {
      agent: 'native',
      model: 'pi-reasoning-20260201',
      status: 'running',
      finishedAt: null,
    });

    const state = await deriveFeatureState({
      featureDir,
      issueId: 'HOK-2310',
      slug: 'native-test',
    });

    // Planning phase should be captured with native agent
    assert.equal(state.stages.planning?.status, 'completed');
    assert.equal(state.stages.planning?.agent, 'native');
    assert.equal(state.stages.planning?.model, 'pi-standard-20260101');

    // Coding phase should be captured with native agent
    assert.equal(state.stages.coding?.status, 'running');
    assert.equal(state.stages.coding?.agent, 'native');
    assert.equal(state.stages.coding?.model, 'pi-reasoning-20260201');

    // Current phase should be coding (running)
    assert.equal(state.currentPhase, 'coding');
    assert.equal(state.normalizedState, 'running');
  } finally {
    cleanup([featureDir]);
  }
});

test('native agent/model: failed status maps to existing failed normalized state without native-specific path', async () => {
  const featureDir = makeTempDir();
  try {
    mkdirSync(featureDir, { recursive: true });

    writePlanningResult(featureDir, {
      agent: 'native',
      model: 'pi-standard-20260101',
      status: 'failed',
      failureReason: 'planner_error',
      notes: 'Native planner failed',
    });

    const state = await deriveFeatureState({
      featureDir,
      issueId: 'HOK-2310',
      slug: 'native-failed',
    });

    // Failed native phase reuses the same normalized state mapping as other agents
    assert.equal(state.currentPhase, 'planning');
    assert.equal(state.normalizedState, 'failed');
    assert.equal(state.stages.planning?.agent, 'native');
    assert.equal(state.stages.planning?.model, 'pi-standard-20260101');
    assert.equal(state.stages.planning?.status, 'failed');
    assert.equal(state.failureReason, 'stage_failed');
    assert.ok(state.blockers.some((b) => b.code === 'stage_failed' && b.stage === 'planning'));
  } finally {
    cleanup([featureDir]);
  }
});

test('native agent/model: awaiting_user status maps through existing hook-state machine', async () => {
  const featureDir = makeTempDir();
  try {
    mkdirSync(featureDir, { recursive: true });

    writePlanningResult(featureDir, {
      agent: 'native',
      model: 'pi-reasoning-20260201',
      status: 'awaiting_user',
      finishedAt: null,
      notes: 'Native planner awaiting clarification',
    });

    const state = await deriveFeatureState({
      featureDir,
      issueId: 'HOK-2310',
      slug: 'native-awaiting',
    });

    // awaiting_user must round-trip through the same normalized state used by Claude/Codex
    assert.equal(state.currentPhase, 'planning');
    assert.equal(state.normalizedState, 'awaiting_user');
    assert.equal(state.stages.planning?.agent, 'native');
    assert.equal(state.stages.planning?.model, 'pi-reasoning-20260201');
    assert.equal(state.stages.planning?.status, 'awaiting_user');
  } finally {
    cleanup([featureDir]);
  }
});

// HOK-2364: approval_needed state surfacing
test('approval_needed: coding stage with approvalRequest artifact maps to approval_needed normalized state', async () => {
  const featureDir = makeTempDir();
  try {
    mkdirSync(featureDir, { recursive: true });

    writeFileSync(
      join(featureDir, '.coding-result.json'),
      JSON.stringify({
        stage: 'coding',
        status: 'awaiting_user',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        agent: 'native',
        model: 'pi-mini',
        notes: 'Awaiting human approval for risky operation',
        artifacts: {
          type: 'coding',
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
          commitCount: 0,
          approvalRequest: {
            requestId: 'abc123',
            riskReason: 'Creates PR in ready phase',
            argSummary: 'repo=owner/repo',
            requestedAt: Date.now(),
            expiresAt: Date.now() + 300_000,
          },
        },
      }),
    );

    const state = await deriveFeatureState({
      featureDir,
      issueId: 'HOK-2364',
      slug: 'approval-needed-test',
    });

    assert.equal(state.currentPhase, 'coding');
    assert.equal(state.normalizedState, 'approval_needed');
  } finally {
    cleanup([featureDir]);
  }
});

test('approval_needed: awaiting_user without approvalRequest stays as awaiting_user', async () => {
  const featureDir = makeTempDir();
  try {
    mkdirSync(featureDir, { recursive: true });

    writeFileSync(
      join(featureDir, '.coding-result.json'),
      JSON.stringify({
        stage: 'coding',
        status: 'awaiting_user',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        agent: 'native',
        model: 'pi-mini',
        notes: 'Awaiting user (generic)',
        artifacts: {
          type: 'coding',
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
          commitCount: 0,
        },
      }),
    );

    const state = await deriveFeatureState({
      featureDir,
      issueId: 'HOK-2364',
      slug: 'generic-awaiting-test',
    });

    assert.equal(state.currentPhase, 'coding');
    assert.equal(state.normalizedState, 'awaiting_user');
  } finally {
    cleanup([featureDir]);
  }
});
