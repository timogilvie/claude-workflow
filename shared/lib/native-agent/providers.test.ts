import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../model-registry.ts';
import {
  buildOpenAiResponsesModel,
  buildOpenRouterModel,
  getNativeProviderApiKey,
  getRegisteredPiProviderForModel,
  OPENAI_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_BASE_URL,
  resolveNativeAgentProviders,
} from './providers.ts';

function makeCertifiedRegistry(modelId: string, provider: 'openai' | 'openrouter'): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: 'test',
        class: 'strong_generalist',
        strengths: ['testing'],
        weaknesses: [],
        qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
        contextWindowTokens: 128_000,
        toolSupport: 'full',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 2,
        nativeCapability: provider === 'openai'
          ? { nativeProvider: 'openai', piTransportKind: 'openai-responses', readOnlyNative: 'certified' }
          : { nativeProvider: 'openrouter', piTransportKind: 'openai-completions', readOnlyNative: 'certified', compatFlags: { thinkingFormat: 'openrouter' } },
      },
    },
    ladders: {},
  };
}

describe('native-agent provider resolution', () => {
  it('builds a ready OpenAI responses model', () => {
    const [entry] = resolveNativeAgentProviders({
      providers: {
        openai: {
          models: ['gpt-4o'],
        },
      },
    }, {
      env: { OPENAI_API_KEY: 'sk-openai-test' },
      registry: makeCertifiedRegistry('gpt-4o', 'openai'),
    });

    assert(entry);
    assert.equal(entry.status, 'ready');
    assert.equal(entry.providerName, 'openai');
    assert.equal(entry.modelId, 'gpt-4o');
    assert.equal(entry.model.api, 'openai-responses');
    assert.equal(entry.model.provider, 'openai');
    assert.equal(entry.model.baseUrl, OPENAI_DEFAULT_BASE_URL);
    assert.equal(entry.model.id, 'openai:gpt-4o');
    assert.equal(entry.model.name, 'gpt-4o');
    assert.equal(getNativeProviderApiKey(entry), 'sk-openai-test');
  });

  it('builds a ready OpenRouter model with compat and header overrides', () => {
    const [entry] = resolveNativeAgentProviders({
      providers: {
        openrouter: {
          baseUrl: 'https://example.test/openrouter',
          headers: {
            'HTTP-Referer': 'https://wavemill.test',
            'X-Title': 'Wavemill',
          },
          models: ['openrouter-test-model'],
        },
      },
    }, {
      env: { OPENROUTER_API_KEY: 'sk-openrouter-test' },
      registry: makeCertifiedRegistry('openrouter-test-model', 'openrouter'),
    });

    assert(entry);
    assert.equal(entry.status, 'ready');
    assert.equal(entry.model.api, 'openai-completions');
    assert.equal(entry.model.provider, 'openrouter');
    assert.equal(entry.model.baseUrl, 'https://example.test/openrouter');
    assert.deepEqual(entry.model.headers, {
      'HTTP-Referer': 'https://wavemill.test',
      'X-Title': 'Wavemill',
    });
    assert.deepEqual(entry.model.compat, {
      thinkingFormat: 'openrouter',
    });
  });

  it('uses repo .env values and default models when explicit env is absent', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'native-agent-provider-'));
    try {
      writeFileSync(join(repoDir, '.env'), 'WAVEMILL_TEST_OPENAI_KEY=sk-from-dotenv\n', 'utf8');

      const [entry] = resolveNativeAgentProviders({
        providers: {
          openai: {
            apiKeyEnv: 'WAVEMILL_TEST_OPENAI_KEY',
          },
        },
      }, {
        repoDir,
        registry: makeCertifiedRegistry('gpt-4o', 'openai'),
      });

      assert(entry);
      assert.equal(entry.status, 'ready');
      assert.equal(entry.modelId, 'gpt-4o');
      assert.equal(getNativeProviderApiKey(entry), 'sk-from-dotenv');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('marks missing, empty, and whitespace-only keys as unavailable without leaking secrets', () => {
    const consoleLog = console.log;
    const consoleWarn = console.warn;
    const consoleError = console.error;
    const events: string[] = [];
    console.log = (...args: unknown[]) => { events.push(`log:${args.join(' ')}`); };
    console.warn = (...args: unknown[]) => { events.push(`warn:${args.join(' ')}`); };
    console.error = (...args: unknown[]) => { events.push(`error:${args.join(' ')}`); };

    try {
      const missing = resolveNativeAgentProviders({
        providers: {
          openai: {
            apiKeyEnv: 'OPENAI_KEY_NAME',
            models: ['gpt-4o'],
          },
        },
      }, {
        env: {},
      });
      const empty = resolveNativeAgentProviders({
        providers: {
          openrouter: {
            models: ['openai/gpt-4o-mini'],
          },
        },
      }, {
        env: { OPENROUTER_API_KEY: '' },
      });
      const whitespace = resolveNativeAgentProviders({
        providers: {
          openrouter: {
            models: ['openai/gpt-4o-mini'],
          },
        },
      }, {
        env: { OPENROUTER_API_KEY: '   ' },
      });

      for (const entry of [...missing, ...empty, ...whitespace]) {
        assert.equal(entry.status, 'unavailable');
        assert.match(entry.reason, /OPENAI_KEY_NAME|OPENROUTER_API_KEY/);
      }

      const serialized = JSON.stringify({ missing, empty, whitespace });
      assert(!serialized.includes('sk-openrouter-test'));
      assert(!serialized.includes('OPENROUTER_API_KEY='));
      assert.deepEqual(events, []);
    } finally {
      console.log = consoleLog;
      console.warn = consoleWarn;
      console.error = consoleError;
    }
  });

  it('returns skipped entries for disabled providers', () => {
    const [entry] = resolveNativeAgentProviders({
      providers: {
        openrouter: {
          enabled: false,
          models: ['openai/gpt-4o-mini'],
        },
      },
    }, {
      env: { OPENROUTER_API_KEY: 'sk-ignored' },
    });

    assert(entry);
    assert.equal(entry.status, 'skipped');
    assert.match(entry.reason, /enabled is false/);
  });

  it('does not expose ready provider secrets in JSON output', () => {
    const [entry] = resolveNativeAgentProviders({
      providers: {
        openai: {
          models: ['gpt-4o'],
        },
      },
    }, {
      env: { OPENAI_API_KEY: 'sk-secret-value' },
      registry: makeCertifiedRegistry('gpt-4o', 'openai'),
    });

    assert(entry);
    assert.equal(entry.status, 'ready');
    const serialized = JSON.stringify(entry);
    assert(!serialized.includes('sk-secret-value'));
    assert.equal(getNativeProviderApiKey(entry), 'sk-secret-value');
  });
});

