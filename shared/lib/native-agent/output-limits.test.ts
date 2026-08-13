import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '@earendil-works/pi-ai';
import { registerScriptedPiProvider, type ScriptedProviderContext } from './provider.ts';
import { runWavemillLoop, resolveMaxOutputTokens } from './loop.ts';
import {
  CODING_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  REVIEW_MAX_OUTPUT_TOKENS,
} from './output-limits.ts';

let apiSeq = 0;
function uniqueApi(): string {
  return `output-limits-test-${++apiSeq}`;
}

const piIdentity = (messages: any[]): Message[] => messages as Message[];

/**
 * Register a scripted provider that records the stream options Pi received,
 * then run a single-turn loop against it.
 */
async function observedMaxTokens(
  overrides: { maxTokens?: number; modelMaxTokens?: number } = {},
): Promise<unknown> {
  const api = uniqueApi();
  const seen: ScriptedProviderContext[] = [];
  registerScriptedPiProvider({
    api,
    turns: (context) => {
      seen.push(context);
      return { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' };
    },
  });

  await runWavemillLoop({
    model: {
      id: 'test-model',
      api,
      provider: 'test-provider',
      ...(overrides.modelMaxTokens !== undefined ? { maxTokens: overrides.modelMaxTokens } : {}),
    },
    context: {
      systemPrompt: 'You are a test agent.',
      messages: [{ role: 'user' as const, content: 'Go.', timestamp: 0 }],
      tools: [],
    },
    convertToLlm: piIdentity,
    ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
  });

  assert.equal(seen.length, 1, 'scripted provider must observe exactly one turn');
  return seen[0]?.options?.maxTokens;
}

describe('native output ceilings', () => {
  // Regression: an undefined ceiling makes Pi omit `max_tokens` entirely, and
  // OpenRouter then pre-authorizes the endpoint's full max completion length
  // against the account balance (402 "You requested up to 65536 tokens").
  it('always sends an explicit maxTokens when the caller omits one', async () => {
    assert.equal(await observedMaxTokens(), DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it('prefers an explicit caller ceiling', async () => {
    assert.equal(await observedMaxTokens({ maxTokens: CODING_MAX_OUTPUT_TOKENS }), CODING_MAX_OUTPUT_TOKENS);
  });

  it('falls back to the model ceiling before the default', async () => {
    assert.equal(await observedMaxTokens({ modelMaxTokens: 4096 }), 4096);
  });

  it('lets the caller ceiling override the model ceiling', async () => {
    assert.equal(
      await observedMaxTokens({ maxTokens: REVIEW_MAX_OUTPUT_TOKENS, modelMaxTokens: 4096 }),
      REVIEW_MAX_OUTPUT_TOKENS,
    );
  });
});

describe('resolveMaxOutputTokens', () => {
  const model = { id: 'm', api: 'a', provider: 'p' };

  it('resolves the precedence chain without ever returning undefined', () => {
    assert.equal(resolveMaxOutputTokens({ model }), DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal(resolveMaxOutputTokens({ model: { ...model, maxTokens: 4096 } }), 4096);
    assert.equal(resolveMaxOutputTokens({ model, maxTokens: 1234 }), 1234);
  });

  it('keeps phase ceilings ordered review <= default <= coding', () => {
    assert.ok(REVIEW_MAX_OUTPUT_TOKENS <= DEFAULT_MAX_OUTPUT_TOKENS);
    assert.ok(DEFAULT_MAX_OUTPUT_TOKENS <= CODING_MAX_OUTPUT_TOKENS);
  });
});
