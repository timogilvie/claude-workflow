import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelRegistry } from './model-registry.ts';
import {
  assertNativeReadOnlyRoutable,
  assertRegistryConsistency,
  CHANNELS,
  compareLatencyTier,
  deriveReadOnlyNativeCapability,
  evaluateCapabilityConstraints,
  evaluateRegistryPhaseEligibility,
  evaluateNativeReadOnlyRouting,
  FAMILY_ALIASES,
  explainModelSupportExclusion,
  getConfiguredModelsForDescriptor,
  getConfiguredModelsForDescriptorStage,
  configuredDeepSeekModelIds,
  DEFAULT_MODEL_REGISTRY,
  getEffectiveRegistry,
  getLadder,
  getModel,
  hasSufficientContextWindow,
  getStageContextWindowFloor,
  STAGE_CONTEXT_WINDOW_FLOORS,
  getRequiredCertificationPhaseForStage,
  isKnownModelId,
  isReadOnlyNativeCapable,
  mergeModelRegistry,
  ModelResolutionError,
  ModelValidationError,
  NativeReadOnlyCertificationError,
  normalizeReviewerModelId,
  parseModelSelector,
  rankCandidates,
  REVIEWER_ALIAS_MAP,
  resolveProviderNativeModelId,
  resolveSelector,
  listSupportedModelsForStage,
  satisfiesCapabilities,
  stageRequiresTools,
  hasSufficientToolSupport,
  validateNativeCapability,
  validateModelId,
} from './model-registry.ts';
import { resolveOpenRouterModelId } from './openrouter-provider.ts';
import { clearConfigCache } from './config.ts';
import { filterDisabledModels } from './disabled-models.ts';
import {
  ModelPolicyResolutionError,
  resolveSelectorWithPolicy,
} from './model-resolution-policy.ts';
import type { QuotaSnapshot, QuotaStatus } from './quota-state.ts';

type TaskType = 'routing' | 'planning' | 'coding' | 'review' | 'classify';
type ToolSupport = 'none' | 'basic' | 'full';
type LatencyTier = 'fast' | 'standard' | 'slow';
type ReasoningTier = 'basic' | 'standard' | 'advanced';

const TOOL_SUPPORT_VALUES = new Set<ToolSupport>(['none', 'basic', 'full']);
const LATENCY_TIER_VALUES = new Set<LatencyTier>(['fast', 'standard', 'slow']);
const REASONING_TIER_VALUES = new Set<ReasoningTier>(['basic', 'standard', 'advanced']);

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'model-registry-test-'));
}

function cleanUp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function writeConfig(repoDir: string, config: unknown): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
}

function makeScores(value: number): Record<TaskType, number> {
  return {
    routing: value,
    planning: value,
    coding: value,
    review: value,
    classify: value,
  };
}

function makeCapabilities(
  overrides: Partial<ModelRegistry['models'][string]> & {
    qualityScores?: Partial<Record<TaskType, number>>;
  } = {},
): ModelRegistry['models'][string] {
  return {
    vendor: overrides.vendor ?? 'test',
    class: overrides.class ?? 'strong_generalist',
    strengths: overrides.strengths ? [...overrides.strengths] : ['balanced'],
    weaknesses: overrides.weaknesses ? [...overrides.weaknesses] : ['none'],
    qualityScores: {
      ...makeScores(0),
      ...overrides.qualityScores,
    },
    pricing: overrides.pricing ? { ...overrides.pricing } : undefined,
    defaultLadderEligible: overrides.defaultLadderEligible ?? true,
    contextWindowTokens: overrides.contextWindowTokens ?? 128_000,
    toolSupport: overrides.toolSupport ?? 'full',
    multimodal: overrides.multimodal ? { ...overrides.multimodal } : { text: true, image: false },
    latencyTier: overrides.latencyTier ?? 'standard',
    reasoningTier: overrides.reasoningTier ?? 'standard',
    costPerMillionInputTokensUsd: overrides.costPerMillionInputTokensUsd ?? 1,
    costPerMillionOutputTokensUsd: overrides.costPerMillionOutputTokensUsd ?? 2,
    agent: overrides.agent,
    nativeCapability: overrides.nativeCapability
      ? {
        nativeProvider: overrides.nativeCapability.nativeProvider!,
        piTransportKind: overrides.nativeCapability.piTransportKind!,
        readOnlyNative: overrides.nativeCapability.readOnlyNative!,
        compatFlags: overrides.nativeCapability.compatFlags ? { ...overrides.nativeCapability.compatFlags } : undefined,
        limitations: overrides.nativeCapability.limitations ? [...overrides.nativeCapability.limitations] : undefined,
        certification: overrides.nativeCapability.certification
          ? {
            maxCertifiedPhase: overrides.nativeCapability.certification.maxCertifiedPhase,
            certifiedAt: overrides.nativeCapability.certification.certifiedAt,
            certificationSuiteVersion: overrides.nativeCapability.certification.certificationSuiteVersion,
            knownLimitations: overrides.nativeCapability.certification.knownLimitations
              ? [...overrides.nativeCapability.certification.knownLimitations]
              : undefined,
          }
          : undefined,
      }
      : undefined,
    supportedModel: overrides.supportedModel
      ? {
        ...overrides.supportedModel,
        stages: overrides.supportedModel.stages ? [...overrides.supportedModel.stages] : undefined,
        requiredCertificationPhaseByStage: overrides.supportedModel.requiredCertificationPhaseByStage
          ? { ...overrides.supportedModel.requiredCertificationPhaseByStage }
          : undefined,
        canonicalArtifactIdentity: overrides.supportedModel.canonicalArtifactIdentity
          ? { ...overrides.supportedModel.canonicalArtifactIdentity }
          : undefined,
        compatibilityFlags: overrides.supportedModel.compatibilityFlags
          ? { ...overrides.supportedModel.compatibilityFlags }
          : undefined,
        limitations: overrides.supportedModel.limitations ? [...overrides.supportedModel.limitations] : undefined,
      }
      : undefined,
  };
}

function makeQuotaSnapshot(
  registry: ModelRegistry,
  statuses: Partial<Record<string, QuotaStatus>> = {},
): QuotaSnapshot {
  return {
    models: Object.fromEntries(
      Object.keys(registry.models).map((modelId) => [
        modelId,
        {
          status: statuses[modelId] ?? 'healthy',
          remainingEstimate: null,
          resetAt: null,
          confidence: 1,
          lastLimitErrorAt: null,
          lastSuccessAt: null,
          lastReason: null,
        },
      ]),
    ),
    snapshotAt: new Date().toISOString(),
  };
}

function assertCapabilityMetadata(modelId: string, model: ModelRegistry['models'][string]): void {
  assert.ok(Number.isFinite(model.contextWindowTokens));
  assert.ok(model.contextWindowTokens > 0, `${modelId} should have a positive context window`);
  assert.ok(TOOL_SUPPORT_VALUES.has(model.toolSupport), `${modelId} should have a valid tool support tier`);
  assert.equal(typeof model.multimodal.text, 'boolean');
  assert.equal(typeof model.multimodal.image, 'boolean');
  if (model.multimodal.audio !== undefined) {
    assert.equal(typeof model.multimodal.audio, 'boolean');
  }
  if (model.multimodal.video !== undefined) {
    assert.equal(typeof model.multimodal.video, 'boolean');
  }
  assert.ok(LATENCY_TIER_VALUES.has(model.latencyTier), `${modelId} should have a valid latency tier`);
  assert.ok(REASONING_TIER_VALUES.has(model.reasoningTier), `${modelId} should have a valid reasoning tier`);
  assert.ok(Number.isFinite(model.costPerMillionInputTokensUsd));
  assert.ok(model.costPerMillionInputTokensUsd >= 0, `${modelId} should have non-negative input cost`);
  assert.ok(Number.isFinite(model.costPerMillionOutputTokensUsd));
  assert.ok(model.costPerMillionOutputTokensUsd >= 0, `${modelId} should have non-negative output cost`);
}

