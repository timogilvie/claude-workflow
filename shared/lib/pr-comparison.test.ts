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
  assert.match(result.prompt, /Primary eval score: 0.5/);
  assert.match(result.prompt, /Challenger eval score: 0.75/);
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

  assert.match(summary, /Primary used planner-a/);
  assert.match(summary, /Challenge type: multi-variable/);
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
