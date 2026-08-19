import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../model-registry.ts';
import {
  CONTEXT_WINDOW_SAFETY_MARGIN,
  ContextWindowExceededError,
  assertPromptFitsContextWindow,
  estimatePromptTokens,
  evaluateContextWindow,
  resolveContextWindowLimit,
} from './context-window-guard.ts';

function textForTokens(tokens: number): string {
  return 'x'.repeat(tokens * 4);
}

function registry(modelId: string, contextWindowTokens: number): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: 'test',
        class: 'strong_generalist',
        strengths: ['balanced'],
        weaknesses: ['none'],
        qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
        defaultLadderEligible: true,
        contextWindowTokens,
        toolSupport: 'full',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 0,
        costPerMillionOutputTokensUsd: 0,
      },
    },
    ladders: {},
  };
}

describe('context-window guard', () => {
  it('estimates system prompt, message block content, tool-call arguments, tool results, and schemas', () => {
    const estimate = estimatePromptTokens({
      systemPrompt: textForTokens(10),
      messages: [
        { role: 'user', content: textForTokens(5), timestamp: 0 },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: textForTokens(3) },
            { type: 'thinking', thinking: textForTokens(2) },
            { type: 'tool_call', name: 'run', arguments: { command: textForTokens(4) } },
          ],
        },
        {
          role: 'toolResult',
          content: [{ type: 'text', text: textForTokens(6) }],
        },
      ],
      tools: [{
        name: 'run',
        description: textForTokens(8),
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      }],
    });

    assert.equal(estimate.systemPromptTokens, 10);
    assert.ok(estimate.messageTokens >= 5 + 3 + 2 + 4 + 6 + (3 * 4));
    assert.ok(estimate.toolTokens > 8);
    assert.equal(estimate.inputTokens, estimate.systemPromptTokens + estimate.messageTokens + estimate.toolTokens);
    assert.deepEqual(estimatePromptTokens({ messages: [] }), {
      systemPromptTokens: 0,
      messageTokens: 0,
      toolTokens: 0,
      inputTokens: 0,
    });
  });

  it('includes reserved output in the context-window boundary', () => {
    const limit = { limit: 10_000, source: 'model' as const };
    const exact = estimatePromptTokens({ systemPrompt: textForTokens(7_000), messages: [] });
    const oneOver = estimatePromptTokens({ systemPrompt: textForTokens(7_001), messages: [] });

    assert.equal(
      evaluateContextWindow({
        model: { id: 'm', provider: 'test' },
        limit,
        estimate: exact,
        reservedOutputTokens: 3_000,
        safetyMargin: 0,
      }).ok,
      true,
    );

    const overflow = evaluateContextWindow({
      model: { id: 'm', provider: 'test' },
      limit,
      estimate: oneOver,
      reservedOutputTokens: 3_000,
      safetyMargin: 0,
    });
    assert.equal(overflow.ok, false);

    assert.equal(
      evaluateContextWindow({
        model: { id: 'm', provider: 'test' },
        limit,
        estimate: estimatePromptTokens({ systemPrompt: textForTokens(9_999), messages: [] }),
        reservedOutputTokens: 0,
        safetyMargin: 0,
      }).ok,
      true,
    );
  });

  it('rejects the incident shape even though input alone fits', () => {
    const estimate = estimatePromptTokens({ systemPrompt: textForTokens(98_414), messages: [] });
    const verdict = evaluateContextWindow({
      phase: 'coding',
      model: { id: 'openrouter:kimi-k2', name: 'moonshotai/kimi-k2', provider: 'openrouter' },
      limit: { limit: 131_072, source: 'registry', registryModelId: 'moonshotai/kimi-k2' },
      estimate,
      reservedOutputTokens: 32_768,
      safetyMargin: 0,
    });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.diagnostic.projectedTotalTokens, 131_182);
    if (!verdict.ok) {
      assert.match(verdict.message, /moonshotai\/kimi-k2/);
      assert.match(verdict.message, /openrouter/);
      assert.match(verdict.message, /131072/);
      assert.match(verdict.message, /131182/);
      assert.match(verdict.message, /context window/);
      assert.match(verdict.message, /context_length_exceeded/);
    }
  });

  it('applies the default margin to input tokens only', () => {
    const limit = { limit: 10_000, source: 'model' as const };
    assert.equal(
      evaluateContextWindow({
        model: { id: 'm', provider: 'test' },
        limit,
        estimate: estimatePromptTokens({ systemPrompt: textForTokens(9_500), messages: [] }),
        reservedOutputTokens: 0,
      }).ok,
      false,
    );
    assert.equal(
      evaluateContextWindow({
        model: { id: 'm', provider: 'test' },
        limit,
        estimate: estimatePromptTokens({ systemPrompt: textForTokens(9_000), messages: [] }),
        reservedOutputTokens: 0,
      }).ok,
      true,
    );
    assert.equal(CONTEXT_WINDOW_SAFETY_MARGIN, 0.10);
  });

  it('resolves registry limits before model config limits', () => {
    const r = registry('moonshotai/kimi-k2', 131_072);
    assert.deepEqual(
      resolveContextWindowLimit(
        { id: 'openrouter:kimi-k2', name: 'moonshotai/kimi-k2', provider: 'openrouter', contextWindow: 200_000 },
        r,
      ),
      { limit: 131_072, source: 'registry', registryModelId: 'moonshotai/kimi-k2' },
    );
    assert.deepEqual(
      resolveContextWindowLimit({ id: 'openrouter:moonshotai/kimi-k2', provider: 'openrouter' }, r),
      { limit: 131_072, source: 'registry', registryModelId: 'moonshotai/kimi-k2' },
    );
    assert.deepEqual(
      resolveContextWindowLimit({ id: 'unregistered', provider: 'test', contextWindow: 42_000 }, r),
      { limit: 42_000, source: 'model' },
    );
    assert.equal(resolveContextWindowLimit({ id: 'unregistered', provider: 'test' }, r), undefined);
  });

  it('throws typed overflow errors and skips unknown non-native limits', () => {
    assert.throws(
      () => assertPromptFitsContextWindow({
        phase: 'coding',
        model: { id: 'small', provider: 'test', contextWindow: 100 },
        context: { systemPrompt: textForTokens(101), messages: [] },
        reservedOutputTokens: 0,
        safetyMargin: 0,
      }),
      (error) => {
        assert.ok(error instanceof ContextWindowExceededError);
        assert.equal(error.diagnostic.limit, 100);
        assert.equal(error.diagnostic.estimate.systemPromptTokens, 101);
        return true;
      },
    );

    assert.equal(
      assertPromptFitsContextWindow({
        phase: 'coding',
        model: { id: 'large', provider: 'test', contextWindow: 1_000 },
        context: { systemPrompt: textForTokens(100), messages: [] },
        reservedOutputTokens: 0,
        safetyMargin: 0,
      }).ok,
      true,
    );

    assert.deepEqual(
      assertPromptFitsContextWindow({
        phase: 'coding',
        model: { id: 'unknown', provider: 'scripted-test-provider' },
        context: { messages: [] },
        reservedOutputTokens: 0,
        registry: { models: {}, ladders: {} },
      }),
      { ok: true, skipped: 'unknown-limit' },
    );
  });
});
