import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTask } from './eval.ts';
import { enrichEvalRecord } from './eval-record-builder.ts';
import { SCHEMA_VERSION } from './eval-schema.ts';

function mockCallFn(responseText, usage = null, costUsd = undefined) {
  return mock.fn(() => Promise.resolve({ text: responseText, usage, costUsd }));
}

async function withMockSession(fn) {
  const previousSession = process.env.WAVEMILL_SESSION;
  process.env.WAVEMILL_SESSION = 'test-session';
  try {
    return await fn();
  } finally {
    if (previousSession === undefined) {
      delete process.env.WAVEMILL_SESSION;
    } else {
      process.env.WAVEMILL_SESSION = previousSession;
    }
  }
}

describe('evaluateTask', () => {
  it('returns a valid EvalRecord conforming to eval-schema', async () => {
    const validResponse = JSON.stringify({
      score: 0.85,
      rationale: 'Task was completed successfully with clean implementation.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Add a loading spinner',
        prReviewOutput: 'Clean diff, all tests pass',
        issueId: 'HOK-100',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    // Core EvalRecord fields from eval-schema.ts
    assert.ok(result.id, 'should have a UUID id');
    assert.equal(result.schemaVersion, SCHEMA_VERSION);
    assert.equal(result.originalPrompt, 'Add a loading spinner');
    assert.ok(result.modelId);
    assert.ok(result.modelVersion);
    assert.equal(result.score, 0.85);
    assert.equal(result.scoreBand, 'Minor Feedback');
    assert.equal(result.timeSeconds, null);
    assert.ok(new Date(result.timestamp).toISOString() === result.timestamp);
    assert.equal(result.interventionRequired, false);
    assert.equal(result.interventionCount, 0);
    assert.deepEqual(result.interventionDetails, []);
    assert.equal(result.rationale, 'Task was completed successfully with clean implementation.');
    assert.equal(result.issueId, 'HOK-100');
    assert.equal(result.trainingEligible, false);
    assert.equal(result.budgetEvalEligible, false);
    assert.equal(result.budgetEvalEligibilityError, 'missing_budget');
    assert.deepEqual(result.eligibilityErrors, [
      'missing_budget',
      'missing_budget_snapshot',
      'missing_cost',
      'missing_outcome',
      'missing_routing',
      'missing_task_descriptor',
    ]);
  });

  it('derives correct score band from eval-schema rubric', async () => {
    const validResponse = JSON.stringify({
      score: 1.0,
      rationale: 'Perfect autonomous execution.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Simple task',
        prReviewOutput: 'Flawless',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal(result.scoreBand, 'Full Success');
  });

  it('preserves explicit null timeSeconds', async () => {
    const validResponse = JSON.stringify({
      score: 0.85,
      rationale: 'Duration was unknown but the implementation was good.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Handle missing timing metadata',
        prReviewOutput: 'Clean diff',
        timeSeconds: null,
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal(result.timeSeconds, null);
  });

  it('normalizes invalid timeSeconds values to null', async () => {
    const validResponse = JSON.stringify({
      score: 0.85,
      rationale: 'Timing input was invalid.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Handle invalid timing metadata',
        prReviewOutput: 'Clean diff',
        timeSeconds: Number.NaN,
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal(result.timeSeconds, null);
  });

  it('passes intervention metadata through to the result', async () => {
    const validResponse = JSON.stringify({
      score: 0.6,
      rationale: 'Task completed but required guidance.',
      interventionFlags: ['needed-design-guidance'],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Build a dashboard',
        prReviewOutput: 'Implementation works but needed corrections',
        interventions: [
          { description: 'Corrected component structure', severity: 'major' },
          { description: 'Fixed import path', severity: 'minor' },
        ],
        issueId: 'HOK-200',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal(result.interventionRequired, true);
    assert.equal(result.interventionCount, 2);
    assert.deepEqual(result.interventionDetails, [
      'Corrected component structure',
      'Fixed import path',
    ]);
    assert.deepEqual(result.metadata.interventionFlags, ['needed-design-guidance']);
    assert.equal(result.scoreBand, 'Assisted Success');
  });

  it('stores planCritique in metadata when the judge returns it', async () => {
    const validResponse = JSON.stringify({
      score: 0.88,
      rationale: 'Implementation succeeded and the plan was mostly strong.',
      interventionFlags: [],
      stageScores: {
        expansion: { score: 0.9, rationale: 'Spec was clear.' },
        plan: { score: 0.84, rationale: 'Plan mostly identified the right work.' },
        implementation: { score: 0.9, rationale: 'Code landed cleanly.' },
        review: { score: 0.85, rationale: 'Review coverage was good.' },
      },
      planCritique: {
        component_boundaries: {
          score: 0.9,
          rationale: 'The plan targeted the correct eval prompt, parser, and schema layers.',
        },
        invariant_coverage: {
          score: 0.75,
          rationale: 'It identified the key optional-field compatibility constraint.',
        },
        approach_soundness: {
          score: 0.85,
          rationale: 'The approach was viable without adding extra judge calls.',
        },
        missed_patches: {
          score: 0.8,
          rationale: 'Only minor parser cleanup was needed during implementation.',
        },
        overall: {
          score: 0.82,
          rationale: 'The plan provided a solid implementation guide.',
        },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Add plan critique to evals',
        prReviewOutput: 'Changes are correct',
        planContent: 'Implement schema, prompt, parser, and tests.',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.deepEqual(result.metadata.planCritique, {
      component_boundaries: {
        score: 0.9,
        rationale: 'The plan targeted the correct eval prompt, parser, and schema layers.',
      },
      invariant_coverage: {
        score: 0.75,
        rationale: 'It identified the key optional-field compatibility constraint.',
      },
      approach_soundness: {
        score: 0.85,
        rationale: 'The approach was viable without adding extra judge calls.',
      },
      missed_patches: {
        score: 0.8,
        rationale: 'Only minor parser cleanup was needed during implementation.',
      },
      overall: {
        score: 0.82,
        rationale: 'The plan provided a solid implementation guide.',
      },
    });
    assert.equal(result.metadata.stageScores.plan.score, 0.84);
  });

  it('stores populated stageScores and schema-valid rubricEval from the judge', async () => {
    const validResponse = JSON.stringify({
      score: 0.7,
      rationale:
        'The task landed but a human-fixed functional issue capped the score at 0.7.',
      interventionFlags: [
        'review_comment:found schema compatibility issue',
        'post_pr_commit:fixed stage output wording',
      ],
      stageScores: {
        expansion: {
          score: 0.9,
          rationale: 'Requirement coverage and ambiguity resolution were strong.',
        },
        plan: {
          score: 0.82,
          rationale: 'Invariant coverage was solid, but validation planning missed one compatibility risk.',
        },
        implementation: {
          score: 0.68,
          rationale: 'Requirement completeness was good, but correctness suffered from the human-fixed issue.',
        },
        review: {
          score: 0.8,
          rationale: 'Issue detection eventually worked, though self-review missed the bug initially.',
        },
      },
      rubricEval: {
        schema_version: '1.0',
        rubric_version: '1.0',
        criteria: {
          completeness: {
            score: 0.9,
            rationale: 'The requested behavior was mostly implemented.',
          },
          correctness: {
            score: 0.68,
            rationale: 'A human-found compatibility bug reduced correctness.',
          },
          code_quality: {
            score: 0.84,
            rationale: 'The resulting changes fit the project structure well.',
          },
          intervention_impact: {
            score: 0.66,
            rationale: 'Human review and a fix meaningfully reduced autonomous execution quality.',
          },
          autonomy: {
            score: 0.7,
            rationale: 'The workflow was mostly autonomous but not bug-free.',
          },
        },
        determinative_boundary: 'functional_bug',
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Rewrite the eval judge prompt',
        prReviewOutput: 'One compatibility issue found and fixed',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.deepEqual(result.metadata.stageScores, {
      expansion: {
        score: 0.9,
        rationale: 'Requirement coverage and ambiguity resolution were strong.',
      },
      plan: {
        score: 0.82,
        rationale: 'Invariant coverage was solid, but validation planning missed one compatibility risk.',
      },
      implementation: {
        score: 0.68,
        rationale: 'Requirement completeness was good, but correctness suffered from the human-fixed issue.',
      },
      review: {
        score: 0.8,
        rationale: 'Issue detection eventually worked, though self-review missed the bug initially.',
      },
    });

    assert.deepEqual(result.rubricEval, {
      schema_version: '1.0',
      rubric_version: '1.0',
      criteria: {
        completeness: {
          score: 0.9,
          rationale: 'The requested behavior was mostly implemented.',
        },
        correctness: {
          score: 0.68,
          rationale: 'A human-found compatibility bug reduced correctness.',
        },
        code_quality: {
          score: 0.84,
          rationale: 'The resulting changes fit the project structure well.',
        },
        intervention_impact: {
          score: 0.66,
          rationale: 'Human review and a fix meaningfully reduced autonomous execution quality.',
        },
        autonomy: {
          score: 0.7,
          rationale: 'The workflow was mostly autonomous but not bug-free.',
        },
      },
      determinative_boundary: 'functional_bug',
    });
  });

  it('stores rubricCriteria from stageScores and enriches stageOutcomes', async () => {
    const validResponse = JSON.stringify({
      score: 0.86,
      rationale: 'The workflow completed with strong stage quality.',
      interventionFlags: [],
      stageScores: {
        expansion: {
          score: 0.9,
          rationale: 'Expansion covered requirements and validation.',
          rubricCriteria: [
            {
              criterion: 'requirement_coverage',
              score: 0.92,
              notes: 'All key requirements were surfaced.',
            },
          ],
        },
        plan: {
          score: 0.84,
          rationale: 'Plan captured the right boundaries.',
          rubricCriteria: [
            {
              criterion: 'component_boundaries',
              score: 0.86,
              notes: 'The affected modules were identified.',
            },
          ],
        },
        implementation: {
          score: 0.88,
          rationale: 'Implementation matched the plan.',
          rubricCriteria: [
            {
              criterion: 'correctness',
              score: 0.9,
              notes: 'No functional issues were found.',
            },
          ],
        },
        review: {
          score: 0.82,
          rationale: 'Review checked the important behavior.',
          rubricCriteria: [
            {
              criterion: 'issue_detection',
              score: 0.8,
              notes: 'Review covered the main failure modes.',
            },
          ],
        },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Persist stage rubric criteria',
        prReviewOutput: 'Clean diff',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.deepEqual(result.metadata.stageScores.expansion.rubricCriteria, [
      {
        criterion: 'requirement_coverage',
        score: 0.92,
        notes: 'All key requirements were surfaced.',
      },
    ]);

    enrichEvalRecord(result, {});
    assert.deepEqual(result.stageOutcomes.expansion.rubricCriteria, [
      {
        criterion: 'requirement_coverage',
        score: 0.92,
        notes: 'All key requirements were surfaced.',
      },
    ]);
    assert.deepEqual(result.stageOutcomes.plan.rubricCriteria, [
      {
        criterion: 'component_boundaries',
        score: 0.86,
        notes: 'The affected modules were identified.',
      },
    ]);
  });

  it('keeps scalar-only stageScores compatible without rubricCriteria warnings', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const validResponse = JSON.stringify({
        score: 0.8,
        rationale: 'Task completed without structured stage criteria.',
        interventionFlags: [],
        stageScores: {
          expansion: { score: 0.8, rationale: 'Expansion was adequate.' },
          plan: { score: 0.78, rationale: 'Plan was adequate.' },
          implementation: { score: 0.82, rationale: 'Implementation was adequate.' },
          review: { score: 0.79, rationale: 'Review was adequate.' },
        },
      });

      const result = await withMockSession(() =>
        evaluateTask(
          {
            taskPrompt: 'Scalar-only judge payload',
            prReviewOutput: 'Clean',
          },
          undefined,
          { _callFn: mockCallFn(validResponse) }
        )
      );

      for (const stage of Object.values(result.metadata.stageScores)) {
        assert.equal('rubricCriteria' in stage, false);
      }
      assert.equal(warn.mock.callCount(), 0);
    } finally {
      warn.mock.restore();
    }
  });

  it('preserves rubricCriteria only for stages that provide them', async () => {
    const validResponse = JSON.stringify({
      score: 0.77,
      rationale: 'Mixed old and new stage payloads were accepted.',
      interventionFlags: [],
      stageScores: {
        expansion: {
          score: 0.83,
          rationale: 'Expansion had structured evidence.',
          rubricCriteria: [
            { criterion: 'validation_readiness', score: 0.8 },
          ],
        },
        plan: { score: 0.75, rationale: 'Plan used the scalar format.' },
        implementation: { score: 0.78, rationale: 'Implementation used the scalar format.' },
        review: { score: 0.74, rationale: 'Review used the scalar format.' },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Mixed stage payload',
        prReviewOutput: 'Mostly clean',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );
    enrichEvalRecord(result, {});

    assert.deepEqual(result.stageOutcomes.expansion.rubricCriteria, [
      { criterion: 'validation_readiness', score: 0.8 },
    ]);
    assert.equal('rubricCriteria' in result.stageOutcomes.plan, false);
    assert.equal('rubricCriteria' in result.stageOutcomes.implementation, false);
    assert.equal('rubricCriteria' in result.stageOutcomes.review, false);
  });

  it('drops malformed rubricCriteria without failing the eval', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const validResponse = JSON.stringify({
        score: 0.73,
        rationale: 'Malformed per-stage criteria were ignored.',
        interventionFlags: [],
        stageScores: {
          expansion: {
            score: 0.8,
            rationale: 'Expansion had invalid criteria shape.',
            rubricCriteria: 'not an array',
          },
          plan: {
            score: 0.72,
            rationale: 'Plan had malformed criteria item.',
            rubricCriteria: [
              { score: 0.7, notes: 'Missing criterion.' },
            ],
          },
        },
      });

      const result = await withMockSession(() =>
        evaluateTask(
          {
            taskPrompt: 'Malformed criteria payload',
            prReviewOutput: 'Completed',
          },
          undefined,
          { _callFn: mockCallFn(validResponse) }
        )
      );

      assert.equal('rubricCriteria' in result.metadata.stageScores.expansion, false);
      assert.equal('rubricCriteria' in result.metadata.stageScores.plan, false);
      assert.equal(warn.mock.callCount(), 2);
    } finally {
      warn.mock.restore();
    }
  });

  it('omits planCritique when the judge does not return it', async () => {
    const validResponse = JSON.stringify({
      score: 0.8,
      rationale: 'Good execution.',
      interventionFlags: [],
      stageScores: {
        expansion: { score: 0.8, rationale: 'Adequate.' },
        plan: { score: 0.78, rationale: 'Reasonable inferred planning.' },
        implementation: { score: 0.82, rationale: 'Correct result.' },
        review: { score: 0.79, rationale: 'No major misses.' },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Task without saved plan artifact',
        prReviewOutput: 'Clean',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal('planCritique' in result.metadata, false);
  });

  it('ignores invalid planCritique dimensions gracefully', async () => {
    const validResponse = JSON.stringify({
      score: 0.73,
      rationale: 'Task completed.',
      interventionFlags: [],
      planCritique: {
        component_boundaries: {
          score: 1.2,
          rationale: 'Out of range score should invalidate the object.',
        },
        invariant_coverage: {
          score: 0.7,
          rationale: 'Valid but should be dropped with the invalid object.',
        },
        approach_soundness: {
          score: 0.75,
          rationale: 'Valid but incomplete overall object.',
        },
        missed_patches: {
          score: 0.8,
          rationale: 'Valid but incomplete overall object.',
        },
        overall: {
          score: 0.74,
          rationale: 'Valid but incomplete overall object.',
        },
      },
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Task with malformed plan critique',
        prReviewOutput: 'Completed',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    assert.equal('planCritique' in result.metadata, false);
  });

  it('throws immediately on malformed JSON response', async () => {
    const callFn = mockCallFn('not json at all');

    await assert.rejects(
      () =>
        evaluateTask(
          {
            taskPrompt: 'Do something',
            prReviewOutput: 'Did something',
          },
          undefined,
          { _callFn: callFn }
        ),
      (err) => {
        assert.ok(err.message.includes('Failed to parse JSON from LLM output'));
        return true;
      }
    );

    assert.equal(callFn.mock.callCount(), 1);
  });

  it('throws immediately on scores outside 0-1 range', async () => {
    const callFn = mockCallFn(
      JSON.stringify({ score: 1.5, rationale: 'Too high', interventionFlags: [] })
    );

    await assert.rejects(
      () =>
        evaluateTask(
          {
            taskPrompt: 'Add feature',
            prReviewOutput: 'Feature added',
          },
          undefined,
          { _callFn: callFn }
        ),
      (err) => {
        assert.ok(err.message.includes('Invalid score: 1.5'));
        return true;
      }
    );

    assert.equal(callFn.mock.callCount(), 1);
  });

  it('propagates parse error after a single attempt', async () => {
    const callFn = mockCallFn('This is not JSON at all');

    await assert.rejects(
      () =>
        evaluateTask(
          {
            taskPrompt: 'Fix a bug',
            prReviewOutput: 'Bug fixed correctly',
          },
          undefined,
          { _callFn: callFn }
        ),
      (err) => {
        assert.ok(err.message.includes('Failed to parse JSON from LLM output'));
        return true;
      }
    );

    assert.equal(callFn.mock.callCount(), 1);
  });

  it('throws immediately on CLI error (no retry)', async () => {
    const callFn = mock.fn(() => Promise.reject(new Error('claude CLI exited with code 1')));

    await assert.rejects(
      () =>
        evaluateTask(
          {
            taskPrompt: 'Do something',
            prReviewOutput: 'Did something',
          },
          undefined,
          { _callFn: callFn }
        ),
      (err) => {
        assert.ok(err.message.includes('claude CLI exited with code 1'));
        return true;
      }
    );

    // Should only have been called once — no retry on CLI errors
    assert.equal(callFn.mock.callCount(), 1);
  });

  it('includes tokenUsage from CLI JSON response', async () => {
    const validResponse = JSON.stringify({
      score: 0.85,
      rationale: 'Good work.',
      interventionFlags: [],
    });
    const usage = { inputTokens: 2000, outputTokens: 500, totalTokens: 2500 };

    const result = await evaluateTask(
      {
        taskPrompt: 'Add a feature',
        prReviewOutput: 'Clean diff',
      },
      undefined,
      { _callFn: mockCallFn(validResponse, usage) }
    );

    assert.ok(result.tokenUsage, 'should have tokenUsage');
    assert.equal(result.tokenUsage.inputTokens, 2000);
    assert.equal(result.tokenUsage.outputTokens, 500);
    assert.equal(result.tokenUsage.totalTokens, 2500);
  });

  it('includes estimatedCost when model is in pricing table', async () => {
    const validResponse = JSON.stringify({
      score: 0.9,
      rationale: 'Well done.',
      interventionFlags: [],
    });
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

    const result = await evaluateTask(
      {
        taskPrompt: 'Quick task',
        prReviewOutput: 'Good',
      },
      undefined,
      { _callFn: mockCallFn(validResponse, usage) }
    );

    // estimatedCost may be undefined if pricing table not loaded (test cwd may not have config)
    if (result.estimatedCost !== undefined) {
      assert.equal(typeof result.estimatedCost, 'number');
      assert.ok(result.estimatedCost >= 0);
    }
  });

  it('prefers CLI costUsd over pricing table estimate', async () => {
    const validResponse = JSON.stringify({
      score: 0.9,
      rationale: 'Well done.',
      interventionFlags: [],
    });
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

    const result = await evaluateTask(
      {
        taskPrompt: 'Quick task',
        prReviewOutput: 'Good',
      },
      undefined,
      { _callFn: mockCallFn(validResponse, usage, 0.03078) }
    );

    assert.equal(result.estimatedCost, 0.03078);
  });

  it('omits tokenUsage when CLI response has no usage', async () => {
    const validResponse = JSON.stringify({
      score: 0.8,
      rationale: 'Done.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Do something',
        prReviewOutput: 'Something done',
      },
      undefined,
      { _callFn: mockCallFn(validResponse, null) }
    );

    assert.equal(result.tokenUsage, undefined);
  });

  it('handles response wrapped in markdown code fences', async () => {
    const wrappedResponse =
      '```json\n' +
      JSON.stringify({
        score: 0.7,
        rationale: 'Decent execution with fenced response.',
        interventionFlags: ['minor-style-issue'],
      }) +
      '\n```';

    const result = await evaluateTask(
      {
        taskPrompt: 'Refactor module',
        prReviewOutput: 'Refactoring looks good',
      },
      undefined,
      { _callFn: mockCallFn(wrappedResponse) }
    );

    assert.equal(result.score, 0.7);
    assert.equal(result.rationale, 'Decent execution with fenced response.');
    assert.equal(result.scoreBand, 'Assisted Success');
  });

  it('includes promptArtifacts with eval-judge template metadata', async () => {
    const validResponse = JSON.stringify({
      score: 0.9,
      rationale: 'Excellent work.',
      interventionFlags: [],
    });

    const result = await evaluateTask(
      {
        taskPrompt: 'Add authentication',
        prReviewOutput: 'Auth implementation complete',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    // Should have promptArtifacts array
    assert.ok(result.promptArtifacts, 'should have promptArtifacts field');
    assert.ok(Array.isArray(result.promptArtifacts), 'promptArtifacts should be an array');
    assert.equal(result.promptArtifacts.length, 1, 'should have one artifact (eval-judge)');

    const artifact = result.promptArtifacts[0];
    assert.equal(artifact.templateName, 'eval-judge', 'template name should be eval-judge');
    assert.ok(artifact.templateHash, 'should have templateHash');
    assert.equal(artifact.templateHash.length, 64, 'templateHash should be SHA-256 hex (64 chars)');
    assert.ok(artifact.filledPromptHash, 'should have filledPromptHash');
    assert.equal(artifact.filledPromptHash.length, 64, 'filledPromptHash should be SHA-256 hex (64 chars)');

    // Template hash and filled prompt hash should be different
    assert.notEqual(artifact.templateHash, artifact.filledPromptHash,
      'template hash should differ from filled prompt hash');
  });

  it('promptArtifacts hashes are deterministic', async () => {
    const validResponse = JSON.stringify({
      score: 0.95,
      rationale: 'Great work.',
      interventionFlags: [],
    });

    // Call evaluateTask twice with same inputs
    const result1 = await evaluateTask(
      {
        taskPrompt: 'Same task prompt',
        prReviewOutput: 'Same review output',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    const result2 = await evaluateTask(
      {
        taskPrompt: 'Same task prompt',
        prReviewOutput: 'Same review output',
      },
      undefined,
      { _callFn: mockCallFn(validResponse) }
    );

    // Template hashes should be identical (same template file)
    assert.equal(
      result1.promptArtifacts[0].templateHash,
      result2.promptArtifacts[0].templateHash,
      'template hash should be deterministic'
    );

    // Filled prompt hashes should be identical (same inputs)
    assert.equal(
      result1.promptArtifacts[0].filledPromptHash,
      result2.promptArtifacts[0].filledPromptHash,
      'filled prompt hash should be deterministic for same inputs'
    );
  });

  it('fast-fails oversized prompts without calling the judge', async () => {
    const callFn = mockCallFn(JSON.stringify({
      score: 1,
      rationale: 'Should not be called.',
      interventionFlags: [],
    }));
    const warn = mock.method(console, 'warn', () => {});
    try {
      const result = await evaluateTask(
        {
          taskPrompt: 'Oversized eval prompt task',
          prReviewOutput: 'x'.repeat(30_000),
          issueId: 'HOK-1706',
        },
        undefined,
        {
          _callFn: callFn,
          _promptSizeConfig: { maxPromptBytes: 25_000, oversizePolicy: 'fail' },
        }
      );

      assert.equal(callFn.mock.callCount(), 0);
      assert.equal(result.score, 0);
      assert.equal(result.scoreBand, 'Failure');
      assert.equal(result.failureReason, 'eval_prompt_too_large');
      assert.equal(result.promptSizeDiagnostic.action, 'rejected');
      assert.equal(result.promptSizeDiagnostic.policy, 'fail');
      assert.ok(result.promptSizeDiagnostic.perComponentBytes.prReviewOutput >= 30_000);
    } finally {
      warn.mock.restore();
    }
  });

  it('truncates oversized prompts before calling the judge when configured', async () => {
    const validResponse = JSON.stringify({
      score: 0.8,
      rationale: 'Prompt was truncated and evaluated.',
      interventionFlags: [],
    });
    const callFn = mockCallFn(validResponse);
    const warn = mock.method(console, 'warn', () => {});
    try {
      const result = await evaluateTask(
        {
          taskPrompt: 'Truncate oversized eval prompt',
          prReviewOutput: 'x'.repeat(30_000),
        },
        undefined,
        {
          _callFn: callFn,
          _promptSizeConfig: { maxPromptBytes: 25_000, oversizePolicy: 'truncate' },
        }
      );

      assert.equal(callFn.mock.callCount(), 1);
      const sentPrompt = callFn.mock.calls[0].arguments[0];
      assert.ok(Buffer.byteLength(sentPrompt, 'utf8') <= 25_000);
      assert.match(sentPrompt, /TRUNCATED \d+ bytes from prReviewOutput/);
      assert.equal(result.promptSizeDiagnostic.action, 'truncated');
      assert.equal(result.failureReason, undefined);
    } finally {
      warn.mock.restore();
    }
  });

  it('attaches pass diagnostics for under-limit prompts and logs the size', async () => {
    const validResponse = JSON.stringify({
      score: 0.9,
      rationale: 'Under limit.',
      interventionFlags: [],
    });
    const callFn = mockCallFn(validResponse);
    const log = mock.method(console, 'log', () => {});
    try {
      const result = await evaluateTask(
        {
          taskPrompt: 'Small eval prompt',
          prReviewOutput: 'Clean diff',
        },
        undefined,
        {
          _callFn: callFn,
          _promptSizeConfig: { maxPromptBytes: 80_000, oversizePolicy: 'fail' },
        }
      );

      assert.equal(callFn.mock.callCount(), 1);
      assert.equal(result.promptSizeDiagnostic.action, 'pass');
      assert.equal(log.mock.callCount(), 1);
      assert.match(log.mock.calls[0].arguments[0], /^\[eval\] prompt_size /);
    } finally {
      log.mock.restore();
    }
  });
});
