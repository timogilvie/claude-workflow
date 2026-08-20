import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChallengeCommentBody,
  buildCappedComparisonPrompt,
  buildComparisonPrompt,
  formatRoutingSummary,
  mapBlindVerdictToSides,
  prNumberFromValue,
  resolvePresentationOrder,
  validateComparisonJson,
} from './pr-comparison.ts';

test('prNumberFromValue extracts the PR number from URLs', () => {
  assert.equal(prNumberFromValue('https://github.com/acme/repo/pull/123'), '123');
  assert.equal(prNumberFromValue('456'), '456');
});

test('buildComparisonPrompt includes workflow context when routing metadata differs', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'alpha diff',
    challengerDiff: 'beta diff',
    presentationOrder: 'primary-first',
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
  assert.match(prompt, /Candidate A side:/);
  assert.match(prompt, /Candidate B side:/);
  assert.doesNotMatch(prompt, /scopeDiscipline/);
  assert.doesNotMatch(prompt, /Primary/);
  assert.doesNotMatch(prompt, /Challenger/);
});

test('buildComparisonPrompt includes direct stage evidence for planner challenges', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'alpha diff',
    challengerDiff: 'beta diff',
    presentationOrder: 'primary-first',
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
  assert.match(prompt, /Candidate A plan evidence \(direct\)/);
  assert.match(prompt, /Candidate B plan evidence \(direct\)/);
  assert.match(prompt, /plan_text: Plan chooses a staged auth migration/);
  assert.doesNotMatch(prompt, /Primary/);
  assert.doesNotMatch(prompt, /Challenger/);
});

test('buildComparisonPrompt omits direct stage evidence when fallback inference is required', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'alpha diff',
    challengerDiff: 'beta diff',
    presentationOrder: 'primary-first',
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
    presentationOrder: 'challenger-first',
  }, 3000);

  assert.equal(result.truncated, true);
  assert.ok(result.finalBytes <= 3000);
  assert.match(result.prompt, /TRUNCATED candidate A diff/);
  assert.match(result.prompt, /TRUNCATED candidate B diff/);
  assert.doesNotMatch(result.prompt, /TRUNCATED primary diff/);
  assert.doesNotMatch(result.prompt, /TRUNCATED challenger diff/);
});

test('validateComparisonJson trims fields and rejects invalid score payloads', () => {
  const valid = validateComparisonJson({
    winner: 'A',
    rationale: ' better result ',
    workflowInsight: ' routing mattered ',
    dimensions: {
      completeness: { A: 8, B: 7 },
      correctness: { A: 8, B: 6 },
      code_quality: { A: 7, B: 6 },
      intervention_impact: { A: 9, B: 7 },
      autonomy: { A: 8, B: 7 },
    },
  });

  assert.equal(valid.rationale, 'better result');
  assert.equal(valid.workflowInsight, 'routing mattered');
  assert.equal(valid.winner, 'A');

  assert.throws(
    () => validateComparisonJson({
      winner: 'B',
      rationale: 'ok',
      dimensions: {
        completeness: { A: 8, B: 7 },
        correctness: { A: 11, B: 6 },
        code_quality: { A: 7, B: 6 },
        intervention_impact: { A: 9, B: 7 },
        autonomy: { A: 8, B: 7 },
      },
    }),
    /Expected integers from 1 to 10/
  );
});

