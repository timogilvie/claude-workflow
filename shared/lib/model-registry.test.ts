import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelRegistry } from './model-registry.ts';
import {
  FAMILY_ALIASES,
  getConfiguredModelsForDescriptor,
  getConfiguredModelsForDescriptorStage,
  configuredDeepSeekModelIds,
  DEFAULT_MODEL_REGISTRY,
  getEffectiveRegistry,
  getLadder,
  getModel,
  isKnownModelId,
  mergeModelRegistry,
  ModelResolutionError,
  parseModelSelector,
  rankCandidates,
  resolveSelector,
  validateModelId,
} from './model-registry.ts';
import { clearConfigCache } from './config.ts';

type TaskType = 'routing' | 'planning' | 'coding' | 'review' | 'classify';

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

describe('model-registry', () => {
  it('seeds the canonical Claude defaults with complete metadata', () => {
    const expectedModels = [
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-pro[1m]',
      'gpt-5.5',
      'gpt-5.4',
    ];

    assert.deepEqual(Object.keys(DEFAULT_MODEL_REGISTRY.models).sort(), expectedModels.sort());

    for (const modelId of expectedModels) {
      const model = DEFAULT_MODEL_REGISTRY.models[modelId];
      assert.ok(model.vendor.length > 0);
      assert.ok(model.strengths.length > 0);
      assert.ok(model.weaknesses.length > 0);

      for (const taskType of ['routing', 'planning', 'coding', 'review', 'classify'] as TaskType[]) {
        assert.equal(typeof model.qualityScores[taskType], 'number');
      }
    }
  });

  it('getModel returns undefined for unknown or empty IDs', () => {
    assert.equal(getModel(DEFAULT_MODEL_REGISTRY, 'missing-model'), undefined);
    assert.equal(getModel(DEFAULT_MODEL_REGISTRY, ''), undefined);
  });

  it('getLadder returns configured default ladders', () => {
    assert.equal(getLadder(DEFAULT_MODEL_REGISTRY, 'review')[0], 'claude-opus-4-7');
    assert.deepEqual(getLadder(DEFAULT_MODEL_REGISTRY, 'classify'), [
      'claude-haiku-4-5-20251001',
      'deepseek-v4-flash',
      'claude-sonnet-4-6',
      'gpt-5.5',
      'gpt-5.4',
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
        A: {
          vendor: 'test',
          class: 'strong_generalist',
          strengths: ['balanced'],
          weaknesses: ['none'],
          qualityScores: { ...makeScores(0), review: 90 },
        },
        B: {
          vendor: 'test',
          class: 'strong_generalist',
          strengths: ['balanced'],
          weaknesses: ['none'],
          qualityScores: { ...makeScores(0), review: 80 },
        },
        C: {
          vendor: 'test',
          class: 'strong_generalist',
          strengths: ['balanced'],
          weaknesses: ['none'],
          qualityScores: { ...makeScores(0), review: 70 },
        },
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
        economy: {
          vendor: 'test',
          class: 'fast_economy',
          strengths: ['speed'],
          weaknesses: ['depth'],
          qualityScores: { ...makeScores(0), planning: 90 },
        },
        frontier: {
          vendor: 'test',
          class: 'frontier',
          strengths: ['depth'],
          weaknesses: ['cost'],
          qualityScores: { ...makeScores(0), planning: 90 },
        },
      },
      ladders: {},
    };

    assert.deepEqual(getLadder(registry, 'planning'), ['frontier', 'economy']);
  });

  it('getLadder breaks remaining ties by model ID', () => {
    const registry: ModelRegistry = {
      models: {
        zebra: {
          vendor: 'test',
          class: 'strong_generalist',
          strengths: ['balanced'],
          weaknesses: ['none'],
          qualityScores: { ...makeScores(0), coding: 88 },
        },
        alpha: {
          vendor: 'test',
          class: 'strong_generalist',
          strengths: ['balanced'],
          weaknesses: ['none'],
          qualityScores: { ...makeScores(0), coding: 88 },
        },
      },
      ladders: {},
    };

    assert.deepEqual(getLadder(registry, 'coding'), ['alpha', 'zebra']);
  });

  it('getLadder returns an empty derived ladder when no model has a positive score', () => {
    const registry: ModelRegistry = {
      models: {
        alpha: {
          vendor: 'test',
          class: 'strong_generalist',
          strengths: ['balanced'],
          weaknesses: ['none'],
          qualityScores: makeScores(0),
        },
      },
      ladders: {},
    };

    assert.deepEqual(getLadder(registry, 'review'), []);
  });

  it('rankCandidates filters excluded models and stays deterministic', () => {
    const once = rankCandidates(DEFAULT_MODEL_REGISTRY, 'review', {
      excluded: ['claude-sonnet-4-6'],
    });
    const twice = rankCandidates(DEFAULT_MODEL_REGISTRY, 'review', {
      excluded: ['claude-sonnet-4-6'],
    });
    const thrice = rankCandidates(DEFAULT_MODEL_REGISTRY, 'review', {
      excluded: ['claude-sonnet-4-6'],
    });

    assert.deepEqual(once, [
      'claude-opus-4-7',
      'gpt-5.5',
      'gpt-5.4',
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
        excluded: ['claude-haiku-4-5-20251001', 'deepseek-v4-flash', 'claude-sonnet-4-6', 'gpt-5.5', 'gpt-5.4'],
      }),
      []
    );
  });

  it('rankCandidates returns the full ladder when no exclusions are provided', () => {
    assert.deepEqual(rankCandidates(DEFAULT_MODEL_REGISTRY, 'coding'), [
      'gpt-5.5',
      'gpt-5.4',
      'deepseek-v4-pro',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'deepseek-chat',
      'deepseek-v4-flash',
      'claude-haiku-4-5-20251001',
    ]);
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
        },
      },
    });

    assert.equal(merged.models['gpt-5.6'].vendor, 'openai');
    assert.equal(merged.models['gpt-5.6'].qualityScores.planning, 90);
  });

  it('exposes DeepSeek metadata in the default registry', () => {
    const pro = DEFAULT_MODEL_REGISTRY.models['deepseek-v4-pro'];
    const flash = DEFAULT_MODEL_REGISTRY.models['deepseek-v4-flash'];
    const oneMillion = DEFAULT_MODEL_REGISTRY.models['deepseek-v4-pro[1m]'];

    assert.equal(pro.vendor, 'deepseek');
    assert.equal(pro.class, 'strong_generalist');
    assert.equal(pro.defaultLadderEligible, false);
    assert.equal(pro.contextWindowTokens, 1_000_000);
    assert.equal(pro.agent, 'claude');
    assert.equal(pro.pricing?.inputCostPerMTok, 0.435);
    assert.equal(pro.pricing?.outputCostPerMTok, 0.87);
    assert.equal(flash.class, 'fast_economy');
    assert.equal(flash.pricing?.inputCostPerMTok, 0.14);
    assert.equal(oneMillion.contextWindowTokens, 1_000_000);
  });

  it('recognizes configured DeepSeek IDs and validates bracket syntax', () => {
    assert.deepEqual(configuredDeepSeekModelIds(DEFAULT_MODEL_REGISTRY), [
      'deepseek-chat',
      'deepseek-reasoner',
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
        review: ['claude-opus-4-7', 'missing-model', 'claude-sonnet-4-6'],
      },
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      assert.deepEqual(getLadder(merged, 'review'), ['claude-opus-4-7', 'claude-sonnet-4-6']);
      assert.deepEqual(getLadder(merged, 'review'), ['claude-opus-4-7', 'claude-sonnet-4-6']);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missing-model/);
  });

  it('getEffectiveRegistry merges repo config into the seeded defaults', () => {
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
            coding: ['claude-opus-4-7', 'claude-sonnet-4-6'],
          },
        },
      });

      const registry = getEffectiveRegistry(repoDir);
      assert.equal(registry.models['claude-opus-4-7'].qualityScores.coding, 99);
      assert.deepEqual(getLadder(registry, 'coding'), ['claude-opus-4-7', 'claude-sonnet-4-6']);
    } finally {
      clearConfigCache();
      cleanUp(repoDir);
    }
  });

  it('prefers stage-specific router availability for descriptor stages', () => {
    const repoDir = makeTempRepo();

    try {
      writeConfig(repoDir, {
        router: {
          availableModels: {
            planner: ['gpt-5.5', 'claude-opus-4-7'],
            coder: ['gpt-5.4', 'gpt-5.3-codex'],
            reviewer: ['claude-sonnet-4-6'],
          },
        },
        modelRegistry: {
          models: {
            'gpt-5.3-codex': {
              vendor: 'openai',
              class: 'strong_generalist',
              strengths: ['coding'],
              weaknesses: ['none'],
              qualityScores: { coding: 89 },
              agent: 'codex',
            },
          },
        },
      });
      clearConfigCache(repoDir);

      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'planner'), ['gpt-5.5', 'claude-opus-4-7']);
      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'coder'), ['gpt-5.4', 'gpt-5.3-codex']);
      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'reviewer'), ['claude-sonnet-4-6']);
      assert.deepEqual(getConfiguredModelsForDescriptor(repoDir), [
        'gpt-5.5',
        'claude-opus-4-7',
        'gpt-5.4',
        'gpt-5.3-codex',
        'claude-sonnet-4-6',
      ]);
    } finally {
      clearConfigCache(repoDir);
      cleanUp(repoDir);
    }
  });

  it('falls back to shared router models for every descriptor stage', () => {
    const repoDir = makeTempRepo();

    try {
      writeConfig(repoDir, {
        router: {
          models: ['gpt-5.4', 'claude-sonnet-4-6'],
        },
      });
      clearConfigCache(repoDir);

      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'planner'), ['gpt-5.4', 'claude-sonnet-4-6']);
      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'coder'), ['gpt-5.4', 'claude-sonnet-4-6']);
      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'reviewer'), ['gpt-5.4', 'claude-sonnet-4-6']);
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

      assert.deepEqual(
        getConfiguredModelsForDescriptorStage(repoDir, 'planner'),
        getLadder(getEffectiveRegistry(repoDir), 'planning'),
      );
      assert.deepEqual(
        getConfiguredModelsForDescriptorStage(repoDir, 'coder'),
        getLadder(getEffectiveRegistry(repoDir), 'coding'),
      );
      assert.deepEqual(
        getConfiguredModelsForDescriptorStage(repoDir, 'reviewer'),
        getLadder(getEffectiveRegistry(repoDir), 'review'),
      );

      const descriptorModels = getConfiguredModelsForDescriptor(repoDir);
      assert.ok(descriptorModels.length > 0);
      assert.ok(descriptorModels.includes('gpt-5.5'));
      assert.ok(descriptorModels.includes('gpt-5.4'));
      assert.notDeepEqual(descriptorModels, [
        'claude-sonnet-4-6',
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

  it('uses model registry ladder overrides when router availability is absent', () => {
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

      assert.deepEqual(getConfiguredModelsForDescriptorStage(repoDir, 'coder'), ['custom-codex-model']);
    } finally {
      clearConfigCache(repoDir);
      cleanUp(repoDir);
    }
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
  return selector.channel ? `${selector.family}:${selector.channel}` : selector.family;
}

describe('parseModelSelector', () => {
  it('exports the required family aliases as a frozen registry', () => {
    assert.equal(Object.isFrozen(FAMILY_ALIASES), true);

    for (const family of ['opus', 'sonnet', 'haiku', 'gpt-5.5', 'gemini-pro']) {
      assert.ok(Object.hasOwn(FAMILY_ALIASES, family));
      assert.ok(FAMILY_ALIASES[family].recommendedModelId.length > 0);
    }
  });

  it('parses bare family aliases', () => {
    assert.deepEqual(parseModelSelector('opus'), {
      ok: true,
      selector: { kind: 'alias', family: 'opus' },
    });
  });

  it('parses family aliases with channels', () => {
    assert.deepEqual(parseModelSelector('opus:beta'), {
      ok: true,
      selector: { kind: 'alias', family: 'opus', channel: 'beta' },
    });
    assert.deepEqual(parseModelSelector('opus:beta:gamma'), {
      ok: true,
      selector: { kind: 'alias', family: 'opus', channel: 'beta:gamma' },
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
  });

  it('parses inherit and trims whitespace on successful selectors', () => {
    assert.deepEqual(parseModelSelector('inherit'), {
      ok: true,
      selector: { kind: 'inherit' },
    });
    assert.deepEqual(parseModelSelector('  haiku  '), {
      ok: true,
      selector: { kind: 'alias', family: 'haiku' },
    });
    assert.deepEqual(parseModelSelector(' inherit '), {
      ok: true,
      selector: { kind: 'inherit' },
    });
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
    for (const input of ['unknown-family', 'mystral', 'Opus', 'INHERIT']) {
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
    const inputs = ['opus', 'opus:beta', 'claude-opus-4-7', 'deepseek-v4-pro[1m]', 'inherit', 'haiku'];
    assert.deepEqual(inputs.map((input) => serializeSelector(input)), inputs);
  });
});

describe('resolveSelector', () => {
  it('resolves aliases without a channel', () => {
    assert.deepEqual(resolveSelector({ kind: 'alias', family: 'opus' }), {
      requested: { kind: 'alias', family: 'opus' },
      resolved: FAMILY_ALIASES.opus.recommendedModelId,
      source: 'alias',
    });
  });

  it('passes through alias channels into the resolution metadata', () => {
    assert.deepEqual(resolveSelector({ kind: 'alias', family: 'opus', channel: 'beta' }), {
      requested: { kind: 'alias', family: 'opus', channel: 'beta' },
      resolved: FAMILY_ALIASES.opus.recommendedModelId,
      source: 'alias',
      familyChannel: 'beta',
    });
  });

  it('resolves every known family alias to its recommended model ID', () => {
    for (const [family, entry] of Object.entries(FAMILY_ALIASES)) {
      const resolved = resolveSelector({ kind: 'alias', family });
      assert.equal(resolved.resolved, entry.recommendedModelId);
      assert.equal(resolved.source, 'alias');
    }
  });

  it('passes through valid pinned model IDs', () => {
    assert.deepEqual(resolveSelector({ kind: 'pinned', modelId: 'deepseek-v4-pro[1m]' }), {
      requested: { kind: 'pinned', modelId: 'deepseek-v4-pro[1m]' },
      resolved: 'deepseek-v4-pro[1m]',
      source: 'pinned',
    });
  });

  it('rejects invalid pinned model IDs', () => {
    assert.throws(() => resolveSelector({ kind: 'pinned', modelId: 'DEEPSEEK-V4-PRO' }), /Invalid model ID/);
  });

  it('inherits a resolved model from the parent context', () => {
    assert.deepEqual(
      resolveSelector(
        { kind: 'inherit' },
        {
          parent: {
            requested: { kind: 'alias', family: 'sonnet' },
            resolved: 'claude-sonnet-4-6',
            source: 'alias',
          },
        },
      ),
      {
        requested: { kind: 'inherit' },
        resolved: 'claude-sonnet-4-6',
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
