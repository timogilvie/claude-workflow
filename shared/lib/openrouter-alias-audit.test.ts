import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// Unit tests for the pure openrouter-alias-audit module (HOK-2773).
import {
  auditRegistryAgainstCatalog,
  auditRegistryAliasResolution,
  listNativeOpenRouterRegistryModels,
  renderAliasAuditReport,
  type AliasAuditFinding,
  type AliasAuditReport,
} from './openrouter-alias-audit.ts';
import {
  DEFAULT_MODEL_REGISTRY,
  type ModelLifecycleStatus,
  type ModelRegistry,
  type SupportedModelStage,
  type ToolSupport,
} from './model-registry.ts';
import type { OpenRouterModel } from './openrouter-catalog.ts';

function makeCatalogModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: overrides.id ?? 'qwen/qwen3-coder',
    context_length: overrides.context_length ?? 262_144,
    supported_parameters: overrides.supported_parameters ?? ['tools'],
    ...overrides,
  };
}

function catalogFrom(models: OpenRouterModel[]): Map<string, OpenRouterModel> {
  const map = new Map<string, OpenRouterModel>();
  for (const model of models) {
    map.set(model.id, model);
  }
  return map;
}

interface NativeModelOpts {
  alias: string;
  providerNativeId: string;
  lifecycle?: ModelLifecycleStatus;
  toolSupport?: ToolSupport;
  contextWindowTokens?: number;
  stages?: SupportedModelStage[];
}

/**
 * Build a minimal native-openrouter model entry. The alias must exist in the
 * launch-priority fixture so `resolveOpenRouterModelId` can resolve it.
 */
function makeNativeModel(opts: NativeModelOpts): ModelRegistry['models'][string] {
  return {
    vendor: 'test',
    class: 'strong_generalist',
    strengths: ['s'],
    weaknesses: ['w'],
    qualityScores: { routing: 0, planning: 0, coding: 90, review: 0, classify: 0 },
    contextWindowTokens: opts.contextWindowTokens ?? 131_072,
    toolSupport: opts.toolSupport ?? 'basic',
    multimodal: { text: true, image: false },
    latencyTier: 'standard',
    reasoningTier: 'standard',
    costPerMillionInputTokensUsd: 1,
    costPerMillionOutputTokensUsd: 2,
    agent: 'native-openrouter',
    supportedModel: {
      wavemillAlias: opts.alias,
      providerNativeId: opts.providerNativeId,
      provider: 'openrouter',
      transport: 'openai-completions',
      stages: opts.stages ?? ['coding'],
      lifecycle: opts.lifecycle ?? 'supported',
      routingEligible: true,
    },
  };
}

/** A small synthetic registry with one model per audit reason. */
function makeSyntheticRegistry(): ModelRegistry {
  return {
    models: {
      'qwen-3-coder': makeNativeModel({
        alias: 'qwen-3-coder',
        providerNativeId: 'qwen/qwen3-coder',
        contextWindowTokens: 262_144,
      }),
      'grok-code-fast': makeNativeModel({
        alias: 'grok-code-fast',
        providerNativeId: 'x-ai/grok-code-fast-1',
        lifecycle: 'blocked',
      }),
      'qwen-2.5-coder-32b': makeNativeModel({
        alias: 'qwen-2.5-coder-32b',
        providerNativeId: 'qwen/qwen-2.5-coder-32b-instruct',
        lifecycle: 'blocked',
        // toolSupport 'basic' (not 'none') so the no-tool-support finding fires
        // when the catalog advertises no tools. The real registry uses 'none'.
        toolSupport: 'basic',
        contextWindowTokens: 32_768,
      }),
      'kimi-k2': makeNativeModel({
        alias: 'kimi-k2',
        providerNativeId: 'moonshotai/kimi-k2',
        contextWindowTokens: 200_000,
      }),
      'deepseek-coder-v2': makeNativeModel({
        alias: 'deepseek-coder-v2',
        providerNativeId: 'deepseek/deepseek-coder-v2-instruct',
        lifecycle: 'blocked',
      }),
    },
    ladders: {},
  };
}

