import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import { buildChallengeStageEval } from './stage-eval-evidence.ts';

function makeRecord(): EvalRecord {
  return {
    id: 'eval-stage-evidence',
    schemaVersion: '1.35.0',
    originalPrompt: 'Plan the change',
    modelId: 'gpt-5.4',
    modelVersion: 'gpt-5.4',
    score: 0.8,
    scoreBand: 'Minor Feedback',
    timeSeconds: 120,
    timestamp: '2026-07-30T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
  };
}

function setupPlanningResult(slug: string, result: Record<string, unknown>): { repoDir: string; featureDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'stage-evidence-'));
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'plan.md'), '# Plan\n\n## Phase 1\n- Do the work.\n');
  writeFileSync(join(featureDir, '.planning-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return { repoDir, featureDir };
}

describe('buildChallengeStageEval planning execution outcome evidence', () => {
  it('includes approval-ready planning outcome evidence for success', () => {
    const slug = 'plan-success';
    const { repoDir } = setupPlanningResult(slug, {
      stage: 'planning',
      status: 'awaiting_user',
      agent: 'native',
      model: 'gpt-5.4',
      failureReason: null,
      artifacts: {
        type: 'planning',
        planArtifactValid: true,
        approvalReady: true,
        bounds: { maxTurns: 40, maxToolCalls: 120, maxWallClockMs: 1200000 },
        usage: { turnsCompleted: 12, toolCallsExecuted: 31, wallClockMs: 300000 },
      },
    });

    try {
      const evalStage = buildChallengeStageEval({
        repoDir,
        issueId: 'HOK-2593',
        branchName: `task/${slug}`,
        challengeStage: 'plan',
        record: makeRecord(),
        stageArtifacts: { planContent: '# Plan\n\n## Phase 1\n- Do the work.\n' },
      });

      const outcome = evalStage?.evidence.find((item) => item.label === 'planning_execution_outcome');
      assert.equal(evalStage?.provenance, 'direct');
      assert.ok(outcome);
      assert.match(outcome.summary, /status=awaiting_user/);
      assert.match(outcome.summary, /planValid=true/);
      assert.match(outcome.summary, /approvalReady=true/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('includes terminal reason and exceeded bound evidence for turn_limit', () => {
    const slug = 'plan-turn-limit';
    const { repoDir } = setupPlanningResult(slug, {
      stage: 'planning',
      status: 'failed',
      agent: 'native',
      model: 'moonshotai/kimi-k2.7-code',
      failureReason: 'turn_limit',
      artifacts: {
        type: 'planning',
        planArtifactValid: false,
        approvalReady: false,
        bounds: { maxTurns: 40, maxToolCalls: 120, maxWallClockMs: 1200000 },
        usage: { turnsCompleted: 40, toolCallsExecuted: 72, wallClockMs: 900000 },
      },
    });

    try {
      const evalStage = buildChallengeStageEval({
        repoDir,
        issueId: 'HOK-2593',
        branchName: `task/${slug}`,
        challengeStage: 'plan',
        record: makeRecord(),
        stageArtifacts: { planContent: '# Plan\n\n## Phase 1\n- Do the work.\n' },
      });

      const outcome = evalStage?.evidence.find((item) => item.label === 'planning_execution_outcome');
      assert.equal(evalStage?.provenance, 'direct');
      assert.ok(outcome);
      assert.match(outcome.summary, /failureReason=turn_limit/);
      assert.match(outcome.summary, /approvalReady=false/);
      assert.match(outcome.summary, /boundsExceeded=turns/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('buildChallengeStageEval review dismissal evidence (HOK-2932)', () => {
  it('carries dismissed blocker counts and justifications into review evidence', () => {
    const slug = 'review-dismissed';
    const repoDir = mkdtempSync(join(tmpdir(), 'stage-evidence-'));
    const featureDir = join(repoDir, 'features', slug);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.review-result.json'), `${JSON.stringify({
      stage: 'review',
      status: 'completed',
      agent: 'codex',
      model: 'claude-opus-4-7',
      notes: 'Sole blocker dismissed as a verified false positive.',
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
            justification: 'False positive: stale diff base; PR diff is five in-scope files.',
            evidence: 'git log auto/integration..HEAD -- <in-scope paths>',
          },
        ],
      },
    }, null, 2)}\n`);

    try {
      const evalStage = buildChallengeStageEval({
        repoDir,
        issueId: 'HOK-2932',
        branchName: `task/${slug}`,
        challengeStage: 'review',
        record: makeRecord(),
        stageArtifacts: { selfReviewSummary: 'verdict=not_ready blockers=1 dismissed=1' },
      });

      const reviewEvidence = evalStage?.evidence.find((item) => item.label === 'review_result');
      assert.ok(reviewEvidence);
      assert.match(reviewEvidence.summary, /blockers=1/);
      assert.match(reviewEvidence.summary, /dismissedBlockers=1/);
      assert.match(reviewEvidence.summary, /dismissalJustifications=.*stale diff base/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