test('validateComparisonJson rejects unblinded and legacy keys', () => {
  assert.throws(
    () => validateComparisonJson({
      winner: 'primary',
      rationale: 'ok',
      dimensions: {
        completeness: { A: 8, B: 7 },
        correctness: { A: 8, B: 7 },
        code_quality: { A: 8, B: 7 },
        intervention_impact: { A: 8, B: 7 },
        autonomy: { A: 8, B: 7 },
      },
    }),
    /Unblinded comparison winner keys/
  );

  assert.throws(
    () => validateComparisonJson({
      winner: 'A',
      rationale: 'ok',
      dimensions: {
        completeness: { A: 8 },
        correctness: { A: 8, B: 7 },
        code_quality: { A: 8, B: 7 },
        intervention_impact: { A: 8, B: 7 },
        autonomy: { A: 8, B: 7 },
      },
    }),
    /Invalid dimension payload for completeness/
  );

  assert.throws(
    () => validateComparisonJson({
      winner: 'A',
      rationale: 'ok',
      dimensions: {
        completeness: { A: 8, B: 7 },
        correctness: { A: 8, B: 7 },
        code_quality: { A: 8, B: 7 },
        intervention_impact: { A: 8, B: 7 },
        autonomy: { A: 8, B: 7 },
        scopeDiscipline: { A: 8, B: 7 },
      },
    }),
    /Legacy comparison keys/
  );

  assert.throws(
    () => validateComparisonJson({
      winner: 'A',
      rationale: 'ok',
      dimensions: {
        completeness: { primary: 8, challenger: 7 },
        correctness: { A: 8, B: 7 },
        code_quality: { A: 8, B: 7 },
        intervention_impact: { A: 8, B: 7 },
        autonomy: { A: 8, B: 7 },
      },
    }),
    /Unblinded comparison dimension keys/
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

  assert.match(summary, /Primary intended planner-a/);
  assert.match(summary, /Challenge type: multi-variable/);
});

test('formatRoutingSummary separates intended routing from executed provenance and validation', () => {
  const summary = formatRoutingSummary(
    {
      planner: 'claude-opus-4-7',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'high',
      reviewMode: 'full',
    },
    {
      planner: 'claude-sonnet-5',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'high',
      reviewMode: 'full',
    },
    'planner-only',
    {
      planning: {
        stage: 'planning',
        role: 'planner',
        model: 'kimi-k2.7-code',
        rawModel: 'moonshotai/kimi-k2.7-code',
        agent: 'native-openrouter',
        status: 'completed',
        source: '.planning-result.json',
        artifactPath: '/tmp/primary/.planning-result.json',
        consultedArtifactPaths: ['/tmp/primary/.planning-result.json'],
      },
      coding: {
        stage: 'coding',
        role: 'coder',
        model: 'coder-a',
        agent: 'claude',
        status: 'completed',
        source: '.coding-result.json',
        artifactPath: '/tmp/primary/.coding-result.json',
        consultedArtifactPaths: ['/tmp/primary/.coding-result.json'],
      },
      review: {
        stage: 'review',
        role: 'reviewer',
        model: 'reviewer-a',
        agent: 'claude',
        status: 'completed',
        source: '.review-result.json',
        artifactPath: '/tmp/primary/.review-result.json',
        consultedArtifactPaths: ['/tmp/primary/.review-result.json'],
      },
    },
    {
      planning: {
        stage: 'planning',
        role: 'planner',
        model: 'claude-sonnet-5',
        agent: 'claude',
        status: 'completed',
        source: '.planning-result.json',
        artifactPath: '/tmp/challenger/.planning-result.json',
        consultedArtifactPaths: ['/tmp/challenger/.planning-result.json'],
      },
      coding: {
        stage: 'coding',
        role: 'coder',
        model: 'coder-a',
        agent: 'claude',
        status: 'completed',
        source: '.coding-result.json',
        artifactPath: '/tmp/challenger/.coding-result.json',
        consultedArtifactPaths: ['/tmp/challenger/.coding-result.json'],
      },
      review: {
        stage: 'review',
        role: 'reviewer',
        model: 'reviewer-a',
        agent: 'claude',
        status: 'completed',
        source: '.review-result.json',
        artifactPath: '/tmp/challenger/.review-result.json',
        consultedArtifactPaths: ['/tmp/challenger/.review-result.json'],
      },
    },
    {
      valid: false,
      outcome: 'invalid',
      challengedStage: 'planning',
      challengedRole: 'planner',
      issues: [
        {
          side: 'primary',
          stage: 'planning',
          role: 'planner',
          reason: 'executed-model-mismatch',
          intendedModel: 'claude-opus-4-7',
          executedModel: 'kimi-k2.7-code',
          artifactPath: '/tmp/primary/.planning-result.json',
        },
      ],
    },
  );

  assert.match(summary, /Primary intended claude-opus-4-7/);
  assert.match(summary, /Executed primary: planner native-openrouter\/kimi-k2\.7-code/);
  assert.match(summary, /Provenance validation: invalid/);
  assert.match(summary, /executed-model-mismatch intended=claude-opus-4-7 executed=kimi-k2\.7-code/);
});

test('buildComparisonPrompt blinds labels and eval scores in both presentation orders', () => {
  for (const presentationOrder of ['primary-first', 'challenger-first'] as const) {
    const prompt = buildComparisonPrompt({
      issuePrompt: 'Issue context',
      primaryDiff: 'alpha diff body',
      challengerDiff: 'beta diff body',
      presentationOrder,
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
    });

    assert.match(prompt, /Candidate A/);
    assert.match(prompt, /Candidate B/);
    assert.match(prompt, /"winner": "A" \| "B"/);
    assert.doesNotMatch(prompt, /Primary/);
    assert.doesNotMatch(prompt, /Challenger/);
    assert.doesNotMatch(prompt, /0\.7|0\.8|0\.60|0\.75/);
    assert.doesNotMatch(prompt, /eval score|Per-stage scores|review-stage eval/i);
  }
});

test('buildComparisonPrompt places routing, evidence, and diffs according to presentation order', () => {
  const baseInput = {
    issuePrompt: 'Issue context',
    primaryDiff: 'alpha diff body',
    challengerDiff: 'beta diff body',
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
    challengeType: 'planner-only',
    primaryStageEval: {
      stage: 'plan' as const,
      provenance: 'direct' as const,
      summary: 'Alpha stage evidence.',
      evidence: [{ label: 'plan_text', summary: 'Alpha plan summary.', source: 'alpha-plan' }],
    },
    challengerStageEval: {
      stage: 'plan' as const,
      provenance: 'direct' as const,
      summary: 'Beta stage evidence.',
      evidence: [{ label: 'plan_text', summary: 'Beta plan summary.', source: 'beta-plan' }],
    },
  };

  const primaryFirst = buildComparisonPrompt({
    ...baseInput,
    presentationOrder: 'primary-first',
  });
  assert.ok(primaryFirst.indexOf('Candidate A side:\n- Planner: planner-a') < primaryFirst.indexOf('Candidate B side:\n- Planner: planner-b'));
  assert.ok(primaryFirst.indexOf('Candidate A plan evidence (direct): Alpha') < primaryFirst.indexOf('Candidate B plan evidence (direct): Beta'));
  assert.ok(primaryFirst.indexOf('Candidate A diff:\nalpha diff body') < primaryFirst.indexOf('Candidate B diff:\nbeta diff body'));

  const challengerFirst = buildComparisonPrompt({
    ...baseInput,
    presentationOrder: 'challenger-first',
  });
  assert.ok(challengerFirst.indexOf('Candidate A side:\n- Planner: planner-b') < challengerFirst.indexOf('Candidate B side:\n- Planner: planner-a'));
  assert.ok(challengerFirst.indexOf('Candidate A plan evidence (direct): Beta') < challengerFirst.indexOf('Candidate B plan evidence (direct): Alpha'));
  assert.ok(challengerFirst.indexOf('Candidate A diff:\nbeta diff body') < challengerFirst.indexOf('Candidate B diff:\nalpha diff body'));
});

test('mapBlindVerdictToSides attributes winners and dimensions under both orders', () => {
  const blindVerdict = {
    winner: 'A' as const,
    rationale: 'Candidate A did better.',
    workflowInsight: 'Routing mattered.',
    dimensions: {
      completeness: { A: 9, B: 6 },
      correctness: { A: 8, B: 5 },
      code_quality: { A: 7, B: 4 },
      intervention_impact: { A: 6, B: 3 },
      autonomy: { A: 5, B: 2 },
    },
  };

  const primaryFirst = mapBlindVerdictToSides(blindVerdict, 'primary-first');
  assert.equal(primaryFirst.winner, 'primary');
  assert.deepEqual(primaryFirst.dimensions.completeness, { primary: 9, challenger: 6 });

  const challengerFirst = mapBlindVerdictToSides(blindVerdict, 'challenger-first');
  assert.equal(challengerFirst.winner, 'challenger');
  assert.deepEqual(challengerFirst.dimensions.completeness, { primary: 6, challenger: 9 });

  assert.equal(mapBlindVerdictToSides({ ...blindVerdict, winner: 'B' }, 'primary-first').winner, 'challenger');
  assert.equal(mapBlindVerdictToSides({ ...blindVerdict, winner: 'B' }, 'challenger-first').winner, 'primary');
});

test('resolvePresentationOrder supports random, explicit override, and invalid values', () => {
  assert.equal(resolvePresentationOrder(undefined, () => 0.1), 'primary-first');
  assert.equal(resolvePresentationOrder('random', () => 0.9), 'challenger-first');
  assert.equal(resolvePresentationOrder('challenger-first', () => 0.1), 'challenger-first');
  assert.equal(resolvePresentationOrder('primary-first', () => 0.9), 'primary-first');
  assert.throws(() => resolvePresentationOrder('primary'), /Invalid presentation order/);
});

test('existing comparison replay maps to the same stored winner and dimensions when order is fixed', () => {
  const stored = {
    winner: 'primary' as const,
    dimensions: {
      completeness: { primary: 8, challenger: 6 },
      correctness: { primary: 9, challenger: 5 },
      code_quality: { primary: 7, challenger: 6 },
      intervention_impact: { primary: 8, challenger: 4 },
      autonomy: { primary: 9, challenger: 5 },
    },
  };

  const primaryFirstBlind = {
    winner: 'A' as const,
    rationale: 'Candidate A wins.',
    dimensions: {
      completeness: { A: 8, B: 6 },
      correctness: { A: 9, B: 5 },
      code_quality: { A: 7, B: 6 },
      intervention_impact: { A: 8, B: 4 },
      autonomy: { A: 9, B: 5 },
    },
  };
  assert.deepEqual(
    {
      winner: mapBlindVerdictToSides(primaryFirstBlind, 'primary-first').winner,
      dimensions: mapBlindVerdictToSides(primaryFirstBlind, 'primary-first').dimensions,
    },
    stored,
  );

  const challengerFirstBlind = {
    winner: 'B' as const,
    rationale: 'Candidate B wins.',
    dimensions: {
      completeness: { A: 6, B: 8 },
      correctness: { A: 5, B: 9 },
      code_quality: { A: 6, B: 7 },
      intervention_impact: { A: 4, B: 8 },
      autonomy: { A: 5, B: 9 },
    },
  };
  assert.deepEqual(
    {
      winner: mapBlindVerdictToSides(challengerFirstBlind, 'challenger-first').winner,
      dimensions: mapBlindVerdictToSides(challengerFirstBlind, 'challenger-first').dimensions,
    },
    stored,
  );
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

test('buildChallengeCommentBody reports invalid comparisons without a winner', () => {
  const body = buildChallengeCommentBody({
    pairId: 'pair-123',
    rationale: 'Challenge comparison invalid: primary planner mismatch.',
    otherPrUrl: 'https://github.com/acme/repo/pull/22',
    routingSummary: 'routing summary',
    provenanceValidation: {
      valid: false,
      outcome: 'invalid',
      issues: [
        {
          side: 'primary',
          stage: 'planning',
          role: 'planner',
          reason: 'executed-model-mismatch',
        },
      ],
    },
  });

  assert.match(body, /Comparison outcome: invalid/);
  assert.doesNotMatch(body, /Recommended winner/);
});