describe('openrouter-alias-audit', () => {
  it('lists every native-openrouter registry model sorted by id', () => {
    const models = listNativeOpenRouterRegistryModels();
    assert.ok(models.length > 0);
    assert.ok(models.includes('qwen-3-coder'));
    assert.ok(models.includes('kimi-k2'));
    // Sorted ascending.
    for (let i = 1; i < models.length; i++) {
      assert.ok(models[i - 1].localeCompare(models[i]) <= 0);
    }
    // Hosted deepseek models are NOT native-openrouter and must be excluded.
    assert.ok(!models.includes('deepseek-chat'));
    assert.ok(!models.includes('deepseek-v4-pro'));
  });

  it('offline audit flags deepseek-coder-v2 as an unresolvable alias (not selectable)', () => {
    const findings = auditRegistryAliasResolution(DEFAULT_MODEL_REGISTRY);
    const deepseek = findings.find((f) => f.modelId === 'deepseek-coder-v2');
    assert.ok(deepseek, 'deepseek-coder-v2 should be flagged offline');
    assert.equal(deepseek?.reason, 'unresolvable-alias');
    assert.equal(deepseek?.wireId, null);
    assert.equal(deepseek?.selectable, false);
    assert.equal(deepseek?.lifecycle, 'blocked');
    assert.match(deepseek?.detail ?? '', /isNativeOpenRouterProviderId excludes/);
  });

  it('offline audit produces no selectable findings against the default registry', () => {
    const findings = auditRegistryAliasResolution(DEFAULT_MODEL_REGISTRY);
    const selectable = findings.filter((f) => f.selectable);
    assert.equal(selectable.length, 0);
  });

  it('offline audit against a synthetic registry yields only unresolvable-alias and provider-id-mismatch', () => {
    const registry = makeSyntheticRegistry();
    const findings = auditRegistryAliasResolution(registry);
    const reasons = new Set(findings.map((f) => f.reason));
    assert.ok(reasons.has('unresolvable-alias'));
    // deepseek-coder-v2 is the only offline finding (all others resolve).
    const deepseek = findings.find((f) => f.modelId === 'deepseek-coder-v2');
    assert.equal(deepseek?.reason, 'unresolvable-alias');
    assert.equal(deepseek?.selectable, false);
    // No missing-from-catalog / no-tool-support / context-window findings offline.
    assert.ok(!reasons.has('missing-from-catalog'));
    assert.ok(!reasons.has('no-tool-support'));
    assert.ok(!reasons.has('context-window-overstated'));
  });

  it('catalog audit reports each finding reason against a canned catalog', () => {
    const registry = makeSyntheticRegistry();

    const catalog = catalogFrom([
      makeCatalogModel({ id: 'qwen/qwen3-coder', context_length: 262_144 }),
      makeCatalogModel({ id: 'qwen/qwen-2.5-coder-32b-instruct', context_length: 32_768, supported_parameters: [] }),
      makeCatalogModel({ id: 'moonshotai/kimi-k2', context_length: 131_072 }),
      // grok-code-fast and deepseek-coder-v2 wire ids intentionally absent
    ]);

    const report = auditRegistryAgainstCatalog(catalog, registry, { now: new Date('2026-08-18T00:00:00Z') });

    const reasons = report.findings.map((f) => f.reason).sort();
    assert.deepEqual(reasons, [
      'context-window-overstated',
      'missing-from-catalog',
      'no-tool-support',
      'unresolvable-alias',
    ]);

    const grok = report.findings.find((f) => f.modelId === 'grok-code-fast');
    assert.equal(grok?.reason, 'missing-from-catalog');
    assert.equal(grok?.wireId, 'x-ai/grok-code-fast-1');
    assert.equal(grok?.selectable, false);
    assert.equal(grok?.lifecycle, 'blocked');

    const qwen32b = report.findings.find((f) => f.modelId === 'qwen-2.5-coder-32b');
    assert.equal(qwen32b?.reason, 'no-tool-support');
    assert.equal(qwen32b?.selectable, false);

    const kimi = report.findings.find((f) => f.modelId === 'kimi-k2');
    assert.equal(kimi?.reason, 'context-window-overstated');
    assert.equal(kimi?.selectable, true);

    const deepseek = report.findings.find((f) => f.modelId === 'deepseek-coder-v2');
    assert.equal(deepseek?.reason, 'unresolvable-alias');
    assert.equal(deepseek?.wireId, null);

    // qwen-3-coder is healthy and must not appear.
    assert.equal(report.findings.find((f) => f.modelId === 'qwen-3-coder'), undefined);

    assert.equal(report.catalogSize, catalog.size);
    assert.equal(report.selectableFindingCount, 1);
    assert.equal(report.auditedAt, '2026-08-18T00:00:00.000Z');
    assert.deepEqual(report.auditedModels, [
      'deepseek-coder-v2',
      'grok-code-fast',
      'kimi-k2',
      'qwen-2.5-coder-32b',
      'qwen-3-coder',
    ]);
  });

  it('flags provider-id-mismatch when registry providerNativeId differs from fixture', () => {
    const registry: ModelRegistry = {
      models: {
        'kimi-k2': makeNativeModel({
          alias: 'kimi-k2',
          // Fixture says moonshotai/kimi-k2; deliberately mismatch.
          providerNativeId: 'moonshotai/kimi-k2-wrong',
          contextWindowTokens: 131_072,
        }),
      },
      ladders: {},
    };
    const catalog = catalogFrom([
      makeCatalogModel({ id: 'moonshotai/kimi-k2', context_length: 131_072 }),
    ]);
    const report = auditRegistryAgainstCatalog(catalog, registry);
    const mismatch = report.findings.find((f) => f.reason === 'provider-id-mismatch');
    assert.ok(mismatch, 'expected a provider-id-mismatch finding');
    assert.equal(mismatch?.modelId, 'kimi-k2');
    // The wire id resolves from the fixture, not the registry providerNativeId.
    assert.equal(mismatch?.wireId, 'moonshotai/kimi-k2');
  });

  it('sorts findings with selectable first, then by modelId', () => {
    const registry: ModelRegistry = {
      models: {
        'kimi-k2': makeNativeModel({ alias: 'kimi-k2', providerNativeId: 'moonshotai/kimi-k2', contextWindowTokens: 200_000 }),
        'glm-5.2': makeNativeModel({ alias: 'glm-5.2', providerNativeId: 'z-ai/glm-5.2', contextWindowTokens: 2_000_000 }),
      },
      ladders: {},
    };
    const catalog = catalogFrom([
      makeCatalogModel({ id: 'moonshotai/kimi-k2', context_length: 131_072 }),
      makeCatalogModel({ id: 'z-ai/glm-5.2', context_length: 1_048_576 }),
    ]);
    const report = auditRegistryAgainstCatalog(catalog, registry);
    // Both are selectable (lifecycle supported) and overstated.
    assert.equal(report.findings.length, 2);
    assert.equal(report.findings[0].selectable, true);
    assert.equal(report.findings[1].selectable, true);
    assert.deepEqual(report.findings.map((f) => f.modelId), ['glm-5.2', 'kimi-k2']);
  });

  it('renderAliasAuditReport includes a clean footer for an empty report', () => {
    const empty: AliasAuditReport = {
      auditedAt: '2026-08-18T00:00:00Z',
      catalogSize: 412,
      auditedModels: ['kimi-k2'],
      findings: [],
      selectableFindingCount: 0,
    };
    const rendered = renderAliasAuditReport(empty);
    assert.match(rendered, /no findings/);
    assert.match(rendered, /selectable findings: 0/);
  });

  it('renderAliasAuditReport includes modelId and reason for each finding', () => {
    const registry: ModelRegistry = {
      models: {
        'kimi-k2': makeNativeModel({ alias: 'kimi-k2', providerNativeId: 'moonshotai/kimi-k2', contextWindowTokens: 200_000 }),
      },
      ladders: {},
    };
    const catalog = catalogFrom([
      makeCatalogModel({ id: 'moonshotai/kimi-k2', context_length: 131_072 }),
    ]);
    const report = auditRegistryAgainstCatalog(catalog, registry);
    const rendered = renderAliasAuditReport(report);
    assert.match(rendered, /kimi-k2/);
    assert.match(rendered, /context-window-overstated/);
    assert.match(rendered, /\[SELECTABLE\]/);
  });

  it('does not flag no-tool-support when registry toolSupport is none', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-2.5-coder-32b': makeNativeModel({
          alias: 'qwen-2.5-coder-32b',
          providerNativeId: 'qwen/qwen-2.5-coder-32b-instruct',
          toolSupport: 'none',
          contextWindowTokens: 32_768,
        }),
      },
      ladders: {},
    };
    const catalog = catalogFrom([
      makeCatalogModel({ id: 'qwen/qwen-2.5-coder-32b-instruct', context_length: 32_768, supported_parameters: [] }),
    ]);
    const report = auditRegistryAgainstCatalog(catalog, registry);
    // No finding: toolSupport 'none' skips no-tool-support; context matches; present.
    assert.equal(report.findings.length, 0);
  });

  it('AliasAuditFinding type is exported', () => {
    const finding: AliasAuditFinding = {
      modelId: 'x',
      wireId: null,
      reason: 'unresolvable-alias',
      detail: 'd',
      selectable: false,
      lifecycle: 'blocked',
    };
    assert.equal(finding.reason, 'unresolvable-alias');
  });
});
