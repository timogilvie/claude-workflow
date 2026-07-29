import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChallengeCommentBody,
  buildCappedComparisonPrompt,
  buildComparisonPrompt,
  formatRoutingSummary,
  prNumberFromValue,
  validateComparisonJson,
} from './pr-comparison.ts';

test('prNumberFromValue extracts the PR number from URLs', () => {
  assert.equal(prNumberFromValue('https://github.com/acme/repo/pull/123'), '123');
  assert.equal(prNumberFromValue('456'), '456');
});

test('buildComparisonPrompt includes workflow context when routing metadata differs', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'primary diff',
    challengerDiff: 'challenger diff',
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.7,
    primaryRouting: {
      planner: 'planner-a',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'medium',
      reviewMode: 'full',
    },
    challengerRouting: {
      planner: 'planner-b',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'medium',
      reviewMode: 'full',
    },
  });

  assert.match(prompt, /Workflow Context/);
  assert.match(prompt, /Variables that differed: planner/);
  assert.match(prompt, /intervention_impact/);
  assert.doesNotMatch(prompt, /scopeDiscipline/);
});

test('buildComparisonPrompt includes direct stage evidence for planner challenges', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'primary diff',
    challengerDiff: 'challenger diff',
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.7,
    challengeType: 'planner-only',
    primaryStageEval: {
      stage: 'plan',
      provenance: 'direct',
      summary: 'Direct planning evidence captured.',
      evidence: [
        { label: 'plan_text', summary: 'Plan chooses a staged auth migration.', source: 'plan.md' },
      ],
    },
    challengerStageEval: {
      stage: 'plan',
      provenance: 'direct',
      summary: 'Direct planning evidence captured.',
      evidence: [
        { label: 'plan_text', summary: 'Plan chooses a single-pass auth migration.', source: 'plan.md' },
      ],
    },
  });

  assert.match(prompt, /Direct Stage Evidence/);
  assert.match(prompt, /Primary plan evidence \(direct\)/);
  assert.match(prompt, /plan_text: Plan chooses a staged auth migration/);
});

test('buildComparisonPrompt omits direct stage evidence when fallback inference is required', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'primary diff',
    challengerDiff: 'challenger diff',
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.7,
    challengeType: 'reviewer-only',
    primaryStageEval: {
      stage: 'review',
      provenance: 'direct',
      summary: 'Direct review evidence captured.',
      evidence: [
        { label: 'self_review_summary', summary: 'Raised one blocker.', source: 'review-log' },
      ],
    },
    challengerStageEval: {
      stage: 'review',
      provenance: 'inferred',
      summary: 'Fallback to inferred review evidence.',
      fallbackReason: 'Missing self-review summary',
      evidence: [
        { label: 'inferred_review_score', summary: 'score=0.75', source: 'metadata.stageScores.review' },
      ],
    },
  });

  assert.doesNotMatch(prompt, /Direct Stage Evidence/);
});

test('buildCappedComparisonPrompt truncates oversized diff bodies', () => {
  const result = buildCappedComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'p'.repeat(4000),
    challengerDiff: 'c'.repeat(4000),
    primaryEvalScore: 0.5,
    challengerEvalScore: 0.75,
  }, 3000);

  assert.equal(result.truncated, true);
  assert.ok(result.finalBytes <= 3000);
  assert.match(result.prompt, /TRUNCATED primary diff/);
  assert.match(result.prompt, /TRUNCATED challenger diff/);
  assert.match(result.prompt, /Primary eval score \(overall\): 0.5/);
  assert.match(result.prompt, /Challenger eval score \(overall\): 0.75/);
});

test('validateComparisonJson trims fields and rejects invalid score payloads', () => {
  const valid = validateComparisonJson({
    winner: 'primary',
    rationale: ' better result ',
    workflowInsight: ' routing mattered ',
    dimensions: {
      completeness: { primary: 8, challenger: 7 },
      correctness: { primary: 8, challenger: 6 },
      code_quality: { primary: 7, challenger: 6 },
      intervention_impact: { primary: 9, challenger: 7 },
      autonomy: { primary: 8, challenger: 7 },
    },
  });

  assert.equal(valid.rationale, 'better result');
  assert.equal(valid.workflowInsight, 'routing mattered');

  assert.throws(
    () => validateComparisonJson({
      winner: 'challenger',
      rationale: 'ok',
      dimensions: {
        completeness: { primary: 8, challenger: 7 },
        correctness: { primary: 11, challenger: 6 },
        code_quality: { primary: 7, challenger: 6 },
        intervention_impact: { primary: 9, challenger: 7 },
        autonomy: { primary: 8, challenger: 7 },
      },
    }),
    /Expected integers from 1 to 10/
  );
});

