import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../model-registry.ts';
import type { ReadyNativeProviderEntry, ResolvedNativeProviderEntry } from './providers.ts';
import {
  certifyReadOnlyNativeRouting,
  partitionNativeProvidersByCertification,
  READ_ONLY_NATIVE_PHASES,
} from './read-only-routing.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(
  modelId: string,
  readOnlyNative: 'certified' | 'partial' | 'unsupported',
): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: 'test',
        class: 'strong_generalist',
        strengths: ['balanced'],
        weaknesses: ['none'],
        qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
        defaultLadderEligible: true,
        contextWindowTokens: 128_000,
        toolSupport: 'full',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 0,
        costPerMillionOutputTokensUsd: 0,
        nativeCapability: {
          nativeProvider: 'openrouter',
          piTransportKind: 'openai-completions',
          readOnlyNative,
          limitations: readOnlyNative === 'partial' ? ['missing compat flag'] : undefined,
        },
      },
    },
    ladders: {},
  };
}

function makeEmptyRegistry(): ModelRegistry {
  return { models: {}, ladders: {} };
}

function makeReadyEntry(modelId: string, provider: 'openai' | 'openrouter' = 'openrouter'): ReadyNativeProviderEntry {
  return {
    status: 'ready',
    providerName: provider,
    modelId,
    apiKeyEnv: 'TEST_API_KEY',
    baseUrl: 'https://example.com',
    headers: {},
    model: {} as never,
  };
}

function makeUnavailableEntry(modelId: string): ResolvedNativeProviderEntry {
  return {
    status: 'unavailable',
    providerName: 'openai',
    modelId,
    apiKeyEnv: 'TEST_API_KEY',
    baseUrl: 'https://example.com',
    headers: {},
    reason: 'no api key',
  };
}

function makeSkippedEntry(modelId: string): ResolvedNativeProviderEntry {
  return {
    status: 'skipped',
    providerName: 'openrouter',
    modelId,
    apiKeyEnv: 'TEST_API_KEY',
    baseUrl: 'https://example.com',
    headers: {},
    reason: 'provider disabled',
  };
}

// ---------------------------------------------------------------------------
// certifyReadOnlyNativeRouting — basic routing decisions
// ---------------------------------------------------------------------------

describe('certifyReadOnlyNativeRouting — certified model', () => {
  for (const phase of READ_ONLY_NATIVE_PHASES) {
    it(`returns routable: true for phase "${phase}"`, () => {
      const registry = makeRegistry('gpt-4o', 'certified');
      const decision = certifyReadOnlyNativeRouting('gpt-4o', {
        phase,
        purpose: 'task',
        registry,
      });
      assert.equal(decision.routable, true);
      if (!decision.routable) return;
      assert.equal(decision.modelId, 'gpt-4o');
    });
  }
});

describe('certifyReadOnlyNativeRouting — unsupported model', () => {
  it('returns routable: false with refusal naming model, phase, and capability', () => {
    const registry = makeRegistry('bad-model', 'unsupported');
    const decision = certifyReadOnlyNativeRouting('bad-model', {
      phase: 'planning',
      purpose: 'task',
      registry,
    });

    assert.equal(decision.routable, false);
    if (decision.routable) return;
    assert.equal(decision.evaluable, false);
    assert.equal(decision.refusal.modelId, 'bad-model');
    assert.equal(decision.refusal.phase, 'planning');
    assert.equal(decision.refusal.requiredCertification, 'certified');
    assert.equal(decision.refusal.actualCapability, 'unsupported');
    assert.match(decision.refusal.message, /bad-model/);
    assert.match(decision.refusal.message, /planning/);
    assert.match(decision.refusal.message, /unsupported/);
  });
});

describe('certifyReadOnlyNativeRouting — unregistered model', () => {
  it('returns routable: false with actualCapability "unregistered" and actionable message', () => {
    const decision = certifyReadOnlyNativeRouting('unknown-model', {
      phase: 'expansion',
      purpose: 'task',
      registry: makeEmptyRegistry(),
    });

    assert.equal(decision.routable, false);
    if (decision.routable) return;
    assert.equal(decision.evaluable, false);
    assert.equal(decision.refusal.actualCapability, 'unregistered');
    assert.match(decision.refusal.message, /unknown-model/);
    assert.match(decision.refusal.message, /expansion/);
    assert.match(decision.refusal.message, /not registered/);
    assert.match(decision.refusal.message, /certified/);
  });
});