describe('model-registry', () => {
  it('seeds the canonical Claude defaults with complete metadata', () => {
    const expectedModels = [
      'claude-fable-5',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'deepseek-chat',
      'deepseek-coder-v2',
      'deepseek-r1',
      'deepseek-reasoner',
      'deepseek-v3',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-pro[1m]',
      'devstral-medium',
      'devstral-small',
      'gemini-2.0-flash',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'glm-5.2',
      'gpt-4.1',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5.3-codex',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'kimi-k2',
      'kimi-k2.7-code',
      'kimi-k2-thinking',
      'llama-3.3-70b',
      'llama-4-maverick',
      'llama-4-scout',
      'mistral-large-2',
      'mistral-medium-3',
      'qwen-2.5-coder-32b',
      'qwen-2.5-72b',
      'qwen-3-235b',
      'qwen-3-coder',
      'grok-code-fast',
    ];

    assert.deepEqual(Object.keys(DEFAULT_MODEL_REGISTRY.models).sort(), expectedModels.sort());

    for (const modelId of expectedModels) {
      const model = DEFAULT_MODEL_REGISTRY.models[modelId];
      assert.ok(model.vendor.length > 0);
      assert.ok(model.strengths.length > 0);
      assert.ok(model.weaknesses.length > 0);
      assertCapabilityMetadata(modelId, model);

      for (const taskType of ['routing', 'planning', 'coding', 'review', 'classify'] as TaskType[]) {
        assert.equal(typeof model.qualityScores[taskType], 'number');
      }
    }
  });

  it('getModel returns undefined for unknown or empty IDs', () => {
    assert.equal(getModel(DEFAULT_MODEL_REGISTRY, 'missing-model'), undefined);
    assert.equal(getModel(DEFAULT_MODEL_REGISTRY, ''), undefined);
  });

  it('normalizes reviewer aliases deterministically', () => {
    assert.equal(REVIEWER_ALIAS_MAP.deep, 'claude-fable-5');
    assert.equal(normalizeReviewerModelId(' deep ', DEFAULT_MODEL_REGISTRY), 'claude-fable-5');
    assert.equal(normalizeReviewerModelId('gpt-5.4', DEFAULT_MODEL_REGISTRY), 'gpt-5.4');
    assert.equal(normalizeReviewerModelId('unknown-reviewer', DEFAULT_MODEL_REGISTRY), null);
    assert.equal(normalizeReviewerModelId('   ', DEFAULT_MODEL_REGISTRY), null);
  });

  it('getLadder returns configured default ladders', () => {
    assert.equal(getLadder(DEFAULT_MODEL_REGISTRY, 'review')[0], 'gpt-5.5');
    assert.deepEqual(getLadder(DEFAULT_MODEL_REGISTRY, 'classify'), [
      'claude-haiku-4-5-20251001',
      'deepseek-v4-flash',
      'claude-sonnet-5',
      'gpt-5.5',
      'gpt-5.6-terra',
      'claude-fable-5',
    ]);
  });

  it('keeps DeepSeek models out of derived default ladders', () => {
    const registry: ModelRegistry = {
      models: {
        ...DEFAULT_MODEL_REGISTRY.models,
      },
      ladders: {},
    };

    const codingLadder = getLadder(registry, 'coding');
    assert.ok(!codingLadder.includes('deepseek-v4-pro'));
    assert.ok(!codingLadder.includes('deepseek-v4-pro[1m]'));
    assert.ok(!codingLadder.includes('deepseek-v4-flash'));
  });

  it('getLadder derives a deterministic fallback order from scores', () => {
    const registry: ModelRegistry = {
      models: {
        A: makeCapabilities({ qualityScores: { review: 90 } }),
        B: makeCapabilities({ qualityScores: { review: 80 } }),
        C: makeCapabilities({ qualityScores: { review: 70 } }),
      },
      ladders: {},
    };

    const first = getLadder(registry, 'review');
    const second = getLadder(registry, 'review');
    assert.deepEqual(first, ['A', 'B', 'C']);
    assert.deepEqual(second, ['A', 'B', 'C']);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('getLadder breaks score ties by model class', () => {
    const registry: ModelRegistry = {
      models: {
        economy: makeCapabilities({
          class: 'fast_economy',
          strengths: ['speed'],
          weaknesses: ['depth'],
          qualityScores: { planning: 90 },
        }),
        frontier: makeCapabilities({
          class: 'frontier',
          strengths: ['depth'],
          weaknesses: ['cost'],
          qualityScores: { planning: 90 },
        }),
      },
      ladders: {},
    };

    assert.deepEqual(getLadder(registry, 'planning'), ['frontier', 'economy']);
  });

  it('getLadder breaks remaining ties by model ID', () => {
    const registry: ModelRegistry = {
      models: {
        zebra: makeCapabilities({ qualityScores: { coding: 88 } }),
        alpha: makeCapabilities({ qualityScores: { coding: 88 } }),
      },
      ladders: {},
    };

    assert.deepEqual(getLadder(registry, 'coding'), ['alpha', 'zebra']);
  });

  it('getLadder returns an empty derived ladder when no model has a positive score', () => {
    const registry: ModelRegistry = {
      models: {
        alpha: makeCapabilities(),
      },
      ladders: {},
    };

    assert.deepEqual(getLadder(registry, 'review'), []);
  });

  it('rankCandidates filters excluded models and stays deterministic', () => {
    const once = rankCandidates(DEFAULT_MODEL_REGISTRY, 'review', {
      excluded: ['claude-sonnet-5'],
    });
    const twice = rankCandidates(DEFAULT_MODEL_REGISTRY, 'review', {
      excluded: ['claude-sonnet-5'],
    });
    const thrice = rankCandidates(DEFAULT_MODEL_REGISTRY, 'review', {
      excluded: ['claude-sonnet-5'],
    });

    assert.deepEqual(once, [
      'gpt-5.5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'gpt-5.6-terra',
      'deepseek-v4-pro',
      'deepseek-reasoner',
      'claude-haiku-4-5-20251001',
    ]);
    assert.equal(JSON.stringify(once), JSON.stringify(twice));
    assert.equal(JSON.stringify(twice), JSON.stringify(thrice));
  });

  it('rankCandidates ignores unknown excluded model IDs', () => {
    assert.deepEqual(
      rankCandidates(DEFAULT_MODEL_REGISTRY, 'classify', { excluded: ['missing-model'] }),
      getLadder(DEFAULT_MODEL_REGISTRY, 'classify')
    );
  });

  it('rankCandidates returns an empty ladder when every candidate is excluded', () => {
    assert.deepEqual(
      rankCandidates(DEFAULT_MODEL_REGISTRY, 'classify', {
        excluded: ['claude-haiku-4-5-20251001', 'deepseek-v4-flash', 'claude-sonnet-5', 'gpt-5.5', 'gpt-5.6-terra', 'claude-fable-5'],
      }),
      []
    );
  });

  it('rankCandidates returns the full ladder when no exclusions are provided', () => {
    assert.deepEqual(rankCandidates(DEFAULT_MODEL_REGISTRY, 'coding'), [
      'claude-fable-5',
      'gpt-5.5',
      'gpt-5.6-terra',
      'deepseek-v4-pro',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'deepseek-chat',
      'deepseek-v4-flash',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('filters disabled models from configured and derived ladders', () => {
    assert.ok(!getLadder(DEFAULT_MODEL_REGISTRY, 'coding').includes('gpt-5.3-codex'));
    assert.ok(!rankCandidates(DEFAULT_MODEL_REGISTRY, 'coding').includes('gpt-5.3-codex'));
    assert.ok(getLadder(DEFAULT_MODEL_REGISTRY, 'coding').includes('claude-fable-5'));
    assert.ok(rankCandidates(DEFAULT_MODEL_REGISTRY, 'coding').includes('claude-fable-5'));
  });

  it('registers DeepSeek models with deepseek vendor metadata', () => {
    for (const modelId of ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner']) {
      assert.equal(DEFAULT_MODEL_REGISTRY.models[modelId]?.vendor, 'deepseek');
    }
  });

  it('mergeModelRegistry applies field overrides without mutating defaults', () => {
    const merged = mergeModelRegistry(DEFAULT_MODEL_REGISTRY, {
      models: {
        'claude-opus-4-7': {
          qualityScores: { coding: 99 },
        },
      },
    });

    assert.equal(merged.models['claude-opus-4-7'].qualityScores.coding, 99);
    assert.equal(merged.models['claude-opus-4-7'].vendor, DEFAULT_MODEL_REGISTRY.models['claude-opus-4-7'].vendor);
    assert.deepEqual(
      merged.models['claude-opus-4-7'].strengths,
      DEFAULT_MODEL_REGISTRY.models['claude-opus-4-7'].strengths
    );
    assert.equal(
      DEFAULT_MODEL_REGISTRY.models['claude-opus-4-7'].qualityScores.coding,
      85
    );
  });

  it('mergeModelRegistry replaces task ladders wholesale', () => {
    const merged = mergeModelRegistry(DEFAULT_MODEL_REGISTRY, {
      ladders: {
        classify: ['claude-haiku-4-5-20251001'],
      },
    });

    assert.deepEqual(getLadder(merged, 'classify'), ['claude-haiku-4-5-20251001']);
  });

  it('mergeModelRegistry returns a structural clone for empty overrides', () => {
    const merged = mergeModelRegistry(DEFAULT_MODEL_REGISTRY, {});
    assert.notEqual(merged, DEFAULT_MODEL_REGISTRY);
    assert.deepEqual(getLadder(merged, 'routing'), getLadder(DEFAULT_MODEL_REGISTRY, 'routing'));
    assert.deepEqual(Object.keys(merged.models).sort(), Object.keys(DEFAULT_MODEL_REGISTRY.models).sort());
    assert.notEqual(merged.models['claude-opus-4-7'], DEFAULT_MODEL_REGISTRY.models['claude-opus-4-7']);
  });

  it('mergeModelRegistry can add a new model ID', () => {
    const merged = mergeModelRegistry(DEFAULT_MODEL_REGISTRY, {
      models: {
        'gpt-5.6': {
          vendor: 'openai',
          class: 'frontier',
          strengths: ['general reasoning'],
          weaknesses: ['cost'],
          qualityScores: {
            routing: 65,
            planning: 90,
            coding: 88,
            review: 87,
            classify: 70,
          },
          contextWindowTokens: 400_000,
          toolSupport: 'full',
          multimodal: { text: true, image: true },
          latencyTier: 'standard',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 6,
          costPerMillionOutputTokensUsd: 36,
        },
      },
    });

    assert.equal(merged.models['gpt-5.6'].vendor, 'openai');
    assert.equal(merged.models['gpt-5.6'].qualityScores.planning, 90);
  });

  it('mergeModelRegistry merges and clones capability metadata overrides', () => {
    const merged = mergeModelRegistry(DEFAULT_MODEL_REGISTRY, {
      models: {
        'claude-opus-4-7': {
          contextWindowTokens: 250_000,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 6,
          costPerMillionOutputTokensUsd: 26,
        },
      },
    });

    assert.equal(merged.models['claude-opus-4-7'].contextWindowTokens, 250_000);
    assert.equal(merged.models['claude-opus-4-7'].toolSupport, 'basic');
    assert.deepEqual(merged.models['claude-opus-4-7'].multimodal, { text: true, image: false });
    assert.equal(merged.models['claude-opus-4-7'].latencyTier, 'standard');
    assert.equal(merged.models['claude-opus-4-7'].reasoningTier, 'advanced');
    assert.equal(merged.models['claude-opus-4-7'].costPerMillionInputTokensUsd, 6);
    assert.equal(merged.models['claude-opus-4-7'].costPerMillionOutputTokensUsd, 26);
    assert.deepEqual(DEFAULT_MODEL_REGISTRY.models['claude-opus-4-7'].multimodal, { text: true, image: true });
  });

  it('mergeModelRegistry clones and overrides disabled state', () => {
    const merged = mergeModelRegistry(DEFAULT_MODEL_REGISTRY, {
      models: {
        'gpt-5.3-codex': {
          disabled: false,
        },
      },
    });

    assert.equal(DEFAULT_MODEL_REGISTRY.models['gpt-5.3-codex'].disabled, true);
    assert.equal(merged.models['gpt-5.3-codex'].disabled, false);
  });

  it('exposes DeepSeek metadata in the default registry', () => {
    const pro = DEFAULT_MODEL_REGISTRY.models['deepseek-v4-pro'];
    const flash = DEFAULT_MODEL_REGISTRY.models['deepseek-v4-flash'];
    const oneMillion = DEFAULT_MODEL_REGISTRY.models['deepseek-v4-pro[1m]'];

    assert.equal(pro.vendor, 'deepseek');
    assert.equal(pro.class, 'strong_generalist');
    assert.equal(pro.defaultLadderEligible, false);
    assert.equal(pro.contextWindowTokens, 1_000_000);
    assert.equal(pro.toolSupport, 'basic');
    assert.deepEqual(pro.multimodal, { text: true, image: false });
    assert.equal(pro.reasoningTier, 'advanced');
    assert.equal(pro.costPerMillionInputTokensUsd, 0.435);
    assert.equal(pro.agent, 'claude');
    assert.equal(pro.pricing?.inputCostPerMTok, 0.435);
    assert.equal(pro.pricing?.outputCostPerMTok, 0.87);
    assert.equal(flash.class, 'fast_economy');
    assert.equal(flash.latencyTier, 'fast');
    assert.equal(flash.pricing?.inputCostPerMTok, 0.14);
    assert.equal(oneMillion.contextWindowTokens, 1_000_000);
  });

  it('exposes normalized capability metadata for frontier and economy models', () => {
    const frontier = DEFAULT_MODEL_REGISTRY.models['gpt-5.5'];
    const economy = DEFAULT_MODEL_REGISTRY.models['claude-haiku-4-5-20251001'];

    assert.equal(frontier.contextWindowTokens, 400_000);
    assert.equal(frontier.toolSupport, 'full');
    assert.equal(frontier.reasoningTier, 'advanced');
    assert.equal(frontier.costPerMillionInputTokensUsd, 5);
    assert.equal(frontier.costPerMillionOutputTokensUsd, 30);

    assert.equal(economy.latencyTier, 'fast');
    assert.equal(economy.reasoningTier, 'basic');
    assert.equal(economy.costPerMillionInputTokensUsd, 0.8);
    assert.equal(economy.costPerMillionOutputTokensUsd, 4);
  });

  it('treats empty capability constraints as satisfied', () => {
    const model = DEFAULT_MODEL_REGISTRY.models['gpt-5.5'];

    assert.equal(satisfiesCapabilities(model), true);
    assert.deepEqual(evaluateCapabilityConstraints(model, {}).failedConstraints, []);
  });

  it('checks minimum context window constraints', () => {
    const model = DEFAULT_MODEL_REGISTRY.models['gpt-5.5'];

    assert.equal(satisfiesCapabilities(model, { minContextWindow: 128_000 }), true);
    assert.equal(satisfiesCapabilities(model, { minContextWindow: 500_000 }), false);
    assert.deepEqual(
      evaluateCapabilityConstraints(model, { minContextWindow: 500_000 }).failedConstraints,
      ['minContextWindow'],
    );
  });

  it('checks tool support constraints', () => {
    assert.equal(satisfiesCapabilities(makeCapabilities({ toolSupport: 'none' }), { requiresTools: true }), false);
    assert.equal(satisfiesCapabilities(makeCapabilities({ toolSupport: 'basic' }), { requiresTools: true }), true);
    assert.equal(satisfiesCapabilities(makeCapabilities({ toolSupport: 'full' }), { requiresTools: true }), true);
  });

  it('checks multimodal image constraints', () => {
    assert.equal(
      satisfiesCapabilities(makeCapabilities({ multimodal: { text: true, image: true } }), { requiresMultimodal: true }),
      true,
    );
    assert.equal(
      satisfiesCapabilities(makeCapabilities({ multimodal: { text: true, image: false } }), { requiresMultimodal: true }),
      false,
    );
  });

  it('orders latency tiers from fast to slow', () => {
    assert.ok(compareLatencyTier('fast', 'standard') < 0);
    assert.ok(compareLatencyTier('standard', 'slow') < 0);
    assert.ok(compareLatencyTier('slow', 'fast') > 0);
    assert.equal(satisfiesCapabilities(makeCapabilities({ latencyTier: 'fast' }), { maxLatencyTier: 'standard' }), true);
    assert.equal(satisfiesCapabilities(makeCapabilities({ latencyTier: 'slow' }), { maxLatencyTier: 'standard' }), false);
  });

  it('fails closed when a required capability field is missing', () => {
    const partialModel = {
      contextWindowTokens: 200_000,
      toolSupport: 'basic',
    } as Partial<ModelRegistry['models'][string]>;

    assert.deepEqual(
      evaluateCapabilityConstraints(partialModel, {
        requiresMultimodal: true,
        maxLatencyTier: 'standard',
      }).failedConstraints,
      ['requiresMultimodal', 'maxLatencyTier'],
    );
  });

  it('recognizes configured DeepSeek IDs and validates bracket syntax', () => {
    assert.deepEqual(configuredDeepSeekModelIds(DEFAULT_MODEL_REGISTRY), [
      'deepseek-chat',
      'deepseek-coder-v2',
      'deepseek-r1',
      'deepseek-reasoner',
      'deepseek-v3',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-pro[1m]',
    ]);
    assert.equal(isKnownModelId(DEFAULT_MODEL_REGISTRY, 'deepseek-v4-pro[1m]'), true);
    assert.doesNotThrow(() => validateModelId('deepseek-v4-pro[1m]'));
    assert.throws(() => validateModelId('deepseek-v4-pro[]'), /Invalid model ID/);
    assert.throws(() => validateModelId('DEEPSEEK-V4-PRO'), /Invalid model ID/);
  });

  it('filters unknown ladder IDs while warning once', () => {
    const merged = mergeModelRegistry(DEFAULT_MODEL_REGISTRY, {
      ladders: {
        review: ['claude-opus-4-7', 'missing-model', 'claude-sonnet-5'],
      },
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      assert.deepEqual(getLadder(merged, 'review'), ['claude-opus-4-7', 'claude-sonnet-5']);
      assert.deepEqual(getLadder(merged, 'review'), ['claude-opus-4-7', 'claude-sonnet-5']);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missing-model/);
  });

  it('getEffectiveRegistry ignores repo-local registry overrides', () => {
    const repoDir = makeTempRepo();

    try {
      clearConfigCache();
      writeConfig(repoDir, {
        modelRegistry: {
          models: {
            'claude-opus-4-7': {
              qualityScores: {
                coding: 99,
              },
            },
          },
          ladders: {
            coding: ['claude-opus-4-7', 'claude-sonnet-5'],
          },
        },
      });

      const registry = getEffectiveRegistry(repoDir);
      assert.equal(
        registry.models['claude-opus-4-7'].qualityScores.coding,
        DEFAULT_MODEL_REGISTRY.models['claude-opus-4-7'].qualityScores.coding,
      );
      assert.deepEqual(getLadder(registry, 'coding'), getLadder(DEFAULT_MODEL_REGISTRY, 'coding'));
    } finally {
      clearConfigCache();
      cleanUp(repoDir);
    }
  });

  it('uses global registry ladders for descriptor stages', () => {
    const repoDir = makeTempRepo();

    try {
      writeConfig(repoDir, {});
      clearConfigCache(repoDir);

      const registry = getEffectiveRegistry(repoDir);
      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'planner'), filterDisabledModels(getLadder(registry, 'planning')));
      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'coder'), filterDisabledModels(getLadder(registry, 'coding')));
      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'reviewer'), filterDisabledModels(getLadder(registry, 'review')));
      assert.deepEqual(
        getConfiguredModelsForDescriptor(repoDir),
        [...new Set(filterDisabledModels([
          ...getLadder(registry, 'planning'),
          ...getLadder(registry, 'coding'),
          ...getLadder(registry, 'review'),
        ]))],
      );
    } finally {
      clearConfigCache(repoDir);
      cleanUp(repoDir);
    }
  });

  it('ignores removed router model lists for descriptor stages', () => {
    const repoDir = makeTempRepo();

    try {
      writeConfig(repoDir, {
        router: {
          models: ['gpt-5.6-terra', 'claude-sonnet-5'],
        },
      });
      clearConfigCache(repoDir);

      const registry = getEffectiveRegistry(repoDir);
      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'planner'), filterDisabledModels(getLadder(registry, 'planning')));
      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'coder'), filterDisabledModels(getLadder(registry, 'coding')));
      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'reviewer'), filterDisabledModels(getLadder(registry, 'review')));
    } finally {
      clearConfigCache(repoDir);
      cleanUp(repoDir);
    }
  });

  it('falls back to effective registry ladders when router availability is absent', () => {
    const repoDir = makeTempRepo();

    try {
      writeConfig(repoDir, {});
      clearConfigCache(repoDir);

      // Descriptor models are the ladder minus globally-disabled models, so
      // filter the expected ladders the same way (robust to the disable set).
      assert.deepEqual(
        getConfiguredModelsForDescriptorStage(repoDir, 'planner'),
        filterDisabledModels(getLadder(getEffectiveRegistry(repoDir), 'planning')),
      );
      assert.deepEqual(
        getConfiguredModelsForDescriptorStage(repoDir, 'coder'),
        filterDisabledModels(getLadder(getEffectiveRegistry(repoDir), 'coding')),
      );
      assert.deepEqual(
        getConfiguredModelsForDescriptorStage(repoDir, 'reviewer'),
        filterDisabledModels(getLadder(getEffectiveRegistry(repoDir), 'review')),
      );

      const descriptorModels = getConfiguredModelsForDescriptor(repoDir);
      assert.ok(descriptorModels.length > 0);
      assert.ok(descriptorModels.includes('gpt-5.5'));
      assert.ok(descriptorModels.includes('gpt-5.6-terra'));
      assert.notDeepEqual(descriptorModels, [
        'claude-sonnet-5',
        'claude-opus-4-7',
        'claude-sonnet-4-5-20250929',
        'claude-opus-4-6',
        'claude-haiku-4-5-20251001',
      ]);
    } finally {
      clearConfigCache(repoDir);
      cleanUp(repoDir);
    }
  });

  it('ignores removed model registry ladder overrides for descriptor stages', () => {
    const repoDir = makeTempRepo();

    try {
      writeConfig(repoDir, {
        modelRegistry: {
          models: {
            'custom-codex-model': {
              vendor: 'openai',
              class: 'strong_generalist',
              strengths: ['custom coding'],
              weaknesses: ['none'],
              qualityScores: { coding: 95 },
              agent: 'codex',
            },
          },
          ladders: {
            coding: ['custom-codex-model'],
          },
        },
      });
      clearConfigCache(repoDir);

      assert.deepEqual(
        getConfiguredModelsForDescriptorStage(repoDir, 'coder'),
        filterDisabledModels(getLadder(getEffectiveRegistry(repoDir), 'coding')),
      );
    } finally {
      clearConfigCache(repoDir);
      cleanUp(repoDir);
    }
  });

  describe('native capability', () => {
    function makeCertification(overrides: Partial<NonNullable<NonNullable<ModelRegistry['models'][string]['nativeCapability']>['certification']>> = {}) {
      return {
        maxCertifiedPhase: overrides.maxCertifiedPhase ?? 'patch',
        certifiedAt: overrides.certifiedAt ?? '2026-06-01T00:00:00.000Z',
        certificationSuiteVersion: overrides.certificationSuiteVersion ?? 'v1',
        knownLimitations: overrides.knownLimitations ? [...overrides.knownLimitations] : ['requires tool retries'],
      };
    }

    it('keeps non-native entries unset and preserves authored native metadata', () => {
      assert.equal(DEFAULT_MODEL_REGISTRY.models['gpt-5.5'].nativeCapability, undefined);

      const merged = mergeModelRegistry(DEFAULT_MODEL_REGISTRY, {
        models: {
          'native-openai': {
            vendor: 'openai',
            class: 'frontier',
            strengths: ['native read-only'],
            weaknesses: ['none'],
            qualityScores: { planning: 95, review: 94 },
            contextWindowTokens: 400_000,
            toolSupport: 'full',
            multimodal: { text: true, image: true },
            latencyTier: 'standard',
            reasoningTier: 'advanced',
            costPerMillionInputTokensUsd: 5,
            costPerMillionOutputTokensUsd: 15,
            agent: 'native-openai',
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'certified',
            },
          },
        },
      });

      assert.equal(merged.models['native-openai'].agent, 'native-openai');
      assert.deepEqual(merged.models['native-openai'].nativeCapability, {
        nativeProvider: 'openai',
        piTransportKind: 'openai-responses',
        readOnlyNative: 'certified',
        compatFlags: undefined,
        limitations: undefined,
        certification: undefined,
      });
    });

    it('derives certified capability for openai responses transport', () => {
      assert.deepEqual(
        deriveReadOnlyNativeCapability({
          nativeProvider: 'openai',
          piTransportKind: 'openai-responses',
        }),
        { capability: 'certified', limitations: [] },
      );
    });

    it('derives certified capability for openrouter completions with compat flag', () => {
      assert.deepEqual(
        deriveReadOnlyNativeCapability({
          nativeProvider: 'openrouter',
          piTransportKind: 'openai-completions',
          compatFlags: { thinkingFormat: 'openrouter' },
        }),
        { capability: 'certified', limitations: [] },
      );
    });

    it('derives partial capability for openrouter completions without compat flag', () => {
      const derived = deriveReadOnlyNativeCapability({
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
      });

      assert.equal(derived.capability, 'partial');
      assert.ok(derived.limitations.length > 0);
      assert.match(derived.limitations[0] ?? '', /thinkingFormat=openrouter/);
    });

    it('derives unsupported capability when pi transport is missing', () => {
      const derived = deriveReadOnlyNativeCapability({
        nativeProvider: 'openai',
      });

      assert.equal(derived.capability, 'unsupported');
      assert.match(derived.limitations[0] ?? '', /piTransportKind/);
    });

    it('ignores unknown compat flags during derivation', () => {
      assert.deepEqual(
        deriveReadOnlyNativeCapability({
          nativeProvider: 'openrouter',
          piTransportKind: 'openai-completions',
          compatFlags: { thinkingFormat: 'openrouter', someUnknownKey: true },
        }),
        { capability: 'certified', limitations: [] },
      );
    });

    it('rejects certified entries that omit nativeProvider', () => {
      assert.throws(
        () => validateNativeCapability('m', {
          nativeCapability: {
            readOnlyNative: 'certified',
            piTransportKind: 'openai-responses',
          } as any,
        }),
        (error: unknown) => {
          assert.ok(error instanceof ModelValidationError);
          assert.equal(error.modelId, 'm');
          assert.match(error.message, /nativeProvider/);
          return true;
        },
      );
    });

    it('rejects certified entries that omit piTransportKind', () => {
      assert.throws(
        () => validateNativeCapability('m', {
          nativeCapability: {
            nativeProvider: 'openai',
            readOnlyNative: 'certified',
          } as any,
        }),
        (error: unknown) => {
          assert.ok(error instanceof ModelValidationError);
          assert.equal(error.modelId, 'm');
          assert.match(error.message, /piTransportKind/);
          return true;
        },
      );
    });

    it('rejects contradictory certified entries', () => {
      assert.throws(
        () => validateNativeCapability('m', {
          nativeCapability: {
            nativeProvider: 'openrouter',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'certified',
          } as any,
        }),
        /contradicts compat flags \(derived: unsupported\)/,
      );
    });

    it('asserts registry-level consistency for native capability metadata', () => {
      assert.throws(
        () => assertRegistryConsistency({
          models: {
            bad: makeCapabilities({
              nativeCapability: {
                nativeProvider: 'openrouter',
                piTransportKind: 'openai-responses',
                readOnlyNative: 'certified',
              } as any,
            }),
          },
          ladders: {},
        }),
        /contradicts compat flags/,
      );

      assert.doesNotThrow(() => assertRegistryConsistency({
        models: {
          good: makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openrouter',
              piTransportKind: 'openai-completions',
              readOnlyNative: 'partial',
              limitations: ['missing thinkingFormat=openrouter compat flag'],
            } as any,
          }),
        },
        ladders: {},
      }));
    });

    it('accepts a valid native certification block', () => {
      assert.doesNotThrow(() => validateNativeCapability('m', {
        nativeCapability: {
          nativeProvider: 'openai',
          piTransportKind: 'openai-responses',
          readOnlyNative: 'certified',
          certification: makeCertification(),
        },
      }));
    });

    it('rejects invalid certified phase values', () => {
      assert.throws(
        () => validateNativeCapability('m', {
          nativeCapability: {
            nativeProvider: 'openai',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'certified',
            certification: {
              ...makeCertification(),
              maxCertifiedPhase: 'invalid-phase' as any,
            },
          },
        }),
        /maxCertifiedPhase/,
      );
    });

    it('rejects malformed certifiedAt values', () => {
      assert.throws(
        () => validateNativeCapability('m', {
          nativeCapability: {
            nativeProvider: 'openai',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'certified',
            certification: {
              ...makeCertification(),
              certifiedAt: 'not-a-date',
            },
          },
        }),
        /certifiedAt/,
      );
    });

    it('rejects unsafe certificationSuiteVersion values', () => {
      assert.throws(
        () => validateNativeCapability('m', {
          nativeCapability: {
            nativeProvider: 'openai',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'certified',
            certification: {
              ...makeCertification(),
              certificationSuiteVersion: '../v1',
            },
          },
        }),
        /certificationSuiteVersion/,
      );
    });

    it('rejects incomplete certification blocks', () => {
      assert.throws(
        () => validateNativeCapability('m', {
          nativeCapability: {
            nativeProvider: 'openai',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'certified',
            certification: {
              maxCertifiedPhase: 'patch',
              certifiedAt: '2026-06-01T00:00:00.000Z',
            } as any,
          },
        }),
        /certificationSuiteVersion/,
      );
    });

    it('rejects non-string knownLimitations values', () => {
      assert.throws(
        () => validateNativeCapability('m', {
          nativeCapability: {
            nativeProvider: 'openai',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'certified',
            certification: {
              ...makeCertification(),
              knownLimitations: ['okay', 1] as any,
            },
          },
        }),
        /knownLimitations/,
      );
    });

    it('rejects certification blocks when readOnlyNative is unsupported', () => {
      assert.throws(
        () => validateNativeCapability('m', {
          nativeCapability: {
            nativeProvider: 'openai',
            piTransportKind: 'openai-responses',
            readOnlyNative: 'unsupported',
            certification: makeCertification(),
          } as any,
        }),
        /readOnlyNative=unsupported/,
      );
    });

    it('rejects certification blocks without native identity', () => {
      assert.throws(
        () => validateNativeCapability('m', {
          nativeCapability: {
            readOnlyNative: 'certified',
            certification: makeCertification(),
          } as any,
        }),
        /nativeProvider/,
      );
    });

    it('returns true for certified native read-only capability', () => {
      const registry: ModelRegistry = {
        models: {
          A: makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'certified',
            },
          }),
        },
        ladders: {},
      };

      assert.equal(isReadOnlyNativeCapable('A', { registry }), true);
    });

    it('resolves raw OpenRouter ids through the alias-keyed registry', () => {
      const registry: ModelRegistry = {
        models: {
          'qwen-3-coder': makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openrouter',
              piTransportKind: 'openai-completions',
              readOnlyNative: 'certified',
              compatFlags: { thinkingFormat: 'openrouter' },
            },
          }),
        },
        ladders: {},
      };

      assert.equal(getModel(registry, 'qwen/qwen3-coder'), registry.models['qwen-3-coder']);
      assert.equal(isReadOnlyNativeCapable('qwen/qwen3-coder', { registry }), true);
    });

    it('returns false for unsupported native read-only capability', () => {
      const registry: ModelRegistry = {
        models: {
          A: makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'unsupported',
            } as any,
          }),
        },
        ladders: {},
      };

      assert.equal(isReadOnlyNativeCapable('A', { registry }), false);
    });

    it('keeps partial capability gated off by default', () => {
      const registry: ModelRegistry = {
        models: {
          A: makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openrouter',
              piTransportKind: 'openai-completions',
              readOnlyNative: 'partial',
              limitations: ['missing thinkingFormat=openrouter compat flag'],
            } as any,
          }),
        },
        ladders: {},
      };

      assert.equal(isReadOnlyNativeCapable('A', { registry }), false);
      assert.equal(isReadOnlyNativeCapable('A', { registry, allowPartial: true }), true);
    });

    it('returns false for unknown model ids without throwing', () => {
      assert.equal(isReadOnlyNativeCapable('missing', { registry: DEFAULT_MODEL_REGISTRY }), false);
    });

    it('keeps model availability distinct from certification', () => {
      const registry = mergeModelRegistry(DEFAULT_MODEL_REGISTRY, {
        models: {
          'native-unsupported': {
            vendor: 'openai',
            class: 'frontier',
            strengths: ['available'],
            weaknesses: ['not certified'],
            qualityScores: { review: 96 },
            contextWindowTokens: 400_000,
            toolSupport: 'full',
            multimodal: { text: true, image: true },
            latencyTier: 'standard',
            reasoningTier: 'advanced',
            costPerMillionInputTokensUsd: 5,
            costPerMillionOutputTokensUsd: 15,
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-completions',
              readOnlyNative: 'unsupported',
            } as any,
          },
        },
        ladders: {
          review: ['native-unsupported', 'gpt-5.5'],
        },
      });

      assert.ok(getLadder(registry, 'review').includes('native-unsupported'));
      assert.equal(isReadOnlyNativeCapable('native-unsupported', { registry }), false);
    });

    it('keeps default registry validation backward compatible', () => {
      assert.doesNotThrow(() => getEffectiveRegistry());
    });

    it('ignores config-provided native capability metadata', () => {
      const repoDir = makeTempRepo();

      try {
        writeConfig(repoDir, {
          modelRegistry: {
            models: {
              'gpt-5.5': {
                nativeCapability: {
                  nativeProvider: 'openai',
                  piTransportKind: 'openai-responses',
                  readOnlyNative: 'certified',
                },
              },
            },
          },
        });
        clearConfigCache(repoDir);

        const registry = getEffectiveRegistry(repoDir);
        assert.equal(
          registry.models['gpt-5.5'].nativeCapability?.readOnlyNative,
          DEFAULT_MODEL_REGISTRY.models['gpt-5.5'].nativeCapability?.readOnlyNative,
        );
      } finally {
        clearConfigCache(repoDir);
        cleanUp(repoDir);
      }
    });

    it('does not load invalid repo-local native capability metadata through the registry', () => {
      const repoDir = makeTempRepo();

      try {
        writeConfig(repoDir, {
          modelRegistry: {
            models: {
              'gpt-5.5': {
                nativeCapability: {
                  nativeProvider: 'openrouter',
                  piTransportKind: 'openai-responses',
                  readOnlyNative: 'certified',
                },
              },
            },
          },
        });
        clearConfigCache(repoDir);

        assert.doesNotThrow(() => getEffectiveRegistry(repoDir));
      } finally {
        clearConfigCache(repoDir);
        cleanUp(repoDir);
      }
    });

    it('evaluates registry phase eligibility from checked-in metadata', () => {
      const registry: ModelRegistry = {
        models: {
          A: makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'certified',
              certification: makeCertification({
                maxCertifiedPhase: 'workflow',
                certifiedAt: '2026-06-15T00:00:00.000Z',
                certificationSuiteVersion: 'v7',
              }),
            },
          }),
        },
        ladders: {},
      };

      assert.deepEqual(
        evaluateRegistryPhaseEligibility({
          modelId: 'A',
          phase: 'patch',
          registry,
          now: new Date('2026-06-20T00:00:00.000Z'),
        }),
        {
          eligible: true,
          modelId: 'A',
          phase: 'patch',
          certifiedAt: '2026-06-15T00:00:00.000Z',
          suiteVersion: 'v7',
        },
      );
    });

    it('evaluates raw OpenRouter id phase eligibility from alias metadata', () => {
      const registry: ModelRegistry = {
        models: {
          'qwen-3-coder': makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openrouter',
              piTransportKind: 'openai-completions',
              readOnlyNative: 'certified',
              compatFlags: { thinkingFormat: 'openrouter' },
              certification: makeCertification({
                maxCertifiedPhase: 'workflow',
                certifiedAt: '2026-06-15T00:00:00.000Z',
                certificationSuiteVersion: 'v7',
              }),
            },
          }),
        },
        ladders: {},
      };

      assert.deepEqual(
        evaluateRegistryPhaseEligibility({
          modelId: 'qwen/qwen3-coder',
          phase: 'read-only',
          registry,
          now: new Date('2026-06-20T00:00:00.000Z'),
        }),
        {
          eligible: true,
          modelId: 'qwen/qwen3-coder',
          phase: 'read-only',
          certifiedAt: '2026-06-15T00:00:00.000Z',
          suiteVersion: 'v7',
        },
      );
    });

    it('returns phase-insufficient when the checked-in phase is too low', () => {
      const registry: ModelRegistry = {
        models: {
          A: makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'certified',
              certification: makeCertification({ maxCertifiedPhase: 'read-only' }),
            },
          }),
        },
        ladders: {},
      };

      assert.deepEqual(
        evaluateRegistryPhaseEligibility({
          modelId: 'A',
          phase: 'patch',
          registry,
          now: new Date('2026-06-20T00:00:00.000Z'),
        }),
        {
          eligible: false,
          modelId: 'A',
          phase: 'patch',
          reason: 'phase-insufficient',
          certifiedAt: '2026-06-01T00:00:00.000Z',
          suiteVersion: 'v1',
        },
      );
    });

    it('returns stale once certifiedAt plus ttl has elapsed', () => {
      const registry: ModelRegistry = {
        models: {
          A: makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'certified',
              certification: makeCertification({
                certifiedAt: '2026-01-01T00:00:00.000Z',
              }),
            },
          }),
        },
        ladders: {},
      };

      assert.deepEqual(
        evaluateRegistryPhaseEligibility({
          modelId: 'A',
          phase: 'read-only',
          registry,
          now: new Date('2026-03-15T00:00:00.000Z'),
        }),
        {
          eligible: false,
          modelId: 'A',
          phase: 'read-only',
          reason: 'stale',
          certifiedAt: '2026-01-01T00:00:00.000Z',
          suiteVersion: 'v1',
        },
      );
    });

    it('returns no-metadata when certification is absent', () => {
      const registry: ModelRegistry = {
        models: {
          A: makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'certified',
            },
          }),
        },
        ladders: {},
      };

      assert.deepEqual(
        evaluateRegistryPhaseEligibility({
          modelId: 'A',
          phase: 'read-only',
          registry,
        }),
        {
          eligible: false,
          modelId: 'A',
          phase: 'read-only',
          reason: 'no-metadata',
        },
      );
    });

    it('preserves seeded certification when an override only updates one nested field', () => {
      const merged = mergeModelRegistry({
        models: {
          seeded: makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'certified',
              certification: makeCertification({
                maxCertifiedPhase: 'patch',
                certificationSuiteVersion: 'v1',
                knownLimitations: ['seeded'],
              }),
            },
          }),
        },
        ladders: {},
      }, {
        models: {
          seeded: {
            nativeCapability: {
              certification: {
                knownLimitations: ['override-only'],
              },
            },
          },
        },
      });

      assert.deepEqual(merged.models.seeded.nativeCapability?.certification, {
        maxCertifiedPhase: 'patch',
        certifiedAt: '2026-06-01T00:00:00.000Z',
        certificationSuiteVersion: 'v1',
        knownLimitations: ['override-only'],
      });
    });
  });

  describe('evaluateNativeReadOnlyRouting and assertNativeReadOnlyRoutable', () => {
    function makeCertifiedRegistry(): ModelRegistry {
      return {
        models: {
          'certified-model': makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'certified',
            },
          }),
          'partial-model': makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openrouter',
              piTransportKind: 'openai-completions',
              readOnlyNative: 'partial',
              limitations: ['missing thinkingFormat=openrouter compat flag'],
            } as any,
          }),
          'unsupported-model': makeCapabilities({
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'unsupported',
            } as any,
          }),
        },
        ladders: {},
      };
    }

    it('task mode: certified model is routable', () => {
      const registry = makeCertifiedRegistry();
      const decision = evaluateNativeReadOnlyRouting({ modelId: 'certified-model', phase: 'planning', registry });

      assert.equal(decision.routable, true);
      assert.equal(decision.certified, true);
      assert.equal(decision.mode, 'task');
      assert.equal(decision.phase, 'planning');
      assert.equal(decision.modelId, 'certified-model');
      assert.equal(decision.capability, 'certified');
      assert.equal(decision.reason, undefined);
    });

    it('task mode: unsupported model is refused with actionable reason naming model, phase, and capability', () => {
      const registry = makeCertifiedRegistry();
      const decision = evaluateNativeReadOnlyRouting({ modelId: 'unsupported-model', phase: 'expansion', registry });

      assert.equal(decision.routable, false);
      assert.equal(decision.certified, false);
      assert.equal(decision.capability, 'unsupported');
      assert.ok(decision.reason, 'should have a reason');
      assert.match(decision.reason!, /unsupported-model/);
      assert.match(decision.reason!, /expansion/);
      assert.match(decision.reason!, /unsupported/);
      assert.match(decision.reason!, /certified/);
    });

    it('task mode: unregistered model is refused with capability: unregistered', () => {
      const registry = makeCertifiedRegistry();
      const decision = evaluateNativeReadOnlyRouting({ modelId: 'nonexistent-model', phase: 'planning', registry });

      assert.equal(decision.routable, false);
      assert.equal(decision.capability, 'unregistered');
      assert.ok(decision.reason);
      assert.match(decision.reason!, /nonexistent-model/);
      assert.match(decision.reason!, /unregistered/);
    });

    it('task mode: partial model is refused by default, routable with allowPartial', () => {
      const registry = makeCertifiedRegistry();

      const refused = evaluateNativeReadOnlyRouting({ modelId: 'partial-model', phase: 'planning', registry });
      assert.equal(refused.routable, false);
      assert.equal(refused.certified, false);
      assert.equal(refused.capability, 'partial');

      const allowed = evaluateNativeReadOnlyRouting({
        modelId: 'partial-model',
        phase: 'planning',
        registry,
        allowPartial: true,
      });
      assert.equal(allowed.routable, true);
      assert.equal(allowed.certified, true);
    });

    it('certification mode: routable is always false, certified reflects actual state, no reason set', () => {
      const registry = makeCertifiedRegistry();

      const certifiedDecision = evaluateNativeReadOnlyRouting({
        modelId: 'certified-model',
        phase: 'planning',
        mode: 'certification',
        registry,
      });
      assert.equal(certifiedDecision.routable, false);
      assert.equal(certifiedDecision.certified, true);
      assert.equal(certifiedDecision.mode, 'certification');
      assert.equal(certifiedDecision.reason, undefined);

      const uncertifiedDecision = evaluateNativeReadOnlyRouting({
        modelId: 'unsupported-model',
        phase: 'planning',
        mode: 'certification',
        registry,
      });
      assert.equal(uncertifiedDecision.routable, false);
      assert.equal(uncertifiedDecision.certified, false);
      assert.equal(uncertifiedDecision.reason, undefined);
    });

    it('assertNativeReadOnlyRoutable throws NativeReadOnlyCertificationError for uncertified task mode', () => {
      const registry = makeCertifiedRegistry();

      assert.throws(
        () => assertNativeReadOnlyRoutable({ modelId: 'unsupported-model', phase: 'planning', registry }),
        (error: unknown) => {
          assert.ok(error instanceof NativeReadOnlyCertificationError);
          assert.equal(error.modelId, 'unsupported-model');
          assert.equal(error.phase, 'planning');
          assert.equal(error.capability, 'unsupported');
          assert.match(error.message, /unsupported-model/);
          assert.match(error.message, /planning/);
          return true;
        },
      );
    });

    it('assertNativeReadOnlyRoutable does not throw for certified task mode', () => {
      const registry = makeCertifiedRegistry();

      assert.doesNotThrow(() => assertNativeReadOnlyRoutable({
        modelId: 'certified-model',
        phase: 'planning',
        registry,
      }));
    });

    it('assertNativeReadOnlyRoutable does not throw in certification mode even for uncertified model', () => {
      const registry = makeCertifiedRegistry();

      assert.doesNotThrow(() => assertNativeReadOnlyRoutable({
        modelId: 'unsupported-model',
        phase: 'planning',
        mode: 'certification',
        registry,
      }));
    });
  });
});