test('validateComparisonJson rejects legacy keys', () => {
  assert.throws(
    () => validateComparisonJson({
      winner: 'primary',
      rationale: 'ok',
      dimensions: {
        completeness: { primary: 8, challenger: 7 },
        correctness: { primary: 8, challenger: 7 },
        code_quality: { primary: 8, challenger: 7 },
        intervention_impact: { primary: 8, challenger: 7 },
        autonomy: { primary: 8, challenger: 7 },
        scopeDiscipline: { primary: 8, challenger: 7 },
      },
    }),
    /Legacy comparison keys/
  );
});

test('formatRoutingSummary includes challenge type when present', () => {
  const summary = formatRoutingSummary(
    {
      planner: 'planner-a',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'high',
      reviewMode: 'full',
    },
    {
      planner: 'planner-b',
      coder: 'coder-b',
      reviewer: 'reviewer-b',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewMode: 'lite',
    },
    'multi-variable'
  );

  assert.match(summary, /Intended primary route: planner-a/);
  assert.match(summary, /Challenge type: multi-variable/);
});

test('formatRoutingSummary separates intended route from executed provenance', () => {
  const executionProvenance = {
    primary: {
      featureDir: '/tmp/primary',
      diagnostics: [],
      stages: {
        planning: {
          stage: 'planning',
          agent: 'native-openrouter',
          model: 'moonshotai/kimi-k2.7-code',
          canonicalModel: 'moonshotai/kimi-k2.7-code',
          status: 'completed',
          sourcePath: '/tmp/primary/.planning-result.json',
        },
        coding: {
          stage: 'coding',
          agent: 'codex',
          model: 'gpt-5.4',
          canonicalModel: 'gpt-5.4',
          status: 'completed',
          sourcePath: '/tmp/primary/.coding-result.json',
        },
        review: {
          stage: 'review',
          agent: 'codex',
          model: 'claude-opus-4-7',
          canonicalModel: 'claude-opus-4-7',
          status: 'completed',
          sourcePath: '/tmp/primary/.review-result.json',
        },
      },
    },
    challenger: {
      featureDir: '/tmp/challenger',
      diagnostics: [],
      stages: {
        planning: {
          stage: 'planning',
          agent: 'codex',
          model: 'claude-opus-4-7',
          canonicalModel: 'claude-opus-4-7',
          status: 'completed',
          sourcePath: '/tmp/challenger/.planning-result.json',
        },
      },
    },
  } as const;
  const summary = formatRoutingSummary(
    {
      planner: 'claude-opus-4-7',
      coder: 'gpt-5.4',
      reviewer: 'claude-opus-4-7',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewMode: 'llm',
    },
    {
      planner: 'claude-opus-4-7',
      coder: 'gpt-5.4',
      reviewer: 'claude-opus-4-7',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewMode: 'llm',
    },
    undefined,
    executionProvenance,
    {
      validity: 'invalid',
      challengedStages: ['planning'],
      mismatchReasons: ['primary planning executed moonshotai/kimi-k2.7-code but intended claude-opus-4-7'],
      mismatches: [{
        side: 'primary',
        stage: 'planning',
        reason: 'primary planning executed moonshotai/kimi-k2.7-code but intended claude-opus-4-7',
        sourcePath: '/tmp/primary/.planning-result.json',
      }],
    },
  );

  assert.match(summary, /Intended primary route: claude-opus-4-7/);
  assert.match(summary, /Primary planner: native-openrouter \/ moonshotai\/kimi-k2\.7-code \(completed\)/);
  assert.match(summary, /\/tmp\/primary\/\.planning-result\.json/);
  assert.match(summary, /Mismatches:/);
});

test('buildComparisonPrompt includes executed provenance in workflow context', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'primary diff',
    challengerDiff: 'challenger diff',
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.7,
    primaryRouting: {
      planner: 'claude-opus-4-7',
      coder: 'gpt-5.4',
      reviewer: 'claude-opus-4-7',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewMode: 'llm',
    },
    challengerRouting: {
      planner: 'claude-opus-4-7',
      coder: 'gpt-5.4',
      reviewer: 'claude-opus-4-7',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewMode: 'llm',
    },
    executionProvenance: {
      primary: {
        featureDir: '/tmp/primary',
        diagnostics: [],
        stages: {
          planning: {
            stage: 'planning',
            agent: 'native-openrouter',
            model: 'moonshotai/kimi-k2.7-code',
            canonicalModel: 'moonshotai/kimi-k2.7-code',
            status: 'completed',
            sourcePath: '/tmp/primary/.planning-result.json',
          },
        },
      },
      challenger: { featureDir: '/tmp/challenger', diagnostics: [], stages: {} },
    },
  });

  assert.match(prompt, /Intended routing:/);
  assert.match(prompt, /Executed provenance:/);
  assert.match(prompt, /native-openrouter \/ moonshotai\/kimi-k2\.7-code/);
});

