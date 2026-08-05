import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelRegistry } from './model-registry.ts';
import { resolveModelAgent } from './model-agent-resolution.ts';

function makeRegistry(modelId: string, model: ModelRegistry['models'][string]): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: 'test',
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 70, planning: 70, coding: 70, review: 70, classify: 70 },
        contextWindowTokens: 128_000,
        toolSupport: 'basic',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 2,
        ...model,
      },
    },
    ladders: {},
  };
}

describe('resolveModelAgent', () => {
  it('rejects openrouter aliases without native capability metadata', () => {
    const registry = makeRegistry('legacy-openrouter-model', {
      agent: 'claude-openrouter',
    });
    const result = resolveModelAgent({
      model: 'legacy-openrouter-model',
      phase: 'planning',
      registry,
    });

    assert.deepEqual(result.ok, false);
    if (result.ok) {
      assert.fail('expected rejection');
    }
    assert.equal(result.reason, 'no-native-capability');
    assert.match(result.diagnostic, /legacy-openrouter-model/);
    assert.match(result.diagnostic, /phase=planning/);
    assert.match(result.diagnostic, /provider=openrouter/);
  });

  it('rejects unknown models instead of routing by prefix', () => {
    const result = resolveModelAgent({
      model: 'gpt-99-turbo',
      phase: 'coding',
    });

    assert.deepEqual(result, {
      ok: false,
      reason: 'unknown-model',
      diagnostic: result.ok ? '' : result.diagnostic,
    });
  });

  it('rejects invalid model ids without throwing', () => {
    for (const model of ['', '   ', 'mistral; rm -rf /']) {
      const result = resolveModelAgent({ model, phase: 'review' });
      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail('expected invalid model id rejection');
      }
      assert.equal(result.reason, 'invalid-model-id');
    }
  });

  it('resolves hosted claude models to claude', () => {
    const result = resolveModelAgent({
      model: 'claude-sonnet-5',
      phase: 'coding',
    });
    assert.deepEqual(result, { ok: true, agent: 'claude' });
  });

  it('keeps Anthropic models on the Claude harness despite a native override', () => {
    const registry = makeRegistry('anthropic-misconfigured', {
      vendor: 'anthropic',
      agent: 'native-openrouter',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: '2099-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
    });

    assert.deepEqual(
      resolveModelAgent({ model: 'anthropic-misconfigured', phase: 'planning', registry }),
      { ok: true, agent: 'claude' },
    );
  });

  it('resolves hosted gpt models to codex', () => {
    const result = resolveModelAgent({
      model: 'gpt-5.5',
      phase: 'review',
    });
    assert.deepEqual(result, { ok: true, agent: 'codex' });
  });

  it('routes the GPT-5.6 Terra Codex replacement and rejects retired GPT-5.4 launches', () => {
    assert.deepEqual(
      resolveModelAgent({ model: 'gpt-5.6-terra', phase: 'coding' }),
      { ok: true, agent: 'codex' },
    );
    const retired = resolveModelAgent({ model: 'gpt-5.4', phase: 'coding' });
    assert.equal(retired.ok, false);
    if (retired.ok) assert.fail('expected retired model rejection');
    assert.equal(retired.reason, 'codex-chatgpt-ineligible');
    assert.match(retired.diagnostic, /gpt-5\.6-terra/);
  });

  it('rejects GPT models not certified for the ChatGPT Codex surface', () => {
    for (const model of ['gpt-5', 'gpt-5-mini']) {
      const result = resolveModelAgent({ model, phase: 'coding' });
      assert.equal(result.ok, false);
      if (result.ok) assert.fail('expected rejection');
      assert.equal(result.reason, 'codex-chatgpt-ineligible');
      assert.match(result.diagnostic, new RegExp(`model=${model}`));
      assert.match(result.diagnostic, /surface=codex-chatgpt/);
      assert.match(result.diagnostic, /source=modelRegistry/);
    }
  });

  it('resolves certified role-eligible claude-openrouter models to native-openrouter', () => {
    const registry = makeRegistry('qwen-3-coder', {
      agent: 'claude-openrouter',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: '2099-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
    });

    const result = resolveModelAgent({
      model: 'qwen-3-coder',
      phase: 'review',
      registry,
      now: new Date('2098-01-01T00:00:00.000Z'),
    });

    assert.deepEqual(result, { ok: true, agent: 'native-openrouter' });
  });

  it('rejects launch-priority models that are not eligible for the requested phase', () => {
    const registry = makeRegistry('qwen-3-coder', {
      agent: 'claude-openrouter',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: '2099-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
    });

    const result = resolveModelAgent({
      model: 'qwen-3-coder',
      phase: 'planning',
      registry,
      now: new Date('2098-01-01T00:00:00.000Z'),
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail('expected rejection');
    }
    assert.equal(result.reason, 'role-ineligible');
    assert.match(result.diagnostic, /phase=planning/);
    assert.match(result.diagnostic, /certification=eligible-roles:coding,review/);
  });

  it('rejects stale or phase-insufficient native metadata as uncertified', () => {
    const registry = makeRegistry('native-plan-model', {
      agent: 'claude-openrouter',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'read-only',
          certifiedAt: '2025-01-01T00:00:00.000Z',
          certificationSuiteVersion: 'v1',
        },
      },
    });

    const stale = resolveModelAgent({
      model: 'native-plan-model',
      phase: 'planning',
      registry,
      now: new Date('2026-07-01T00:00:00.000Z'),
    });
    assert.equal(stale.ok, false);
    if (stale.ok) {
      assert.fail('expected rejection');
    }
    assert.equal(stale.reason, 'uncertified');
    assert.match(stale.diagnostic, /provider=openrouter/);
    assert.match(stale.diagnostic, /certification=stale|certification=phase-insufficient/);

    const phaseInsufficient = resolveModelAgent({
      model: 'native-plan-model',
      phase: 'planning',
      registry: makeRegistry('native-plan-model', {
        agent: 'claude-openrouter',
        nativeCapability: {
          nativeProvider: 'openrouter',
          piTransportKind: 'openai-completions',
          readOnlyNative: 'certified',
          compatFlags: { thinkingFormat: 'openrouter' },
          certification: {
            maxCertifiedPhase: 'read-only',
            certifiedAt: '2099-01-01T00:00:00.000Z',
            certificationSuiteVersion: 'v1',
          },
        },
      }),
      now: new Date('2098-01-01T00:00:00.000Z'),
    });
    assert.equal(phaseInsufficient.ok, false);
    if (phaseInsufficient.ok) {
      assert.fail('expected rejection');
    }
    assert.equal(phaseInsufficient.reason, 'uncertified');
    assert.match(phaseInsufficient.diagnostic, /certification=phase-insufficient/);
    assert.match(phaseInsufficient.diagnostic, /native-agent-certify\.ts --provider openrouter --model native-plan-model --phase workflow/);
  });
});
