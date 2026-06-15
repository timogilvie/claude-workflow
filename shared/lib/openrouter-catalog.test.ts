import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  loadLaunchPriorityList,
  normalizeCatalog,
  type LaunchPriorityModel,
  type OpenRouterApiModel,
} from './openrouter-catalog.ts';

function makePriorityModel(overrides: Partial<LaunchPriorityModel> = {}): LaunchPriorityModel {
  return {
    openrouterId: overrides.openrouterId ?? 'anthropic/claude-opus-4-8',
    wavemillAlias: overrides.wavemillAlias ?? 'claude-opus-4-8',
    family: overrides.family ?? 'claude',
    priorityTier: overrides.priorityTier ?? 1,
    status: overrides.status ?? 'active',
    roleEligibility: overrides.roleEligibility ?? ['planner', 'coder', 'reviewer'],
  };
}

function makeOpenRouterModel(overrides: Partial<OpenRouterApiModel> & Pick<OpenRouterApiModel, 'id'>): OpenRouterApiModel {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    context_length: overrides.context_length ?? 128_000,
    pricing: overrides.pricing ?? {
      prompt: '0.000001',
      completion: '0.000002',
    },
    top_provider: overrides.top_provider ?? {
      context_length: null,
      max_completion_tokens: 8_192,
      is_moderated: false,
    },
    architecture: overrides.architecture ?? {
      modality: 'text->text',
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'test',
      instruct_type: null,
    },
    description: overrides.description ?? null,
    created: overrides.created ?? 1,
    expiration_date: overrides.expiration_date ?? null,
  };
}

