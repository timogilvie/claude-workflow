import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAgent } from './model-router.ts';

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
});
