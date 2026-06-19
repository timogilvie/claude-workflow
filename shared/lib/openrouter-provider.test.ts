import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filterOpenRouterModels,
  getOpenRouterProviderMetadata,
  isOpenRouterModel,
  resolveOpenRouterProviderConfig,
} from './openrouter-provider.ts';
import { clearConfigCache } from './config.ts';

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'openrouter-provider-test-'));
}

function cleanUp(dir: string): void {
  clearConfigCache();
  rmSync(dir, { recursive: true, force: true });
}

function writeConfig(repoDir: string, config: object): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2));
  clearConfigCache();
}

describe('openrouter-provider', () => {
  it('resolveOpenRouterProviderConfig reads config and API key', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, { providers: { openrouter: { enabled: true, apiKeyEnv: 'OPENROUTER_API_KEY', models: ['qwen-3-coder'], stages: ['coder'] } } });
      process.env.OPENROUTER_API_KEY = 'sk-test';
      const config = resolveOpenRouterProviderConfig(tmp);
      assert.equal(config.enabled, true);
      assert.deepEqual(config.models, ['qwen-3-coder']);
      assert.deepEqual(config.stages, ['coder']);
      assert.equal(config.hasApiKey, true);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      cleanUp(tmp);
    }
  });

  it('resolveOpenRouterProviderConfig reads API key from repo .env', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, { providers: { openrouter: { enabled: true, apiKeyEnv: 'OPENROUTER_API_KEY', models: ['qwen-3-coder'], stages: ['coder'] } } });
      writeFileSync(join(tmp, '.env'), 'OPENROUTER_API_KEY=sk-from-env-file\n');
      delete process.env.OPENROUTER_API_KEY;
      const config = resolveOpenRouterProviderConfig(tmp);
      assert.equal(config.hasApiKey, true);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      cleanUp(tmp);
    }
  });

  it('isOpenRouterModel identifies OpenRouter models', () => {
    assert.equal(isOpenRouterModel('qwen-3-coder'), true);
    assert.equal(isOpenRouterModel('gpt-5'), false);
    assert.equal(isOpenRouterModel('deepseek-r1'), false);
  });

  it('filterOpenRouterModels filters by config and stage', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, { providers: { openrouter: { enabled: true, apiKeyEnv: 'OPENROUTER_API_KEY', models: ['qwen-3-coder'], stages: ['coder'] } } });
      process.env.OPENROUTER_API_KEY = 'sk-test';
      const filtered = filterOpenRouterModels(['qwen-3-coder', 'kimi-k2', 'gpt-5'], tmp, 'coder');
      assert.deepEqual(filtered.models, ['qwen-3-coder', 'gpt-5']);
      assert.equal(filtered.warnings.length, 1);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      cleanUp(tmp);
    }
  });

  it('filterOpenRouterModels excludes models for disabled stages', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, { providers: { openrouter: { enabled: true, apiKeyEnv: 'OPENROUTER_API_KEY', models: ['qwen-3-coder'], stages: ['planner'] } } });
      process.env.OPENROUTER_API_KEY = 'sk-test';
      const filtered = filterOpenRouterModels(['qwen-3-coder'], tmp, 'coder');
      assert.deepEqual(filtered.models, []);
      assert.match(filtered.warnings[0] || '', /that stage is not enabled/);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      cleanUp(tmp);
    }
  });

  it('getOpenRouterProviderMetadata returns correct metadata', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, { providers: { openrouter: { enabled: true, apiKeyEnv: 'OPENROUTER_API_KEY', models: ['qwen-3-coder'] } } });
      process.env.OPENROUTER_API_KEY = 'sk-test';
      const metadata = getOpenRouterProviderMetadata('qwen-3-coder', tmp);
      assert.equal(metadata?.provider, 'openrouter');
      assert.equal(metadata?.endpoint, 'https://openrouter.ai/api');
      assert.equal(metadata?.openrouterId, 'qwen/qwen3-coder');
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      cleanUp(tmp);
    }
  });
});