describe('openrouter-catalog', () => {
  it('normalizes Qwen pricing and alias metadata', () => {
    const priorityList = [
      makePriorityModel({
        openrouterId: 'qwen/qwq-32b',
        wavemillAlias: 'qwq-32b',
        family: 'qwen',
        priorityTier: 2,
      }),
    ];

    const result = normalizeCatalog(priorityList, [
      makeOpenRouterModel({
        id: 'qwen/qwq-32b',
        name: 'Qwen QwQ 32B',
        context_length: 32_768,
        pricing: {
          prompt: '0.00000055',
          completion: '0.0000022',
        },
      }),
    ], {
      snapshotAt: '2026-06-15T00:00:00.000Z',
    });

    assert.equal(result.entries.length, 1);
    assert.equal(result.blockers.length, 0);
    assert.deepEqual(result.entries[0]?.pricing, {
      inputPerMTok: 0.55,
      outputPerMTok: 2.2,
    });
    assert.equal(result.entries[0]?.wavemillAlias, 'qwq-32b');
    assert.equal(result.entries[0]?.family, 'qwen');
    assert.equal(result.entries[0]?.providerId, 'qwen');
  });

  it('normalizes DeepSeek context and pricing', () => {
    const priorityList = [
      makePriorityModel({
        openrouterId: 'deepseek/deepseek-r1',
        wavemillAlias: 'deepseek-r1',
        family: 'deepseek',
        priorityTier: 2,
      }),
    ];

    const result = normalizeCatalog(priorityList, [
      makeOpenRouterModel({
        id: 'deepseek/deepseek-r1',
        context_length: 163_840,
        pricing: {
          prompt: '0.0000007',
          completion: '0.0000025',
        },
      }),
    ]);

    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.wavemillAlias, 'deepseek-r1');
    assert.equal(result.entries[0]?.contextLength, 163_840);
    assert.deepEqual(result.entries[0]?.pricing, {
      inputPerMTok: 0.7,
      outputPerMTok: 2.5,
    });
  });

  it('normalizes Kimi family aliases', () => {
    const priorityList = [
      makePriorityModel({
        openrouterId: 'moonshot/moonshot-v1-128k',
        wavemillAlias: 'kimi-v1-128k',
        family: 'kimi',
        priorityTier: 3,
        status: 'watchlist',
        roleEligibility: ['coder', 'reviewer'],
      }),
    ];

    const result = normalizeCatalog(priorityList, [
      makeOpenRouterModel({
        id: 'moonshot/moonshot-v1-128k',
        name: 'Moonshot v1 128K',
        context_length: 128_000,
      }),
    ]);

    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.wavemillAlias, 'kimi-v1-128k');
    assert.equal(result.entries[0]?.family, 'kimi');
    assert.equal(result.entries[0]?.providerId, 'moonshot');
  });

  it('preserves Claude and GPT alias mappings for Hokusai exports', () => {
    const priorityList = [
      makePriorityModel({
        openrouterId: 'anthropic/claude-opus-4-8',
        wavemillAlias: 'claude-opus-4-8',
      }),
      makePriorityModel({
        openrouterId: 'openai/gpt-5.4',
        wavemillAlias: 'gpt-5.4',
        family: 'gpt',
      }),
    ];

    const result = normalizeCatalog(priorityList, [
      makeOpenRouterModel({
        id: 'anthropic/claude-opus-4-8',
        name: 'Claude Opus 4.8',
      }),
      makeOpenRouterModel({
        id: 'openai/gpt-5.4',
        name: 'GPT-5.4',
      }),
    ]);

    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0]?.wavemillAlias, 'claude-opus-4-8');
    assert.equal(result.entries[1]?.wavemillAlias, 'gpt-5.4');
    assert.equal(result.entries[0]?.registryValidated, true);
    assert.equal(result.entries[1]?.registryValidated, true);
  });

  it('emits a not_found blocker for missing models', () => {
    const priorityList = [
      makePriorityModel({
        openrouterId: 'openai/o1-mini',
        wavemillAlias: 'o1-mini',
        family: 'o1',
        priorityTier: 3,
        status: 'watchlist',
      }),
    ];

    const result = normalizeCatalog(priorityList, []);

    assert.equal(result.entries.length, 0);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0]?.reason, 'not_found');
    assert.match(result.blockers[0]?.detail ?? '', /not present/);
  });

  it('includes snapshot metadata in the catalog result', () => {
    const snapshotAt = '2026-06-15T12:34:56.000Z';
    const result = normalizeCatalog([], [], { snapshotAt });

    assert.equal(result.snapshotAt, snapshotAt);
    assert.equal(result.sourceUrl, 'https://openrouter.ai/api/v1/models');
    assert.match(result.snapshotAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('resolves every fixture model to an entry or explicit blocker', () => {
    const fixture = loadLaunchPriorityList();
    assert.equal(fixture.length, 30);

    const notFound = new Set(['openai/o1-mini', 'baichuan-inc/baichuan3-turbo']);
    const deprecated = new Set(['mistralai/codestral-2501']);
    const unavailable = new Set(['cohere/command-r-plus']);

    const openRouterModels = fixture
      .filter((model) => !notFound.has(model.openrouterId))
      .map((model) => {
        if (deprecated.has(model.openrouterId)) {
          return makeOpenRouterModel({
            id: model.openrouterId,
            name: model.wavemillAlias,
            expiration_date: '2026-01-01T00:00:00.000Z',
          });
        }

        if (unavailable.has(model.openrouterId)) {
          return makeOpenRouterModel({
            id: model.openrouterId,
            name: model.wavemillAlias,
            pricing: {
              prompt: '-1',
              completion: '-1',
            },
          });
        }

        return makeOpenRouterModel({
          id: model.openrouterId,
          name: model.wavemillAlias,
          context_length: 200_000,
        });
      });

    const result = normalizeCatalog(fixture, openRouterModels, {
      snapshotAt: '2026-06-15T00:00:00.000Z',
    });

    assert.equal(result.entries.length + result.blockers.length, fixture.length);
    assert.ok(result.blockers.some((blocker) => blocker.reason === 'not_found'));
    assert.ok(result.blockers.some((blocker) => blocker.reason === 'deprecated'));
    assert.ok(result.blockers.some((blocker) => blocker.reason === 'unavailable'));
    assert.equal(
      new Set([...result.entries.map((entry) => entry.openrouterId), ...result.blockers.map((blocker) => blocker.openrouterId)])
        .size,
      fixture.length,
    );
  });
});
