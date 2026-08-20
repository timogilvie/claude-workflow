import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { auditOpenRouterAliases } from './openrouter-alias-audit.ts';
import type { ModelRegistry } from './model-registry.ts';
import type { OpenRouterModel } from './openrouter-catalog.ts';

function makeModel(overrides: Partial<ModelRegistry['models'][string]> = {}): ModelRegistry['models'][string] {
  return {
    vendor: 'test',
    class: 'fast_economy',
    strengths: ['test'],
    weaknesses: ['test'],
    qualityScores: { routing: 0, planning: 0, coding: 80, review: 0, classify: 0 },
    defaultLadderEligible: false,
    contextWindowTokens: 400_000,
    toolSupport: 'basic',
    multimodal: { text: true, image: false },
    latencyTier: 'standard',
    reasoningTier: 'standard',
    costPerMillionInputTokensUsd: 1,
    costPerMillionOutputTokensUsd: 2,
    agent: 'native-openrouter',
    supportedModel: {
      lifecycle: 'supported',
      stages: ['coding'],
      ...overrides.supportedModel,
    },
    ...overrides,
  };
}

describe('openrouter alias audit', () => {
  it('reports retired unresolved and missing-catalog aliases as non-selectable', () => {
    const registry: ModelRegistry = {
      models: {
        'deepseek-coder-v2': makeModel({
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'deepseek/deepseek-coder-v2-instruct' },
        }),
        'gemini-2.0-flash': makeModel({
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'google/gemini-2.0-flash-001' },
        }),
        'grok-code-fast': makeModel({
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'x-ai/grok-code-fast-1' },
        }),
        'qwen-2.5-coder-32b': makeModel({
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'qwen/qwen-2.5-coder-32b-instruct' },
        }),
      },
      ladders: {},
    };
    const catalog = new Map<string, OpenRouterModel>([
      ['qwen/qwen-2.5-coder-32b-instruct', { id: 'qwen/qwen-2.5-coder-32b-instruct' }],
    ]);

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: catalog,
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.equal(report.checked, 4);
    assert.equal(report.schemaVersion, '2');
    assert.equal(report.selectableFindings, 0);
    assert.deepEqual(report.findings.map((finding) => [finding.alias, finding.reason, finding.selectable]), [
      ['deepseek-coder-v2', 'unresolved-openrouter-id', false],
      ['gemini-2.0-flash', 'not-found-in-openrouter', false],
      ['grok-code-fast', 'not-found-in-openrouter', false],
    ]);
  });

  it('counts selectable aliases with drift as blocking findings', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
      },
      ladders: {},
    };

    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map(),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.equal(report.checked, 1);
    assert.equal(report.selectableFindings, 1);
    assert.equal(report.findings[0]?.alias, 'qwen-3-coder');
    assert.equal(report.findings[0]?.reason, 'not-found-in-openrouter');
    assert.equal(report.findings[0]?.selectable, true);
  });

  it('reports overstated registry context windows but accepts equal or conservative declarations', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          contextWindowTokens: 200_000,
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
        'qwen-3-235b': makeModel({
          contextWindowTokens: 131_072,
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-235b-a22b-2507' },
        }),
        'kimi-k2': makeModel({
          contextWindowTokens: 65_536,
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'moonshotai/kimi-k2' },
        }),
      },
      ladders: {},
    };
    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', { id: 'qwen/qwen3-coder', context_length: 131_072 }],
        ['qwen/qwen3-235b-a22b-2507', { id: 'qwen/qwen3-235b-a22b-2507', context_length: 131_072 }],
        ['moonshotai/kimi-k2', { id: 'moonshotai/kimi-k2', context_length: 131_072 }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.deepEqual(report.findings.map((finding) => [finding.alias, finding.reason]), [
      ['qwen-3-coder', 'context-window-overstated'],
    ]);
    assert.match(report.findings[0]?.detail ?? '', /200000/);
    assert.match(report.findings[0]?.detail ?? '', /131072/);
  });

  it('uses top_provider context length and skips context checks when provider context is absent', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          contextWindowTokens: 200_000,
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
        'qwen-3-235b': makeModel({
          contextWindowTokens: 200_000,
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-235b-a22b-2507' },
        }),
      },
      ladders: {},
    };
    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', { id: 'qwen/qwen3-coder', top_provider: { context_length: 131_072 } }],
        ['qwen/qwen3-235b-a22b-2507', { id: 'qwen/qwen3-235b-a22b-2507' }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.deepEqual(report.findings.map((finding) => [finding.alias, finding.reason]), [
      ['qwen-3-coder', 'context-window-overstated'],
    ]);
  });

  it('reports catalog tool-support mismatches and skips absent supported_parameters', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          toolSupport: 'basic',
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
        'qwen-3-235b': makeModel({
          toolSupport: 'full',
          supportedModel: { lifecycle: 'supported', stages: ['coding'], providerNativeId: 'qwen/qwen3-235b-a22b-2507' },
        }),
        'kimi-k2': makeModel({
          toolSupport: 'none',
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'moonshotai/kimi-k2' },
        }),
      },
      ladders: {},
    };
    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', { id: 'qwen/qwen3-coder', supported_parameters: ['temperature'] }],
        ['qwen/qwen3-235b-a22b-2507', { id: 'qwen/qwen3-235b-a22b-2507' }],
        ['moonshotai/kimi-k2', { id: 'moonshotai/kimi-k2', supported_parameters: ['temperature'] }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.deepEqual(report.findings.map((finding) => [finding.alias, finding.reason, finding.selectable]), [
      ['qwen-3-coder', 'tool-support-mismatch', true],
    ]);
  });

  it('reports blocked provider drift as non-selectable', () => {
    const registry: ModelRegistry = {
      models: {
        'qwen-3-coder': makeModel({
          contextWindowTokens: 200_000,
          supportedModel: { lifecycle: 'blocked', stages: ['coding'], providerNativeId: 'qwen/qwen3-coder' },
        }),
      },
      ladders: {},
    };
    const report = auditOpenRouterAliases({
      registry,
      openRouterModels: new Map<string, OpenRouterModel>([
        ['qwen/qwen3-coder', {
          id: 'qwen/qwen3-coder',
          context_length: 131_072,
          supported_parameters: ['temperature'],
        }],
      ]),
      now: new Date('2026-08-18T00:00:00.000Z'),
      catalogSource: 'file',
    });

    assert.equal(report.selectableFindings, 0);
    assert.deepEqual(report.findings.map((finding) => [finding.reason, finding.selectable]), [
      ['context-window-overstated', false],
      ['tool-support-mismatch', false],
    ]);
  });
});