function serializeSelector(input: string): string {
  const parsed = parseModelSelector(input);
  assert.equal(parsed.ok, true);

  const { selector } = parsed;
  if (selector.kind === 'inherit') {
    return 'inherit';
  }
  if (selector.kind === 'pinned') {
    return selector.modelId;
  }
  return `${selector.family}:${selector.channel ?? 'stable'}`;
}

describe('parseModelSelector', () => {
  it('exports the supported channels as a frozen list', () => {
    assert.deepEqual(CHANNELS, ['stable', 'preview', 'experimental']);
    assert.equal(Object.isFrozen(CHANNELS), true);
  });

  it('exports the required family aliases as a frozen registry', () => {
    assert.equal(Object.isFrozen(FAMILY_ALIASES), true);

    for (const family of ['fable', 'opus', 'sonnet', 'haiku', 'gpt-5.5', 'gemini-pro']) {
      assert.ok(Object.hasOwn(FAMILY_ALIASES, family));
      assert.ok(Object.isFrozen(FAMILY_ALIASES[family].channels));
      assert.ok(FAMILY_ALIASES[family].channels.stable?.length);
    }
  });

  it('keeps the existing stable pins in the channel registry', () => {
    assert.equal(FAMILY_ALIASES.fable.channels.stable, 'claude-fable-5');
    assert.equal(FAMILY_ALIASES.opus.channels.stable, 'claude-opus-4-8');
    assert.equal(FAMILY_ALIASES.sonnet.channels.stable, 'claude-sonnet-5');
    assert.equal(FAMILY_ALIASES.haiku.channels.stable, 'claude-haiku-4-5-20251001');
    assert.equal(FAMILY_ALIASES['gpt-5.5'].channels.stable, 'gpt-5.5');
    assert.equal(FAMILY_ALIASES['gemini-pro'].channels.stable, 'gemini-pro');
  });

  it('parses bare family aliases', () => {
    assert.deepEqual(parseModelSelector('opus'), {
      ok: true,
      selector: { kind: 'alias', family: 'opus', channel: 'stable' },
    });
  });

  it('parses family aliases with channels', () => {
    assert.deepEqual(parseModelSelector('opus:preview'), {
      ok: true,
      selector: { kind: 'alias', family: 'opus', channel: 'preview' },
    });
    assert.deepEqual(parseModelSelector('opus-preview'), {
      ok: true,
      selector: { kind: 'alias', family: 'opus', channel: 'preview' },
    });
    assert.deepEqual(parseModelSelector('gpt-5.5-preview'), {
      ok: true,
      selector: { kind: 'alias', family: 'gpt-5.5', channel: 'preview' },
    });
  });

  it('rejects empty alias channels as malformed selector syntax', () => {
    const parsed = parseModelSelector('opus:');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'malformed_pinned_id');
    assert.equal(parsed.error.input, 'opus:');
    assert.match(parsed.error.message, /Invalid model selector/);
  });

  it('parses pinned model IDs', () => {
    assert.deepEqual(parseModelSelector('claude-opus-4-7'), {
      ok: true,
      selector: { kind: 'pinned', modelId: 'claude-opus-4-7' },
    });
    assert.deepEqual(parseModelSelector('deepseek-v4-pro[1m]'), {
      ok: true,
      selector: { kind: 'pinned', modelId: 'deepseek-v4-pro[1m]' },
    });
    assert.deepEqual(parseModelSelector('deepseek-chat'), {
      ok: true,
      selector: { kind: 'pinned', modelId: 'deepseek-chat' },
    });
    assert.deepEqual(parseModelSelector('deepseek-reasoner'), {
      ok: true,
      selector: { kind: 'pinned', modelId: 'deepseek-reasoner' },
    });
    assert.deepEqual(parseModelSelector('gpt-5.6-terra'), {
      ok: true,
      selector: { kind: 'pinned', modelId: 'gpt-5.6-terra' },
    });
  });

  it('parses inherit and trims whitespace on successful selectors', () => {
    assert.deepEqual(parseModelSelector('inherit'), {
      ok: true,
      selector: { kind: 'inherit' },
    });
    assert.deepEqual(parseModelSelector('  haiku  '), {
      ok: true,
      selector: { kind: 'alias', family: 'haiku', channel: 'stable' },
    });
    assert.deepEqual(parseModelSelector(' inherit '), {
      ok: true,
      selector: { kind: 'inherit' },
    });
  });

  it('returns typed unknown channel errors for unsupported alias channels', () => {
    for (const input of ['opus:bogus', 'opus-bogus']) {
      const parsed = parseModelSelector(input);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, 'unknown_channel');
      assert.equal(parsed.error.input, input);
      assert.match(parsed.error.message, /Known channels: stable, preview, experimental/);
    }
  });

  it('returns typed empty input errors', () => {
    for (const input of ['', '   ']) {
      const parsed = parseModelSelector(input);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, 'empty_input');
      assert.equal(parsed.error.input, input);
      assert.match(parsed.error.message, /must not be empty/);
    }
  });

  it('returns typed unknown family errors for unsupported aliases', () => {
    for (const input of ['unknown-family', 'mystral', 'Opus', 'INHERIT', 'Opus-Preview']) {
      const parsed = parseModelSelector(input);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, 'unknown_family');
      assert.equal(parsed.error.input, input);
      assert.match(parsed.error.message, /Unknown model family/);
    }
  });

  it('returns typed malformed pinned ID errors for invalid syntax', () => {
    for (const input of ['!!bad!!', 'claude_opus']) {
      const parsed = parseModelSelector(input);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, 'malformed_pinned_id');
      assert.equal(parsed.error.input, input);
      assert.match(parsed.error.message, /Invalid/);
    }
  });

  it('round-trips canonical selector forms', () => {
    const inputs = [
      'opus',
      'opus:preview',
      'claude-opus-4-8',
      'deepseek-v4-pro[1m]',
      'inherit',
      'haiku',
    ];
    assert.deepEqual(inputs.map((input) => serializeSelector(input)), [
      'opus:stable',
      'opus:preview',
      'claude-opus-4-8',
      'deepseek-v4-pro[1m]',
      'inherit',
      'haiku:stable',
    ]);
  });
});

