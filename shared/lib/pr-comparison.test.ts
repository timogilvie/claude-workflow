import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChallengeCommentBody,
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
});

test('validateComparisonJson trims fields and rejects invalid score payloads', () => {
  const valid = validateComparisonJson({
    winner: 'primary',
    rationale: ' better result ',
    workflowInsight: ' routing mattered ',
    dimensions: {
      correctness: { primary: 8, challenger: 6 },
      codeQuality: { primary: 7, challenger: 6 },
      completeness: { primary: 8, challenger: 7 },
      scopeDiscipline: { primary: 9, challenger: 7 },
    },
  });

  assert.equal(valid.rationale, 'better result');
  assert.equal(valid.workflowInsight, 'routing mattered');

  assert.throws(
    () => validateComparisonJson({
      winner: 'challenger',
      rationale: 'ok',
      dimensions: {
        correctness: { primary: 11, challenger: 6 },
        codeQuality: { primary: 7, challenger: 6 },
        completeness: { primary: 8, challenger: 7 },
        scopeDiscipline: { primary: 9, challenger: 7 },
      },
    }),
    /Expected integers from 1 to 10/
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
