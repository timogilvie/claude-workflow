import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregateEvalHistory, resolveAgent } from './model-router.ts';

describe('model-router resolveAgent', () => {
  it('routes known DeepSeek models to claude', () => {
    assert.equal(resolveAgent('deepseek-v4-pro', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('deepseek-v4-pro[1m]', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('deepseek-v4-flash', {}, 'codex'), 'claude');
  });

  it('throws for unknown DeepSeek-like models instead of falling back', () => {
    assert.throws(
      () => resolveAgent('deepseek-v4-ultra', {}, 'claude'),
      /Unknown DeepSeek model "deepseek-v4-ultra"/,
    );
  });

  it('preserves existing claude and gpt resolution heuristics', () => {
    assert.equal(resolveAgent('claude-sonnet-4-6', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('gpt-5.4', {}, 'claude'), 'codex');
  });

  it('computes success rate with the shared eval success policy', () => {
    const stats = aggregateEvalHistory([
      {
        id: 'eval-1',
        schemaVersion: '1.15.0',
        originalPrompt: 'Fix a bug in routing',
        modelId: 'gpt-5.4',
        modelVersion: 'gpt-5.4',
        score: 0.8,
        scoreBand: 'Minor Feedback',
        timeSeconds: 10,
        timestamp: '2026-05-01T00:00:00.000Z',
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'good',
      },
      {
        id: 'eval-2',
        schemaVersion: '1.15.0',
        originalPrompt: 'Fix a bug in routing',
        modelId: 'gpt-5.4',
        modelVersion: 'gpt-5.4',
        score: 0.7,
        scoreBand: 'Assisted Success',
        timeSeconds: 12,
        timestamp: '2026-05-01T00:01:00.000Z',
        interventionRequired: true,
        interventionCount: 1,
        interventionDetails: [],
        rationale: 'below threshold',
      },
    ], 'bugfix');

    assert.equal(stats[0]?.successRate, 0.5);
  });
});
