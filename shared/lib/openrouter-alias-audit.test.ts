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
});