describe('native-agent Pi provider lookup', () => {
  it('builds validator-recognized provider/api pairs', () => {
    const openAiModel = buildOpenAiResponsesModel({ modelId: 'gpt-4o' });
    const openRouterModel = buildOpenRouterModel({ modelId: 'openai/gpt-4o-mini' });

    assert.equal(openAiModel.provider, 'openai');
    assert.equal(openAiModel.api, 'openai-responses');
    assert.equal(openRouterModel.provider, 'openrouter');
    assert.equal(openRouterModel.api, 'openai-completions');
  });

  it('resolves built-in Pi providers for OpenAI and OpenRouter models', () => {
    const openAiProvider = getRegisteredPiProviderForModel(buildOpenAiResponsesModel({
      modelId: 'gpt-4o',
    }));
    const openRouterProvider = getRegisteredPiProviderForModel(buildOpenRouterModel({
      modelId: 'openai/gpt-4o-mini',
      baseUrl: OPENROUTER_DEFAULT_BASE_URL,
    }));

    assert(openAiProvider);
    assert(openRouterProvider);
  });

  it('handles unknown provider APIs without throwing', () => {
    const provider = getRegisteredPiProviderForModel({
      api: 'definitely-unknown-provider',
    } as ReturnType<typeof buildOpenAiResponsesModel>);

    assert.equal(provider, undefined);
  });
});