describe('resolveSelector', () => {
  it('resolves aliases without a channel', () => {
    assert.deepEqual(resolveSelector({ kind: 'alias', family: 'opus' }), {
      requested: { kind: 'alias', family: 'opus' },
      resolved: FAMILY_ALIASES.opus.channels.stable!,
      source: 'alias',
      familyChannel: 'stable',
    });
  });

  it('resolves explicit stable alias channels with resolution metadata', () => {
    assert.deepEqual(resolveSelector({ kind: 'alias', family: 'opus', channel: 'stable' }), {
      requested: { kind: 'alias', family: 'opus', channel: 'stable' },
      resolved: FAMILY_ALIASES.opus.channels.stable!,
      source: 'alias',
      familyChannel: 'stable',
    });
  });

  it('resolves every known family alias to its recommended model ID', () => {
    for (const [family, entry] of Object.entries(FAMILY_ALIASES)) {
      const resolved = resolveSelector({ kind: 'alias', family });
      assert.equal(resolved.resolved, entry.channels.stable);
      assert.equal(resolved.source, 'alias');
      assert.equal(resolved.familyChannel, 'stable');
    }
  });

  it('throws a typed error for unpinned alias channels', () => {
    assert.throws(
      () => resolveSelector({ kind: 'alias', family: 'opus', channel: 'preview' }),
      (error: unknown) => {
        assert.ok(error instanceof ModelResolutionError);
        assert.equal(error.code, 'channel_unpinned');
        assert.deepEqual(error.selector, { kind: 'alias', family: 'opus', channel: 'preview' });
        assert.match(error.message, /No pin registered for family "opus" channel "preview"/);
        return true;
      },
    );
  });

  it('passes through valid pinned model IDs', () => {
    assert.deepEqual(resolveSelector({ kind: 'pinned', modelId: 'deepseek-v4-pro[1m]' }), {
      requested: { kind: 'pinned', modelId: 'deepseek-v4-pro[1m]' },
      resolved: 'deepseek-v4-pro[1m]',
      source: 'pinned',
    });
  });

  it('does not populate familyChannel for pinned or inherited selectors', () => {
    const pinned = resolveSelector({ kind: 'pinned', modelId: 'deepseek-v4-pro[1m]' });
    assert.equal(pinned.familyChannel, undefined);

    const inherited = resolveSelector(
      { kind: 'inherit' },
      {
        parent: {
          requested: { kind: 'alias', family: 'sonnet', channel: 'stable' },
          resolved: 'claude-sonnet-5',
          source: 'alias',
          familyChannel: 'stable',
        },
      },
    );
    assert.equal(inherited.familyChannel, undefined);
  });

  it('rejects invalid pinned model IDs', () => {
    assert.throws(() => resolveSelector({ kind: 'pinned', modelId: 'DEEPSEEK-V4-PRO' }), /Invalid model ID/);
  });

  it('throws a typed error for unknown alias families', () => {
    assert.throws(
      () => resolveSelector({ kind: 'alias', family: 'nonexistent-family' }),
      (error: unknown) => {
        assert.ok(error instanceof ModelResolutionError);
        assert.equal(error.code, 'unknown_alias');
        assert.equal(error.selector.kind, 'alias');
        assert.match(error.message, /Unknown model family alias/);
        return true;
      },
    );
  });

  it('inherits a resolved model from the parent context', () => {
    assert.deepEqual(
      resolveSelector(
        { kind: 'inherit' },
        {
          parent: {
            requested: { kind: 'alias', family: 'sonnet' },
            resolved: 'claude-sonnet-5',
            source: 'alias',
          },
        },
      ),
      {
        requested: { kind: 'inherit' },
        resolved: 'claude-sonnet-5',
        source: 'inherited',
      },
    );
  });

  it('includes the parent context ID when provided', () => {
    assert.deepEqual(
      resolveSelector(
        { kind: 'inherit' },
        {
          parent: {
            requested: { kind: 'pinned', modelId: 'gpt-5.5' },
            resolved: 'gpt-5.5',
            source: 'pinned',
          },
          parentContextId: 'agent-123',
        },
      ),
      {
        requested: { kind: 'inherit' },
        resolved: 'gpt-5.5',
        source: 'inherited',
        parentContextId: 'agent-123',
      },
    );
  });

  it('throws a typed error when inherit has no parent in context', () => {
    assert.throws(
      () => resolveSelector({ kind: 'inherit' }, { parentContextId: 'agent-123' }),
      (error: unknown) => {
        assert.ok(error instanceof ModelResolutionError);
        assert.equal(error.selector.kind, 'inherit');
        assert.match(error.message, /Cannot resolve "inherit" selector/);
        return true;
      },
    );
  });

  it('throws a typed error when inherit has no context', () => {
    assert.throws(
      () => resolveSelector({ kind: 'inherit' }),
      (error: unknown) => {
        assert.ok(error instanceof ModelResolutionError);
        assert.equal(error.selector.kind, 'inherit');
        assert.match(error.message, /Cannot resolve "inherit" selector/);
        return true;
      },
    );
  });
});

