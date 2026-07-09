import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCatalogSnapshot,
  CATALOG_SCHEMA_VERSION,
  fetchOpenRouterModels,
  hashLaunchPriorityFixture,
  hasTier1ActiveBlockers,
  loadLaunchPriorityFixture,
  loadLaunchPriorityList,
  normalizeCatalog,
  OPENROUTER_MODELS_URL,
  resolveWavemillAliasFromOpenRouterId,
  resolveOpenRouterIdFromWavemillAlias,
  serializeSnapshot,
  type LaunchPriorityFixture,
  type LaunchPriorityModel,
  type OpenRouterModel,
} from './openrouter-catalog.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'openrouter-catalog-test-'));
}

function writeFixture(dir: string, fixture: LaunchPriorityFixture): string {
  const path = join(dir, 'fixture.json');
  writeFileSync(path, JSON.stringify(fixture, null, 2), 'utf-8');
  return path;
}

function buildOpenRouterMap(models: OpenRouterModel[]): Map<string, OpenRouterModel> {
  return new Map(models.map((m) => [m.id, m]));
}

const FIXED_RESOLVED_AT = '2026-06-15T12:00:00.000Z';

describe('loadLaunchPriorityFixture', () => {
  it('reads and parses a fixture file', () => {
    const dir = makeTempDir();
    try {
      const fixture: LaunchPriorityFixture = {
        schemaVersion: '1',
        models: [
          {
            wavemillAlias: 'test-model',
            openrouterId: 'vendor/test-model',
            family: 'qwen',
            status: 'active',
            priorityTier: 1,
            roleEligibility: ['coding'],
          },
        ],
      };
      const path = writeFixture(dir, fixture);
      const loaded = loadLaunchPriorityFixture(path);
      assert.equal(loaded.schemaVersion, '1');
      assert.equal(loaded.models.length, 1);
      assert.equal(loaded.models[0]?.wavemillAlias, 'test-model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on missing models array', () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'bad.json');
      writeFileSync(path, JSON.stringify({ schemaVersion: '1' }), 'utf-8');
      assert.throws(() => loadLaunchPriorityFixture(path), /missing "models" array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default fixture loads and contains launch-priority models', () => {
    const list = loadLaunchPriorityList();
    assert.ok(list.length >= 25, `expected at least 25 launch-priority models, got ${list.length}`);
    const aliases = new Set(list.map((m) => m.wavemillAlias));
    for (const required of ['claude-fable-5', 'gpt-5.5', 'deepseek-r1', 'qwen-2.5-coder-32b', 'kimi-k2', 'glm-5.2', 'kimi-k2.7-code']) {
      assert.ok(aliases.has(required), `expected fixture to include ${required}`);
    }
  });

  it('hashes the fixture deterministically', () => {
    const a = hashLaunchPriorityFixture();
    const b = hashLaunchPriorityFixture();
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});

describe('fetchOpenRouterModels', () => {
  it('returns a Map keyed by model id with injected fetchFn', async () => {
    const fakeFetch = (async (url: string) => {
      assert.equal(url, OPENROUTER_MODELS_URL);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: [
            { id: 'a/b', name: 'A/B', context_length: 1024 },
            { id: 'c/d', name: 'C/D', context_length: 2048 },
          ],
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const map = await fetchOpenRouterModels(fakeFetch);
    assert.equal(map.size, 2);
    assert.equal(map.get('a/b')?.context_length, 1024);
    assert.equal(map.get('c/d')?.context_length, 2048);
  });

  it('throws on non-OK HTTP response', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await assert.rejects(() => fetchOpenRouterModels(fakeFetch), /HTTP 503/);
  });

  it('throws when response body has no data array', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ wrong: 'shape' }),
    })) as unknown as typeof fetch;
    await assert.rejects(() => fetchOpenRouterModels(fakeFetch), /missing "data" array/);
  });
});