describe('certifyReadOnlyNativeRouting — partial model', () => {
  it('returns routable: false without allowPartial', () => {
    const registry = makeRegistry('partial-model', 'partial');
    const decision = certifyReadOnlyNativeRouting('partial-model', {
      phase: 'read-only-review',
      purpose: 'task',
      registry,
    });

    assert.equal(decision.routable, false);
    if (decision.routable) return;
    assert.equal(decision.evaluable, false);
    assert.equal(decision.refusal.actualCapability, 'partial');
    assert.match(decision.refusal.message, /partial-model/);
    assert.match(decision.refusal.message, /read-only-review/);
    assert.match(decision.refusal.message, /partial/);
  });

  it('returns routable: true with allowPartial: true', () => {
    const registry = makeRegistry('partial-model', 'partial');
    const decision = certifyReadOnlyNativeRouting('partial-model', {
      phase: 'planning',
      purpose: 'task',
      registry,
      allowPartial: true,
    });

    assert.equal(decision.routable, true);
    if (!decision.routable) return;
    assert.equal(decision.modelId, 'partial-model');
  });
});

describe('certifyReadOnlyNativeRouting — certification purpose', () => {
  it('always returns routable: false, evaluable: true for uncertified models', () => {
    const registry = makeRegistry('candidate-model', 'unsupported');
    const decision = certifyReadOnlyNativeRouting('candidate-model', {
      phase: 'planning',
      purpose: 'certification',
      registry,
    });

    assert.equal(decision.routable, false);
    if (decision.routable) return;
    assert.equal(decision.evaluable, true);
    assert.equal(decision.refusal.modelId, 'candidate-model');
  });

  it('returns routable: false, evaluable: true even for unregistered models', () => {
    const decision = certifyReadOnlyNativeRouting('unregistered-candidate', {
      phase: 'expansion',
      purpose: 'certification',
      registry: makeEmptyRegistry(),
    });

    assert.equal(decision.routable, false);
    if (decision.routable) return;
    assert.equal(decision.evaluable, true);
  });
});

describe('certifyReadOnlyNativeRouting — provider field', () => {
  it('includes provider in refusal when supplied', () => {
    const decision = certifyReadOnlyNativeRouting('unknown-model', {
      phase: 'planning',
      purpose: 'task',
      registry: makeEmptyRegistry(),
      provider: 'openai',
    });

    assert.equal(decision.routable, false);
    if (decision.routable) return;
    assert.equal(decision.refusal.provider, 'openai');
  });

  it('omits provider from refusal when not supplied', () => {
    const decision = certifyReadOnlyNativeRouting('unknown-model', {
      phase: 'planning',
      purpose: 'task',
      registry: makeEmptyRegistry(),
    });

    assert.equal(decision.routable, false);
    if (decision.routable) return;
    assert.equal(decision.refusal.provider, undefined);
  });
});

// ---------------------------------------------------------------------------
// partitionNativeProvidersByCertification
// ---------------------------------------------------------------------------