describe('resolveSelectorWithPolicy', () => {
  it('passes through a healthy eligible alias without fallback metadata', () => {
    const resolved = resolveSelectorWithPolicy(
      { kind: 'alias', family: 'opus' },
      undefined,
      {
        taskType: 'review',
        difficulty: 'moderate',
        quotaState: makeQuotaSnapshot(DEFAULT_MODEL_REGISTRY),
        registryOverride: DEFAULT_MODEL_REGISTRY,
      },
    );

    assert.deepEqual(resolved, {
      requested: { kind: 'alias', family: 'opus' },
      resolved: 'claude-opus-4-8',
      source: 'alias',
      familyChannel: 'stable',
    });
  });

  it('falls back to sonnet when opus quota is exhausted', () => {
    const resolved = resolveSelectorWithPolicy(
      { kind: 'alias', family: 'opus' },
      undefined,
      {
        taskType: 'review',
        difficulty: 'moderate',
        quotaState: makeQuotaSnapshot(DEFAULT_MODEL_REGISTRY, {
          'claude-opus-4-8': 'exhausted',
        }),
        registryOverride: DEFAULT_MODEL_REGISTRY,
      },
    );

    assert.deepEqual(resolved, {
      requested: { kind: 'alias', family: 'opus' },
      resolved: 'claude-sonnet-5',
      source: 'fallback',
      familyChannel: 'stable',
      fallbackReason: 'quota-exhausted',
    });
  });

  it('returns a policy downgrade when cost policy blocks the requested model', () => {
    const resolved = resolveSelectorWithPolicy(
      { kind: 'alias', family: 'opus' },
      undefined,
      {
        taskType: 'review',
        difficulty: 'moderate',
        maxCostTier: 'strong_generalist',
        quotaState: makeQuotaSnapshot(DEFAULT_MODEL_REGISTRY),
        registryOverride: DEFAULT_MODEL_REGISTRY,
      },
    );

    assert.deepEqual(resolved, {
      requested: { kind: 'alias', family: 'opus' },
      resolved: 'claude-sonnet-5',
      source: 'policy',
      familyChannel: 'stable',
      fallbackReason: 'disabled-by-policy',
    });
  });

  it('treats an alias target missing from the registry as unavailable', () => {
    const registry: ModelRegistry = {
      models: {
        'claude-sonnet-5': DEFAULT_MODEL_REGISTRY.models['claude-sonnet-5'],
        'gpt-5.5': DEFAULT_MODEL_REGISTRY.models['gpt-5.5'],
      },
      ladders: {
        review: ['claude-sonnet-5', 'gpt-5.5'],
      },
    };

    const resolved = resolveSelectorWithPolicy(
      { kind: 'alias', family: 'opus' },
      undefined,
      {
        taskType: 'review',
        difficulty: 'moderate',
        quotaState: makeQuotaSnapshot(registry),
        registryOverride: registry,
      },
    );

    assert.deepEqual(resolved, {
      requested: { kind: 'alias', family: 'opus' },
      resolved: 'claude-sonnet-5',
      source: 'fallback',
      familyChannel: 'stable',
      fallbackReason: 'unavailable',
    });
  });

  it('preserves the original alias family and channel during fallback', () => {
    const resolved = resolveSelectorWithPolicy(
      { kind: 'alias', family: 'opus', channel: 'stable' },
      undefined,
      {
        taskType: 'review',
        difficulty: 'moderate',
        quotaState: makeQuotaSnapshot(DEFAULT_MODEL_REGISTRY, {
          'claude-opus-4-8': 'exhausted',
        }),
        registryOverride: DEFAULT_MODEL_REGISTRY,
      },
    );

    assert.equal(resolved.requested.kind, 'alias');
    assert.equal(resolved.requested.family, 'opus');
    assert.equal(resolved.familyChannel, 'stable');
    assert.equal(resolved.fallbackReason, 'quota-exhausted');
  });

  it('throws a typed error when no viable substitute exists', () => {
    const registry: ModelRegistry = {
      models: {
        'claude-opus-4-8': DEFAULT_MODEL_REGISTRY.models['claude-opus-4-8'],
        'gpt-5.5': DEFAULT_MODEL_REGISTRY.models['gpt-5.5'],
      },
      ladders: {
        review: ['claude-opus-4-8', 'gpt-5.5'],
      },
    };

    assert.throws(
      () =>
        resolveSelectorWithPolicy(
          { kind: 'alias', family: 'opus' },
          undefined,
          {
            taskType: 'review',
            difficulty: 'moderate',
            maxCostTier: 'strong_generalist',
            quotaState: makeQuotaSnapshot(registry, {
              'claude-opus-4-8': 'exhausted',
              'gpt-5.5': 'exhausted',
            }),
            registryOverride: registry,
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ModelPolicyResolutionError);
        assert.equal(error.code, 'no_viable_substitute');
        assert.equal(error.reason, 'quota-exhausted');
        assert.match(error.message, /No viable substitute/);
        return true;
      },
    );
  });

  it('prefers the quota outcome when quota and policy both block the request', () => {
    const resolved = resolveSelectorWithPolicy(
      { kind: 'alias', family: 'opus' },
      undefined,
      {
        taskType: 'review',
        difficulty: 'moderate',
        maxCostTier: 'strong_generalist',
        quotaState: makeQuotaSnapshot(DEFAULT_MODEL_REGISTRY, {
          'claude-opus-4-8': 'exhausted',
        }),
        registryOverride: DEFAULT_MODEL_REGISTRY,
      },
    );

    assert.equal(resolved.source, 'fallback');
    assert.equal(resolved.fallbackReason, 'quota-exhausted');
  });

  it('prefers a same-vendor nearest downgrade over a higher-ranked cross-vendor fallback', () => {
    const resolved = resolveSelectorWithPolicy(
      { kind: 'alias', family: 'opus' },
      undefined,
      {
        taskType: 'review',
        difficulty: 'moderate',
        quotaState: makeQuotaSnapshot(DEFAULT_MODEL_REGISTRY, {
          'claude-opus-4-8': 'exhausted',
        }),
        registryOverride: DEFAULT_MODEL_REGISTRY,
      },
    );

    assert.equal(resolved.resolved, 'claude-sonnet-5');
  });
});

