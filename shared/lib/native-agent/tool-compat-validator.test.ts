import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../model-registry.ts';
import {
  assertToolCompat,
  ToolCompatError,
  validateToolCompat,
} from './tool-compat-validator.ts';
import type { ToolMetadata } from './tools/types.ts';

function makeRegistry(readOnlyNative: 'certified' | 'partial' | 'unsupported', compatFlags?: Record<string, unknown>): ModelRegistry {
  return {
    models: {
      'openai/gpt-4o-mini': {
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
          compatFlags,
          limitations: readOnlyNative === 'partial'
            ? ['missing thinkingFormat=openrouter compat flag']
            : undefined,
        },
      },
    },
    ladders: {},
  };
}

function makeTool(name: string): Pick<ToolMetadata, 'name' | 'description' | 'executionMode'> {
  return {
    name,
    description: `${name} description`,
    executionMode: 'parallel',
  };
}

describe('tool-compat-validator', () => {
  it('returns ok when all tools are supported', () => {
    const result = validateToolCompat({
      model: 'openai/gpt-4o-mini',
      provider: 'openrouter',
      transport: 'openai-completions',
      registry: makeRegistry('certified', { thinkingFormat: 'openrouter' }),
      tools: [makeTool('read_file'), makeTool('list_files')],
    });

    assert.deepEqual(result, { ok: true });
  });

  it('throws for unknown transports', () => {
    assert.throws(
      () => validateToolCompat({
        model: 'openai/gpt-4o-mini',
        provider: 'openrouter',
        transport: 'unknown-transport',
        registry: makeRegistry('certified', { thinkingFormat: 'openrouter' }),
        tools: [makeTool('read_file')],
      }),
      /Unknown provider transport "unknown-transport"/,
    );
  });

  it('emits one diagnostic per tool when the model is missing from the registry', () => {
    const result = validateToolCompat({
      model: 'missing-model',
      provider: 'openrouter',
      transport: 'openai-completions',
      registry: { models: {}, ladders: {} },
      tools: [makeTool('read_file'), makeTool('list_files')],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.diagnostics.length, 2);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.tool),
      ['read_file', 'list_files'],
    );
    assert.match(result.diagnostics[0]!.message, /not registered in the capability registry/);
  });

  it('emits one diagnostic per tool when the transport combination is unsupported', () => {
    const result = validateToolCompat({
      model: 'openai/gpt-4o-mini',
      provider: 'openai',
      transport: 'openai-completions',
      registry: makeRegistry('unsupported'),
      tools: [makeTool('read_file'), makeTool('git_diff')],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.diagnostics.length, 2);
    assert.match(result.diagnostics[0]!.message, /unsupported native provider\/transport combination: openai\/openai-completions/);
  });

  it('emits partial capability diagnostics unless allowPartial is true', () => {
    const strictResult = validateToolCompat({
      model: 'openai/gpt-4o-mini',
      provider: 'openrouter',
      transport: 'openai-completions',
      registry: makeRegistry('partial'),
      tools: [makeTool('read_file'), makeTool('search_text')],
    });

    assert.equal(strictResult.ok, false);
    if (strictResult.ok) return;
    assert.equal(strictResult.diagnostics.length, 2);
    assert.match(strictResult.diagnostics[0]!.message, /missing thinkingFormat=openrouter compat flag/);

    const relaxedResult = validateToolCompat({
      model: 'openai/gpt-4o-mini',
      provider: 'openrouter',
      transport: 'openai-completions',
      registry: makeRegistry('partial'),
      allowPartial: true,
      tools: [makeTool('read_file'), makeTool('search_text')],
    });

    assert.deepEqual(relaxedResult, { ok: true });
  });

  it('returns stable diagnostics and complete fields', () => {
    const result = validateToolCompat({
      model: 'missing-model',
      provider: 'openrouter',
      transport: 'openai-completions',
      registry: { models: {}, ladders: {} },
      tools: [makeTool('a_tool'), makeTool('b_tool')],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.tool),
      ['a_tool', 'b_tool'],
    );

    for (const diagnostic of result.diagnostics) {
      assert.ok(diagnostic.model.length > 0);
      assert.ok(diagnostic.provider.length > 0);
      assert.ok(diagnostic.transport.length > 0);
      assert.ok(diagnostic.tool.length > 0);
      assert.ok(diagnostic.unsupportedCapability.length > 0);
      assert.ok(diagnostic.message.length > 0);
    }
  });

  it('flags duplicate tool names loudly', () => {
    const result = validateToolCompat({
      model: 'openai/gpt-4o-mini',
      provider: 'openrouter',
      transport: 'openai-completions',
      registry: makeRegistry('certified', { thinkingFormat: 'openrouter' }),
      tools: [makeTool('read_file'), makeTool('read_file')],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]!.unsupportedCapability, 'duplicate_tool_name');
  });

  it('assertToolCompat throws ToolCompatError with diagnostics', () => {
    assert.throws(
      () => assertToolCompat({
        model: 'missing-model',
        provider: 'openrouter',
        transport: 'openai-completions',
        registry: { models: {}, ladders: {} },
        tools: [makeTool('read_file')],
      }),
      (error: unknown) => {
        assert.ok(error instanceof ToolCompatError);
        assert.equal(error.diagnostics.length, 1);
        assert.match(error.message, /model=missing-model/);
        return true;
      },
    );
  });

  it('returns ok for empty tool lists', () => {
    const result = validateToolCompat({
      model: 'openai/gpt-4o-mini',
      provider: 'openrouter',
      transport: 'openai-completions',
      registry: makeRegistry('certified', { thinkingFormat: 'openrouter' }),
      tools: [],
    });

    assert.deepEqual(result, { ok: true });
  });
});
