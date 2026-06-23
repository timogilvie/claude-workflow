import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearConfigCache, loadWavemillConfig } from '../config.ts';
import {
  resolveLiveProviderModels,
  verifyProviderDispatch,
} from './providers.ts';

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'native-agent-providers-test-'));
}

function cleanUp(dir: string): void {
  clearConfigCache();
  rmSync(dir, { recursive: true, force: true });
}

function writeConfig(repoDir: string, config: object): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2));
  clearConfigCache();
}

function containsValue(value: unknown, needle: string): boolean {
  if (typeof value === 'string') {
    return value.includes(needle);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsValue(item, needle));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsValue(item, needle));
  }
  return false;
}

function captureConsole<T>(fn: () => T): { result: T; output: string } {
  const lines: string[] = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  console.warn = (...args: unknown[]) => { lines.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };

  try {
    return { result: fn(), output: lines.join('\n') };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

describe('native-agent live provider resolver', () => {
  const originalDisableAjv = process.env.WAVEMILL_DISABLE_AJV_VALIDATION;

  beforeEach(() => {
    process.env.WAVEMILL_DISABLE_AJV_VALIDATION = '0';
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    if (originalDisableAjv === undefined) {
      delete process.env.WAVEMILL_DISABLE_AJV_VALIDATION;
    } else {
      process.env.WAVEMILL_DISABLE_AJV_VALIDATION = originalDisableAjv;
    }
  });

  it('builds an OpenRouter openai-completions model with default baseUrl', () => {
    const secret = 'SECRET-DO-NOT-LEAK';
    const resolution = resolveLiveProviderModels({
      providers: {
        openrouter: {
          enabled: true,
          models: [{ id: 'anthropic/claude-3.5-sonnet', api: 'openai-completions' }],
        },
      },
    }, { OPENROUTER_API_KEY: secret });

    assert.equal(resolution.available[0]?.api, 'openai-completions');
    assert.equal(resolution.available[0]?.baseUrl, 'https://openrouter.ai/api/v1');
    assert.ok(!JSON.stringify(resolution).includes(secret));
    assert.ok(!containsValue(resolution, secret));
  });

  it('builds an OpenAI Responses model with default baseUrl and preserved headers', () => {
    const resolution = resolveLiveProviderModels({
      providers: {
        openai: {
          enabled: true,
          headers: { 'X-Test': 'wavemill' },
          models: [{ id: 'gpt-5', api: 'openai-responses' }],
        },
      },
    }, { OPENAI_API_KEY: 'sk-openai' });

    assert.equal(resolution.available[0]?.api, 'openai-responses');
    assert.equal(resolution.available[0]?.baseUrl, 'https://api.openai.com/v1');
    assert.deepEqual(resolution.available[0]?.headers, { 'X-Test': 'wavemill' });
  });

  it('respects a custom apiKeyEnv override', () => {
    const resolution = resolveLiveProviderModels({
      providers: {
        openai: {
          enabled: true,
          apiKeyEnv: 'MY_OPENAI_KEY',
          models: [{ id: 'gpt-5', api: 'openai-responses' }],
        },
      },
    }, { OPENAI_API_KEY: '', MY_OPENAI_KEY: 'sk-custom' });

    assert.equal(resolution.available.length, 1);
    assert.equal(resolution.unavailable.length, 0);
    assert.equal(resolution.available[0]?.provider, 'openai');
  });

  it('marks missing keys as unavailable without leaking the secret sentinel', () => {
    const { result: resolution, output } = captureConsole(() => resolveLiveProviderModels({
      providers: {
        openai: {
          enabled: true,
          models: [{ id: 'gpt-5', api: 'openai-responses' }],
        },
      },
    }, { OPENAI_API_KEY: '' }));

    assert.deepEqual(resolution.unavailable, [{ provider: 'openai', reason: 'missing_key', envVar: 'OPENAI_API_KEY' }]);
    assert.ok(!JSON.stringify(resolution).includes('SECRET-DO-NOT-LEAK'));
    assert.ok(!output.includes('SECRET-DO-NOT-LEAK'));
  });

  it('marks disabled providers as unavailable', () => {
    const resolution = resolveLiveProviderModels({
      providers: {
        openai: {
          enabled: false,
          models: [{ id: 'gpt-5', api: 'openai-responses' }],
        },
      },
    }, {});

    assert.deepEqual(resolution.unavailable, [{ provider: 'openai', reason: 'disabled' }]);
  });

  it('resolves both providers at once', () => {
    const resolution = resolveLiveProviderModels({
      providers: {
        openai: {
          enabled: true,
          models: [{ id: 'gpt-5', api: 'openai-responses' }],
        },
        openrouter: {
          enabled: true,
          models: [{ id: 'anthropic/claude-3.5-sonnet', api: 'openai-completions' }],
        },
      },
    }, {
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'sk-openrouter',
    });

    assert.equal(resolution.available.length, 2);
    assert.deepEqual(
      resolution.available.map((model) => model.provider).sort(),
      ['openai', 'openrouter'],
    );
  });

  it('passes compat through unchanged', () => {
    const compat = { thinkingFormat: 'openrouter' } as const;
    const resolution = resolveLiveProviderModels({
      providers: {
        openrouter: {
          enabled: true,
          models: [{
            id: 'anthropic/claude-3.5-sonnet',
            api: 'openai-completions',
            compat,
          }],
        },
      },
    }, { OPENROUTER_API_KEY: 'sk-openrouter' });

    assert.deepEqual(resolution.available[0]?.compat, compat);
  });

  it('passes headers through unchanged', () => {
    const headers = {
      'HTTP-Referer': 'https://wavemill.dev',
      'X-Title': 'Wavemill',
    };
    const resolution = resolveLiveProviderModels({
      providers: {
        openrouter: {
          enabled: true,
          headers,
          models: [{ id: 'anthropic/claude-3.5-sonnet', api: 'openai-completions' }],
        },
      },
    }, { OPENROUTER_API_KEY: 'sk-openrouter' });

    assert.deepEqual(resolution.available[0]?.headers, headers);
  });

  it('verifies Pi provider dispatch for both live APIs', () => {
    assert.ok(verifyProviderDispatch('openai-completions'));
    assert.ok(verifyProviderDispatch('openai-responses'));
  });

  it('creates one model per configured model entry', () => {
    const resolution = resolveLiveProviderModels({
      providers: {
        openai: {
          enabled: true,
          models: [
            { id: 'gpt-5', api: 'openai-responses' },
            { id: 'gpt-5-mini', api: 'openai-responses' },
          ],
        },
      },
    }, { OPENAI_API_KEY: 'sk-openai' });

    assert.deepEqual(
      resolution.available.map((model) => model.id),
      ['gpt-5', 'gpt-5-mini'],
    );
  });

  it('rejects unknown native agent provider names during config validation', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, {
        nativeAgent: {
          providers: {
            anthropic: {
              enabled: true,
              models: [{ id: 'claude', api: 'openai-completions' }],
            },
          },
        },
      });

      assert.throws(() => loadWavemillConfig(tmp), /nativeAgent\/providers/);
    } finally {
      cleanUp(tmp);
    }
  });

  it('rejects unsupported live provider api values during config validation', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, {
        nativeAgent: {
          providers: {
            openai: {
              enabled: true,
              models: [{ id: 'gpt-5', api: 'anthropic-messages' }],
            },
          },
        },
      });

      assert.throws(() => loadWavemillConfig(tmp), /nativeAgent\/providers\/openai\/models\/0\/api/);
    } finally {
      cleanUp(tmp);
    }
  });
});