describe('OpenRouter alias mapping', () => {
  it('resolves known aliases and ids in both directions', () => {
    assert.equal(resolveWavemillAliasFromOpenRouterId('qwen/qwen3-coder'), 'qwen-3-coder');
    assert.equal(resolveOpenRouterIdFromWavemillAlias('qwen-3-coder'), 'qwen/qwen3-coder');
    assert.equal(resolveOpenRouterIdFromWavemillAlias('glm-5.2'), 'z-ai/glm-5.2');
    assert.equal(resolveOpenRouterIdFromWavemillAlias('kimi-k2.7-code'), 'moonshotai/kimi-k2.7-code');
  });
});

describe('resolveWavemillAliasFromOpenRouterId', () => {
  it('maps OpenRouter ids back to Wavemill aliases', () => {
    assert.equal(resolveWavemillAliasFromOpenRouterId('openai/gpt-5.5'), 'gpt-5.5');
    assert.equal(resolveWavemillAliasFromOpenRouterId('qwen/qwen3-coder'), 'qwen-3-coder');
  });

  it('returns null for unknown ids', () => {
    assert.equal(resolveWavemillAliasFromOpenRouterId('vendor/missing'), null);
  });
});

describe('normalizeCatalog', () => {
  function lp(partial: Partial<LaunchPriorityModel>): LaunchPriorityModel {
    return {
      wavemillAlias: partial.wavemillAlias ?? 'alias',
      openrouterId: partial.openrouterId ?? 'vendor/model',
      family: partial.family ?? 'qwen',
      status: partial.status ?? 'active',
      priorityTier: partial.priorityTier ?? 2,
      roleEligibility: partial.roleEligibility ?? ['coding'],
    };
  }

  it('Qwen: resolves qwen-2.5-coder-32b-instruct with pricing and context', () => {
    const list = [
      lp({
        wavemillAlias: 'qwen-2.5-coder-32b',
        openrouterId: 'qwen/qwen-2.5-coder-32b-instruct',
        family: 'qwen',
        priorityTier: 1,
        roleEligibility: ['coding'],
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'qwen/qwen-2.5-coder-32b-instruct',
        name: 'Qwen 2.5 Coder 32B Instruct',
        context_length: 32768,
        pricing: { prompt: '0.0000002', completion: '0.0000006' },
      },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(blockers.length, 0);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.wavemillAlias, 'qwen-2.5-coder-32b');
    assert.equal(entry.family, 'qwen');
    assert.equal(entry.contextTokens, 32768);
    assert.ok(
      Math.abs((entry.pricing.inputPerMTok ?? 0) - 0.2) < 1e-9,
      `expected ~0.2, got ${entry.pricing.inputPerMTok}`,
    );
    assert.ok(
      Math.abs((entry.pricing.outputPerMTok ?? 0) - 0.6) < 1e-9,
      `expected ~0.6, got ${entry.pricing.outputPerMTok}`,
    );
    assert.deepEqual(entry.roleEligibility, ['coding']);
    assert.equal(entry.resolvedAt, FIXED_RESOLVED_AT);
  });

  it('DeepSeek: per-token pricing normalized to per-MTok', () => {
    const list = [
      lp({
        wavemillAlias: 'deepseek-r1',
        openrouterId: 'deepseek/deepseek-r1',
        family: 'deepseek',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'deepseek/deepseek-r1',
        context_length: 65536,
        pricing: { prompt: '0.00000055', completion: '0.0000022' },
      },
    ]);
    const { entries } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    const entry = entries[0]!;
    assert.equal(entry.family, 'deepseek');
    assert.ok(Math.abs((entry.pricing.inputPerMTok ?? 0) - 0.55) < 1e-9);
    assert.ok(Math.abs((entry.pricing.outputPerMTok ?? 0) - 2.2) < 1e-9);
  });

  it('Kimi: resolves moonshotai/kimi-k2 as family kimi', () => {
    const list = [
      lp({
        wavemillAlias: 'kimi-k2',
        openrouterId: 'moonshotai/kimi-k2',
        family: 'kimi',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'moonshotai/kimi-k2',
        context_length: 200000,
        pricing: { prompt: '0.000001', completion: '0.000003' },
      },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(blockers.length, 0);
    assert.equal(entries[0]?.family, 'kimi');
    assert.equal(entries[0]?.openrouterId, 'moonshotai/kimi-k2');
    assert.equal(entries[0]?.contextTokens, 200000);
  });

  it('Claude and GPT aliases both resolve via their OpenRouter ids', () => {
    const list: LaunchPriorityModel[] = [
      lp({
        wavemillAlias: 'claude-fable-5',
        openrouterId: 'anthropic/claude-fable-5',
        family: 'claude',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      }),
      lp({
        wavemillAlias: 'gpt-5.5',
        openrouterId: 'openai/gpt-5.5',
        family: 'gpt',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      }),
    ];
    const map = buildOpenRouterMap([
      {
        id: 'anthropic/claude-fable-5',
        context_length: 200000,
        pricing: { prompt: '0.000015', completion: '0.000075' },
      },
      {
        id: 'openai/gpt-5.5',
        context_length: 400000,
        pricing: { prompt: '0.000005', completion: '0.000020' },
      },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(blockers.length, 0);
    assert.equal(entries.length, 2);
    const byAlias = new Map(entries.map((e) => [e.wavemillAlias, e]));
    assert.equal(byAlias.get('claude-fable-5')?.family, 'claude');
    assert.equal(byAlias.get('claude-fable-5')?.contextTokens, 200000);
    assert.equal(byAlias.get('gpt-5.5')?.family, 'gpt');
    assert.equal(byAlias.get('gpt-5.5')?.contextTokens, 400000);
    assert.equal(byAlias.get('gpt-5.5')?.pricing.inputPerMTok, 5);
    assert.equal(byAlias.get('gpt-5.5')?.pricing.outputPerMTok, 20);
  });

  it('Missing model: produces a not_found_in_openrouter blocker', () => {
    const list = [
      lp({
        wavemillAlias: 'phantom-model',
        openrouterId: 'phantom/unavailable',
        family: 'mistral',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding'],
      }),
    ];
    const map = buildOpenRouterMap([
      { id: 'some/other-model', context_length: 1024, pricing: { prompt: '0', completion: '0' } },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(entries.length, 0);
    assert.equal(blockers.length, 1);
    const blocker = blockers[0]!;
    assert.equal(blocker.wavemillAlias, 'phantom-model');
    assert.equal(blocker.reason, 'not_found_in_openrouter');
    assert.equal(blocker.priorityTier, 1);
    assert.equal(blocker.status, 'active');
    assert.match(blocker.detail, /phantom\/unavailable/);
  });

  it('Deprecated models are reported as blockers, not entries', () => {
    const list = [
      lp({
        wavemillAlias: 'o3-mini',
        openrouterId: 'openai/o3-mini',
        family: 'gpt',
        status: 'deprecated',
        priorityTier: 3,
        roleEligibility: ['coding'],
      }),
    ];
    const map = buildOpenRouterMap([
      { id: 'openai/o3-mini', context_length: 1024, pricing: { prompt: '0.000001', completion: '0.000004' } },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(entries.length, 0);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0]?.reason, 'deprecated');
  });

  it('handles missing pricing by emitting nulls without blocking', () => {
    const list = [
      lp({
        wavemillAlias: 'free-model',
        openrouterId: 'vendor/free',
        family: 'llama',
        status: 'watchlist',
        priorityTier: 3,
        roleEligibility: ['coding'],
      }),
    ];
    const map = buildOpenRouterMap([{ id: 'vendor/free', context_length: 8192 }]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(blockers.length, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.pricing.inputPerMTok, null);
    assert.equal(entries[0]?.pricing.outputPerMTok, null);
  });

  it('falls back to top_provider.context_length when context_length is absent', () => {
    const list = [
      lp({
        wavemillAlias: 'tp-model',
        openrouterId: 'vendor/tp',
        family: 'gemini',
        status: 'active',
        priorityTier: 2,
        roleEligibility: ['coding'],
      }),
    ];
    const map = buildOpenRouterMap([
      { id: 'vendor/tp', top_provider: { context_length: 12345 } },
    ]);
    const { entries } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    assert.equal(entries[0]?.contextTokens, 12345);
  });
});

describe('buildCatalogSnapshot', () => {
  it('produces a deterministic snapshot sorted by tier and alias', () => {
    const list: LaunchPriorityModel[] = [
      {
        wavemillAlias: 'beta-model',
        openrouterId: 'vendor/beta',
        family: 'qwen',
        status: 'active',
        priorityTier: 2,
        roleEligibility: ['coding'],
      },
      {
        wavemillAlias: 'alpha-model',
        openrouterId: 'vendor/alpha',
        family: 'qwen',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding'],
      },
    ];
    const map = buildOpenRouterMap([
      { id: 'vendor/alpha', context_length: 1024, pricing: { prompt: '0', completion: '0' } },
      { id: 'vendor/beta', context_length: 2048, pricing: { prompt: '0', completion: '0' } },
    ]);
    const { entries, blockers } = normalizeCatalog(list, map, { resolvedAt: FIXED_RESOLVED_AT });
    const snapshot = buildCatalogSnapshot(entries, blockers, 'abc123', {
      generatedAt: FIXED_RESOLVED_AT,
    });
    assert.equal(snapshot.schemaVersion, CATALOG_SCHEMA_VERSION);
    assert.equal(snapshot.sourceHash, 'abc123');
    assert.equal(snapshot.generatedAt, FIXED_RESOLVED_AT);
    assert.deepEqual(
      snapshot.entries.map((e) => e.wavemillAlias),
      ['alpha-model', 'beta-model'],
    );
  });

  it('serializeSnapshot produces stable output regardless of input key order', () => {
    const snapshotA = buildCatalogSnapshot(
      [
        {
          wavemillAlias: 'm',
          openrouterId: 'v/m',
          family: 'qwen',
          contextTokens: 1024,
          pricing: { inputPerMTok: 1, outputPerMTok: 2 },
          roleEligibility: ['coding'],
          status: 'active',
          priorityTier: 1,
          resolvedAt: FIXED_RESOLVED_AT,
        },
      ],
      [],
      'hash',
      { generatedAt: FIXED_RESOLVED_AT },
    );
    const first = serializeSnapshot(snapshotA);
    const second = serializeSnapshot(snapshotA);
    assert.equal(first, second);
    assert.match(first, /"schemaVersion": "1"/);
  });
});

describe('hasTier1ActiveBlockers', () => {
  it('returns true only when an active tier-1 model is blocked', () => {
    assert.equal(
      hasTier1ActiveBlockers([
        {
          wavemillAlias: 'x',
          openrouterId: 'v/x',
          family: 'qwen',
          status: 'active',
          priorityTier: 1,
          reason: 'not_found_in_openrouter',
          detail: '',
        },
      ]),
      true,
    );
    assert.equal(
      hasTier1ActiveBlockers([
        {
          wavemillAlias: 'x',
          openrouterId: 'v/x',
          family: 'qwen',
          status: 'watchlist',
          priorityTier: 1,
          reason: 'not_found_in_openrouter',
          detail: '',
        },
      ]),
      false,
    );
    assert.equal(
      hasTier1ActiveBlockers([
        {
          wavemillAlias: 'x',
          openrouterId: 'v/x',
          family: 'gpt',
          status: 'deprecated',
          priorityTier: 1,
          reason: 'deprecated',
          detail: '',
        },
      ]),
      false,
    );
  });
});