test('buildComparisonPrompt uses stage-specific score label for reviewer-only', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'primary diff',
    challengerDiff: 'challenger diff',
    primaryEvalScore: 0.64,
    challengerEvalScore: 0.75,
    primaryEvalScoreSource: 'stage.review',
    challengerEvalScoreSource: 'stage.review',
  });
  assert.match(prompt, /Primary review-stage eval score: 0\.64/);
  assert.match(prompt, /Challenger review-stage eval score: 0\.75/);
  assert.doesNotMatch(prompt, /Primary eval score:/);
});

test('buildComparisonPrompt uses overall label when source is overall', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'primary diff',
    challengerDiff: 'challenger diff',
    primaryEvalScore: 0.7,
    challengerEvalScore: 0.8,
    primaryEvalScoreSource: 'overall',
    challengerEvalScoreSource: 'overall',
  });
  assert.match(prompt, /Primary eval score \(overall\): 0\.7/);
  assert.match(prompt, /Challenger eval score \(overall\): 0\.8/);
});

test('buildComparisonPrompt uses overall label when source is absent', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'primary diff',
    challengerDiff: 'challenger diff',
    primaryEvalScore: 0.5,
    challengerEvalScore: 0.6,
  });
  assert.match(prompt, /Primary eval score \(overall\): 0\.5/);
  assert.match(prompt, /Challenger eval score \(overall\): 0\.6/);
});

test('buildComparisonPrompt includes per-stage scores in workflow context for multi-variable', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'primary diff',
    challengerDiff: 'challenger diff',
    primaryEvalScore: 0.7,
    challengerEvalScore: 0.8,
    primaryRouting: {
      planner: 'planner-a',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'medium',
      reviewMode: 'full',
    },
    challengerRouting: {
      planner: 'planner-b',
      coder: 'coder-b',
      reviewer: 'reviewer-b',
      planDepth: 'medium',
      codeDepth: 'low',
      reviewMode: 'lite',
    },
    primaryPerStageScores: { plan: 0.6, review: 0.7 },
    challengerPerStageScores: { plan: 0.8, review: 0.75 },
  });
  assert.match(prompt, /Per-stage scores:/);
  assert.match(prompt, /plan: primary=0\.60, challenger=0\.80/);
  assert.match(prompt, /review: primary=0\.70, challenger=0\.75/);
});

test('buildChallengeCommentBody points each PR at the opposite PR', () => {
  const primaryComment = buildChallengeCommentBody({
    pairId: 'pair-123',
    winner: 'challenger',
    winnerModel: 'model-b',
    rationale: 'challenger produced the better fix',
    otherPrUrl: 'https://github.com/acme/repo/pull/22',
    routingSummary: 'routing summary',
  });
  const challengerComment = buildChallengeCommentBody({
    pairId: 'pair-123',
    winner: 'challenger',
    winnerModel: 'model-b',
    rationale: 'challenger produced the better fix',
    otherPrUrl: 'https://github.com/acme/repo/pull/11',
    routingSummary: 'routing summary',
  });

  assert.match(primaryComment, /Other PR: https:\/\/github\.com\/acme\/repo\/pull\/22/);
  assert.match(challengerComment, /Other PR: https:\/\/github\.com\/acme\/repo\/pull\/11/);
  assert.doesNotMatch(primaryComment, /Other PR: https:\/\/github\.com\/acme\/repo\/pull\/11/);
  assert.doesNotMatch(challengerComment, /Other PR: https:\/\/github\.com\/acme\/repo\/pull\/22/);
});

test('buildChallengeCommentBody renders inconclusive without recommended winner', () => {
  const comment = buildChallengeCommentBody({
    pairId: 'pair-123',
    rationale: 'Execution provenance did not match intended route.',
    otherPrUrl: 'https://github.com/acme/repo/pull/22',
    comparisonOutcome: 'inconclusive',
    validity: 'invalid',
    mismatchReasons: ['primary planning executed Kimi but intended Claude'],
  });

  assert.match(comment, /Result: inconclusive/);
  assert.match(comment, /Execution provenance mismatch:/);
  assert.match(comment, /primary planning executed Kimi but intended Claude/);
  assert.doesNotMatch(comment, /Recommended winner:/);
});