describe('canonical supported-model helpers', () => {
  it('lists supported stage-compatible models and excludes blocked lifecycle entries', () => {
    const registry: ModelRegistry = {
      models: {
        'native-coder': makeCapabilities({
          qualityScores: { coding: 90, planning: 10 },
          // Above the built-in coding floor (144,384) so the new
          // context-window predicate does not exclude this test fixture.
          contextWindowTokens: 200_000,
          supportedModel: {
            lifecycle: 'supported',
            stages: ['coding'],
            routingEligible: true,
          },
        }),
        'blocked-coder': makeCapabilities({
          qualityScores: { coding: 95 },
          supportedModel: {
            lifecycle: 'blocked',
            stages: ['coding'],
          },
        }),
        'planner-only': makeCapabilities({
          qualityScores: { planning: 90, coding: 0 },
          supportedModel: {
            lifecycle: 'supported',
            stages: ['planning'],
          },
        }),
        'no-tools-coder': makeCapabilities({
          qualityScores: { coding: 91 },
          toolSupport: 'none',
          supportedModel: {
            lifecycle: 'supported',
            stages: ['coding'],
          },
        }),
      },
      ladders: {},
    };

    assert.deepEqual(listSupportedModelsForStage('coder', registry), ['native-coder']);
    assert.equal(explainModelSupportExclusion('blocked-coder', 'coding', registry), 'blocked-lifecycle');
    assert.equal(explainModelSupportExclusion('planner-only', 'coding', registry), 'stage-incompatible');
    assert.equal(explainModelSupportExclusion('no-tools-coder', 'coding', registry), 'tool-support-insufficient');
  });

  it('retains retired native-openrouter aliases for attribution but excludes them from stages', () => {
    for (const alias of ['deepseek-coder-v2', 'gemini-2.0-flash', 'grok-code-fast', 'qwen-2.5-coder-32b']) {
      const capabilities = DEFAULT_MODEL_REGISTRY.models[alias];
      assert.ok(capabilities, `${alias} should remain in the registry`);
      assert.equal(capabilities.supportedModel?.lifecycle, 'blocked', `${alias} should be lifecycle-blocked`);
      assert.equal(explainModelSupportExclusion(alias, 'coding'), 'blocked-lifecycle');
      assert.equal(listSupportedModelsForStage('coding').includes(alias), false);
    }
    assert.equal(DEFAULT_MODEL_REGISTRY.models['qwen-2.5-coder-32b'].toolSupport, 'none');
  });

  it('requires tool support for every supported Wavemill stage', () => {
    for (const stage of ['expansion', 'planning', 'coding', 'review'] as const) {
      assert.equal(stageRequiresTools(stage), true);
      assert.equal(hasSufficientToolSupport(makeCapabilities({ toolSupport: 'none' }), stage), false);
      assert.equal(hasSufficientToolSupport(makeCapabilities({ toolSupport: 'basic' }), stage), true);
    }
  });

  it('does not leave selectable native-openrouter aliases without wire IDs or tool support', () => {
    for (const [alias, capabilities] of Object.entries(DEFAULT_MODEL_REGISTRY.models)) {
      if (capabilities.agent !== 'native-openrouter') continue;
      if (capabilities.supportedModel?.lifecycle === 'blocked') continue;
      assert.notEqual(resolveOpenRouterModelId(alias), null, `${alias} should resolve to an OpenRouter wire ID`);
      assert.notEqual(capabilities.toolSupport, 'none', `${alias} should provide tool support`);
    }
  });

  it('resolves provider-native identity and required phase metadata', () => {
    const registry: ModelRegistry = {
      models: {
        'wavemill-alias': makeCapabilities({
          supportedModel: {
            wavemillAlias: 'wavemill-alias',
            providerNativeId: 'provider/native-id',
            provider: 'openrouter',
            transport: 'openai-completions',
            requiredCertificationPhaseByStage: {
              coding: 'patch',
              planning: 'workflow',
            },
          },
        }),
      },
      ladders: {},
    };

    assert.deepEqual(resolveProviderNativeModelId('wavemill-alias', registry), {
      wavemillAlias: 'wavemill-alias',
      providerNativeId: 'provider/native-id',
      provider: 'openrouter',
      transport: 'openai-completions',
    });
    assert.equal(getRequiredCertificationPhaseForStage('wavemill-alias', 'coder', registry), 'patch');
    assert.equal(getRequiredCertificationPhaseForStage('wavemill-alias', 'planner', registry), 'workflow');
  });

  // Regression: kimi-k2 was declared at 200_000 while the OpenRouter endpoint
  // enforces 131_072. A coding launch packed ~131_182 tokens and died with a
  // 400 that no pre-flight check could have caught, because the value it would
  // have checked against was itself wrong.
  //
  // Overstating a context window is the unsafe direction: it lets through
  // prompts the provider will reject. Understating only wastes capacity. These
  // pin the values that were corrected against the live catalog so a future
  // edit cannot silently reintroduce an overstatement.
  it('declares context windows that do not exceed the provider limit', () => {
    const registry = DEFAULT_MODEL_REGISTRY;
    const knownProviderLimits: Record<string, number> = {
      'kimi-k2': 131_072,
      'kimi-k2-thinking': 262_144,
      'glm-5.2': 1_048_576,
      'llama-4-maverick': 1_048_576,
      'llama-4-scout': 1_310_720,
      'qwen-3-coder': 262_144,
      'qwen-2.5-coder-32b': 32_768,
      'gemini-2.5-pro': 1_048_576,
      'gemini-2.5-flash': 1_048_576,
    };

    for (const [alias, limit] of Object.entries(knownProviderLimits)) {
      const declared = registry.models[alias]?.contextWindowTokens;
      assert.ok(declared !== undefined, `${alias} should exist in the registry`);
      assert.ok(
        declared <= limit,
        `${alias} declares ${declared} but the provider enforces ${limit}; overstating lets through prompts the provider rejects`,
      );
    }
  });

  it('coding stage has a context window floor', () => {
    const floor = getStageContextWindowFloor('coding');
    assert.ok(floor !== undefined, 'coding stage should have a context window floor');
    assert.equal(floor, 144_384, 'coding stage should have a 144,384 token floor');
  });

  it('planning, review, and expansion stages have no context window floor initially', () => {
    assert.equal(getStageContextWindowFloor('planning'), undefined, 'planning stage should have no floor');
    assert.equal(getStageContextWindowFloor('review'), undefined, 'review stage should have no floor');
    assert.equal(getStageContextWindowFloor('expansion'), undefined, 'expansion stage should have no floor');
  });

  it('hasSufficientContextWindow returns true when context window meets or exceeds floor', () => {
    // Model with sufficient context window
    const sufficientModel = { contextWindowTokens: 200_000 };
    assert.ok(hasSufficientContextWindow(sufficientModel, 'coding'), 'model with 200k context window should be sufficient for coding');
    
    // Model exactly meeting the floor
    const exactModel = { contextWindowTokens: 144_384 };
    assert.ok(hasSufficientContextWindow(exactModel, 'coding'), 'model with exactly 144,384 context window should be sufficient');
  });

  it('hasSufficientContextWindow returns false when context window is below floor', () => {
    const insufficientModel = { contextWindowTokens: 131_072 };
    assert.ok(!hasSufficientContextWindow(insufficientModel, 'coding'), 'model with 131,072 context window should be insufficient for coding');
  });

  it('hasSufficientContextWindow returns true for stages without floors', () => {
    const model = { contextWindowTokens: 32_768 };
    assert.ok(hasSufficientContextWindow(model, 'planning'), 'model should be sufficient for planning (no floor)');
    assert.ok(hasSufficientContextWindow(model, 'review'), 'model should be sufficient for review (no floor)');
    assert.ok(hasSufficientContextWindow(model, 'expansion'), 'model should be sufficient for expansion (no floor)');
  });

  it('kimi-k2 is excluded from coding due to insufficient context window', () => {
    const reason = explainModelSupportExclusion('kimi-k2', 'coding');
    assert.equal(reason, 'context-window-insufficient', 'kimi-k2 should be excluded from coding due to context window');
    
    // But still eligible for planning (no floor)
    const planningReason = explainModelSupportExclusion('kimi-k2', 'planning');
    assert.notEqual(planningReason, 'context-window-insufficient', 'kimi-k2 should be eligible for planning');
  });

  it('mistral-large-2 is excluded from coding due to insufficient context window', () => {
    const reason = explainModelSupportExclusion('mistral-large-2', 'coding');
    assert.equal(reason, 'context-window-insufficient', 'mistral-large-2 should be excluded from coding due to context window');
  });

  it('llama-3.3-70b is excluded from coding due to insufficient context window', () => {
    const reason = explainModelSupportExclusion('llama-3.3-70b', 'coding');
    assert.equal(reason, 'context-window-insufficient', 'llama-3.3-70b should be excluded from coding due to context window');
  });

  // deepseek-coder-v2 and qwen-2.5-coder-32b are lifecycle-blocked by prior
  // work (HOK-2773); blocked-lifecycle is checked before the context-window
  // predicate. Their windows would also fail the coding floor if they were
  // ever unblocked, which the listSupportedModelsForStage assertion below
  // still covers. The point here is that lifecycle-blocked selection remains
  // the primary reason for these two.
  it('deepseek-coder-v2 stays excluded from coding (lifecycle-blocked; context window would also fail)', () => {
    const reason = explainModelSupportExclusion('deepseek-coder-v2', 'coding');
    assert.equal(reason, 'blocked-lifecycle');
    const declaredWindow = DEFAULT_MODEL_REGISTRY.models['deepseek-coder-v2'].contextWindowTokens;
    assert.ok(
      declaredWindow < 144_384,
      `deepseek-coder-v2 declares ${declaredWindow} which is already below the coding floor`,
    );
  });

  it('qwen-2.5-coder-32b stays excluded from coding (lifecycle-blocked; context window would also fail)', () => {
    const reason = explainModelSupportExclusion('qwen-2.5-coder-32b', 'coding');
    assert.equal(reason, 'blocked-lifecycle');
    const declaredWindow = DEFAULT_MODEL_REGISTRY.models['qwen-2.5-coder-32b'].contextWindowTokens;
    assert.ok(
      declaredWindow < 144_384,
      `qwen-2.5-coder-32b declares ${declaredWindow} which is already below the coding floor`,
    );
  });

  it('qwen-2.5-72b is excluded from coding due to insufficient context window', () => {
    const reason = explainModelSupportExclusion('qwen-2.5-72b', 'coding');
    assert.equal(reason, 'context-window-insufficient', 'qwen-2.5-72b should be excluded from coding due to context window');
  });

  it('models with sufficient context windows are not excluded', () => {
    const reason = explainModelSupportExclusion('claude-sonnet-5', 'coding');
    assert.notEqual(reason, 'context-window-insufficient', 'claude-sonnet-5 should not be excluded from coding');
  });

  it('listSupportedModelsForStage excludes context-window-insufficient models', () => {
    const codingModels = listSupportedModelsForStage('coding');
    assert.ok(!codingModels.includes('kimi-k2'), 'kimi-k2 should not be in coding models');
    assert.ok(!codingModels.includes('mistral-large-2'), 'mistral-large-2 should not be in coding models');
    assert.ok(!codingModels.includes('llama-3.3-70b'), 'llama-3.3-70b should not be in coding models');
    assert.ok(!codingModels.includes('deepseek-coder-v2'), 'deepseek-coder-v2 should not be in coding models');
    assert.ok(!codingModels.includes('qwen-2.5-coder-32b'), 'qwen-2.5-coder-32b should not be in coding models');
    assert.ok(!codingModels.includes('qwen-2.5-72b'), 'qwen-2.5-72b should not be in coding models');

    // But they should still be eligible for planning
    const planningModels = listSupportedModelsForStage('planning');
    assert.ok(planningModels.includes('kimi-k2'), 'kimi-k2 should be in planning models');
    assert.ok(planningModels.includes('mistral-large-2'), 'mistral-large-2 should be in planning models');
  });

  // REQ-F2: floors are configurable via .wavemill-config.json. A configured
  // floor overrides the built-in derived floor for that stage; unconfigured
  // stages fall back to the built-in (or fail-open when there is no built-in).
  it('.wavemill-config.json contextWindowFloors.<stage> overrides the built-in floor', async () => {
    const { clearConfigCache } = await import('./config.ts');
    const tmpRepo = mkdtempSync(join(tmpdir(), 'wm-cwf-'));
    try {
      // Configure a planning floor higher than kimi-k2's declared 131,072.
      writeFileSync(
        join(tmpRepo, '.wavemill-config.json'),
        JSON.stringify({ contextWindowFloors: { planning: 200_000 } }),
      );
      clearConfigCache(tmpRepo);
      assert.equal(getStageContextWindowFloor('planning', tmpRepo), 200_000);
      // Coding still uses the built-in floor (200_000 not configured for coding).
      assert.equal(getStageContextWindowFloor('coding', tmpRepo), 144_384);
    } finally {
      clearConfigCache(tmpRepo);
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('.wavemill-config.json contextWindowFloors.coding overrides the built-in coding floor', async () => {
    const { clearConfigCache } = await import('./config.ts');
    const tmpRepo = mkdtempSync(join(tmpdir(), 'wm-cwf-'));
    try {
      // Lower the coding floor via config; a model with 100k would now be
      // eligible even though the built-in default excludes it.
      writeFileSync(
        join(tmpRepo, '.wavemill-config.json'),
        JSON.stringify({ contextWindowFloors: { coding: 100_000 } }),
      );
      clearConfigCache(tmpRepo);
      assert.equal(getStageContextWindowFloor('coding', tmpRepo), 100_000);
      assert.ok(hasSufficientContextWindow({ contextWindowTokens: 131_072 }, 'coding', tmpRepo));
    } finally {
      clearConfigCache(tmpRepo);
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