describe('partitionNativeProvidersByCertification', () => {
  it('splits certified ready entries into routable', () => {
    const registry = makeRegistry('gpt-4o', 'certified');
    const entries: ResolvedNativeProviderEntry[] = [makeReadyEntry('gpt-4o')];

    const { routable, refused } = partitionNativeProvidersByCertification(entries, {
      phase: 'planning',
      registry,
    });

    assert.equal(routable.length, 1);
    assert.equal(routable[0]?.modelId, 'gpt-4o');
    assert.equal(refused.length, 0);
  });

  it('moves uncertified ready entries to refused', () => {
    const registry = makeRegistry('bad-model', 'unsupported');
    const entries: ResolvedNativeProviderEntry[] = [makeReadyEntry('bad-model')];

    const { routable, refused } = partitionNativeProvidersByCertification(entries, {
      phase: 'expansion',
      registry,
    });

    assert.equal(routable.length, 0);
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.modelId, 'bad-model');
    assert.equal(refused[0]?.phase, 'expansion');
  });

  it('excludes unavailable entries from both routable and refused', () => {
    const registry = makeRegistry('gpt-4o', 'certified');
    const entries: ResolvedNativeProviderEntry[] = [makeUnavailableEntry('gpt-4o')];

    const { routable, refused } = partitionNativeProvidersByCertification(entries, {
      phase: 'planning',
      registry,
    });

    assert.equal(routable.length, 0);
    assert.equal(refused.length, 0);
  });

  it('excludes skipped entries from both routable and refused', () => {
    const registry = makeRegistry('gpt-4o', 'certified');
    const entries: ResolvedNativeProviderEntry[] = [makeSkippedEntry('gpt-4o')];

    const { routable, refused } = partitionNativeProvidersByCertification(entries, {
      phase: 'planning',
      registry,
    });

    assert.equal(routable.length, 0);
    assert.equal(refused.length, 0);
  });

  it('handles mixed entries: certified routable, uncertified refused, non-ready excluded', () => {
    const registry: ModelRegistry = {
      models: {
        'gpt-4o': {
          ...makeRegistry('gpt-4o', 'certified').models['gpt-4o']!,
        },
        'bad-model': {
          ...makeRegistry('bad-model', 'unsupported').models['bad-model']!,
        },
      },
      ladders: {},
    };

    const entries: ResolvedNativeProviderEntry[] = [
      makeReadyEntry('gpt-4o', 'openai'),
      makeReadyEntry('bad-model', 'openrouter'),
      makeUnavailableEntry('skipped-model'),
      makeSkippedEntry('another-skipped'),
    ];

    const { routable, refused } = partitionNativeProvidersByCertification(entries, {
      phase: 'read-only-review',
      registry,
    });

    assert.equal(routable.length, 1);
    assert.equal(routable[0]?.modelId, 'gpt-4o');
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.modelId, 'bad-model');
    assert.equal(refused[0]?.phase, 'read-only-review');
  });

  it('preserves ordering of routable entries', () => {
    const registry: ModelRegistry = {
      models: {
        'model-a': { ...makeRegistry('model-a', 'certified').models['model-a']! },
        'model-b': { ...makeRegistry('model-b', 'certified').models['model-b']! },
        'model-c': { ...makeRegistry('model-c', 'certified').models['model-c']! },
      },
      ladders: {},
    };

    const entries: ResolvedNativeProviderEntry[] = [
      makeReadyEntry('model-a'),
      makeReadyEntry('model-b'),
      makeReadyEntry('model-c'),
    ];

    const { routable } = partitionNativeProvidersByCertification(entries, {
      phase: 'planning',
      registry,
    });

    assert.deepEqual(routable.map((e) => e.modelId), ['model-a', 'model-b', 'model-c']);
  });

  it('routes partial models when allowPartial is true', () => {
    const registry = makeRegistry('partial-model', 'partial');
    const entries: ResolvedNativeProviderEntry[] = [makeReadyEntry('partial-model')];

    const { routable, refused } = partitionNativeProvidersByCertification(entries, {
      phase: 'planning',
      registry,
      allowPartial: true,
    });

    assert.equal(routable.length, 1);
    assert.equal(refused.length, 0);
  });

  it('refuses partial models when allowPartial is not set', () => {
    const registry = makeRegistry('partial-model', 'partial');
    const entries: ResolvedNativeProviderEntry[] = [makeReadyEntry('partial-model')];

    const { routable, refused } = partitionNativeProvidersByCertification(entries, {
      phase: 'expansion',
      registry,
    });

    assert.equal(routable.length, 0);
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.actualCapability, 'partial');
  });

  it('handles empty entry list', () => {
    const { routable, refused } = partitionNativeProvidersByCertification([], {
      phase: 'planning',
      registry: makeEmptyRegistry(),
    });

    assert.equal(routable.length, 0);
    assert.equal(refused.length, 0);
  });
});
