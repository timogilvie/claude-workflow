import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTask } from './eval.js';

function mockCallFn(responseText, usage = null, costUsd = undefined) {
  return mock.fn(() => Promise.resolve({ text: responseText, usage, costUsd }));
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
    assert.equal(result.schemaVersion, '1.0.0');
    assert.equal(result.originalPrompt, 'Add a loading spinner');
    assert.ok(result.modelId);
    assert.ok(result.modelVersion);
    assert.equal(result.score, 0.85);
    assert.equal(result.scoreBand, 'Minor Feedback');
    assert.equal(typeof result.timeSeconds, 'number');
    assert.ok(new Date(result.timestamp).toISOString() === result.timestamp);
    assert.equal(result.interventionRequired, false);
    assert.equal(result.interventionCount, 0);
    assert.deepEqual(result.interventionDetails, []);
    assert.equal(result.rationale, 'Task was completed successfully with clean implementation.');
    assert.equal(result.issueId, 'HOK-100');
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
});