describe('native-agent certification gate', () => {
  it('uncertified model in task mode resolves to uncertified with actionable reason, no API key leaked', () => {
    const emptyRegistry = { models: {}, ladders: {} };

    const consoleLog = console.log;
    const consoleWarn = console.warn;
    const consoleError = console.error;
    const events: string[] = [];
    console.log = (...args: unknown[]) => { events.push(`log:${args.join(' ')}`); };
    console.warn = (...args: unknown[]) => { events.push(`warn:${args.join(' ')}`); };
    console.error = (...args: unknown[]) => { events.push(`error:${args.join(' ')}`); };

    try {
      const entries = resolveNativeAgentProviders({
        providers: {
          openai: {
            models: ['uncertified-model'],
          },
        },
      }, {
        env: { OPENAI_API_KEY: 'sk-secret-should-not-leak' },
        registry: emptyRegistry,
      });

      assert.equal(entries.length, 1);
      const [entry] = entries;
      assert.equal(entry.status, 'uncertified');
      assert.equal(entry.modelId, 'uncertified-model');
      assert.match(entry.reason, /uncertified-model/);
      assert.match(entry.reason, /planning/);

      const serialized = JSON.stringify(entry);
      assert(!serialized.includes('sk-secret-should-not-leak'), 'API key must not appear in serialized output');
      assert.deepEqual(events, []);
    } finally {
      console.log = consoleLog;
      console.warn = consoleWarn;
      console.error = consoleError;
    }
  });

  it('same uncertified model under certificationMode resolves to ready with certificationOnly: true', () => {
    const emptyRegistry = { models: {}, ladders: {} };

    const entries = resolveNativeAgentProviders({
      providers: {
        openai: {
          models: ['uncertified-model'],
        },
      },
    }, {
      env: { OPENAI_API_KEY: 'sk-test' },
      registry: emptyRegistry,
      certificationMode: true,
    });

    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.status, 'ready');
    assert.equal(entry.certificationOnly, true);
  });

  it('certified model resolves to ready with certificationOnly: false', () => {
    const entries = resolveNativeAgentProviders({
      providers: {
        openai: {
          models: ['certified-model'],
        },
      },
    }, {
      env: { OPENAI_API_KEY: 'sk-test' },
      registry: makeCertifiedRegistry('certified-model', 'openai'),
    });

    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.status, 'ready');
    assert.equal(entry.certificationOnly, false);
  });

  it('certified model in certificationMode resolves to ready with certificationOnly: false', () => {
    const entries = resolveNativeAgentProviders({
      providers: {
        openai: {
          models: ['certified-model'],
        },
      },
    }, {
      env: { OPENAI_API_KEY: 'sk-test' },
      registry: makeCertifiedRegistry('certified-model', 'openai'),
      certificationMode: true,
    });

    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.status, 'ready');
    assert.equal(entry.certificationOnly, false);
  });

  it('distinct models are judged independently — no silent substitution', () => {
    const registry: import('../model-registry.ts').ModelRegistry = {
      models: {
        'certified-a': {
          vendor: 'test',
          class: 'strong_generalist',
          strengths: ['testing'],
          weaknesses: [],
          qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
          contextWindowTokens: 128_000,
          toolSupport: 'full',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 1,
          costPerMillionOutputTokensUsd: 2,
          nativeCapability: { nativeProvider: 'openai', piTransportKind: 'openai-responses', readOnlyNative: 'certified' },
        },
      },
      ladders: {},
    };

    const entries = resolveNativeAgentProviders({
      providers: {
        openai: {
          models: ['certified-a', 'uncertified-b'],
        },
      },
    }, {
      env: { OPENAI_API_KEY: 'sk-test' },
      registry,
    });

    assert.equal(entries.length, 2);
    const certifiedEntry = entries.find((e) => e.modelId === 'certified-a');
    const uncertifiedEntry = entries.find((e) => e.modelId === 'uncertified-b');

    assert(certifiedEntry);
    assert.equal(certifiedEntry.status, 'ready');

    assert(uncertifiedEntry);
    assert.equal(uncertifiedEntry.status, 'uncertified');
    assert.match(uncertifiedEntry.reason, /uncertified-b/);
  });
});
