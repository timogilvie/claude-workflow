import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filterOpenRouterModels,
  getOpenRouterProviderMetadata,
  isOpenRouterDirectAgentsEnabled,
  isOpenRouterModel,
  resolveOpenRouterModelId,
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
    assert.equal(isOpenRouterModel('qwen/qwen3-coder'), true);
    assert.equal(isOpenRouterModel('glm-5.2'), true);
    assert.equal(isOpenRouterModel('z-ai/glm-5.2'), true);
    assert.equal(isOpenRouterModel('kimi-k2.7-code'), true);
    assert.equal(isOpenRouterModel('moonshotai/kimi-k2.7-code'), true);
    assert.equal(isOpenRouterModel('gpt-5'), false);
    assert.equal(isOpenRouterModel('deepseek-r1'), false);
  });

  it('resolveOpenRouterModelId resolves promoted aliases', () => {
    assert.equal(resolveOpenRouterModelId('qwen/qwen3-coder'), 'qwen/qwen3-coder');
    assert.equal(resolveOpenRouterModelId('glm-5.2'), 'z-ai/glm-5.2');
    assert.equal(resolveOpenRouterModelId('z-ai/glm-5.2'), 'z-ai/glm-5.2');
    assert.equal(resolveOpenRouterModelId('kimi-k2.7-code'), 'moonshotai/kimi-k2.7-code');
  });

  it('reads the direct-agent gate from environment', () => {
    assert.equal(isOpenRouterDirectAgentsEnabled({ OPENROUTER_DIRECT_AGENTS_ENABLED: '1' }), true);
    assert.equal(isOpenRouterDirectAgentsEnabled({ OPENROUTER_DIRECT_AGENTS_ENABLED: 'true' }), true);
    assert.equal(isOpenRouterDirectAgentsEnabled({ OPENROUTER_DIRECT_AGENTS_ENABLED: '0' }), false);
    assert.equal(isOpenRouterDirectAgentsEnabled({}), false);
  });

  it('filterOpenRouterModels ignores configured model allowlists when provider access is configured', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, { providers: { openrouter: { enabled: true, apiKeyEnv: 'OPENROUTER_API_KEY', models: ['qwen-3-coder'], stages: ['coder'] } } });
      process.env.OPENROUTER_API_KEY = 'sk-test';
      const filtered = filterOpenRouterModels(['qwen-3-coder', 'kimi-k2', 'gpt-5'], tmp, 'coder');
      assert.deepEqual(filtered.models, ['qwen-3-coder', 'kimi-k2', 'gpt-5']);
      assert.deepEqual(filtered.warnings, []);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      cleanUp(tmp);
    }
  });

  it('filterOpenRouterModels treats raw OpenRouter ids and aliases as equivalent allowlist entries', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, { providers: { openrouter: { enabled: true, apiKeyEnv: 'OPENROUTER_API_KEY', models: ['qwen/qwen3-coder'], stages: ['coder'] } } });
      process.env.OPENROUTER_API_KEY = 'sk-test';
      const config = resolveOpenRouterProviderConfig(tmp);
      assert.deepEqual(config.models, ['qwen-3-coder']);

      const aliasFiltered = filterOpenRouterModels(['qwen-3-coder'], tmp, 'coder');
      assert.deepEqual(aliasFiltered.models, ['qwen-3-coder']);
      assert.deepEqual(aliasFiltered.warnings, []);

      const idFiltered = filterOpenRouterModels(['qwen/qwen3-coder'], tmp, 'coder');
      assert.deepEqual(idFiltered.models, ['qwen/qwen3-coder']);
      assert.deepEqual(idFiltered.warnings, []);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      cleanUp(tmp);
    }
  });

  it('filterOpenRouterModels ignores configured provider stages', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, { providers: { openrouter: { enabled: true, apiKeyEnv: 'OPENROUTER_API_KEY', models: ['qwen-3-coder'], stages: ['planner'] } } });
      process.env.OPENROUTER_API_KEY = 'sk-test';
      const filtered = filterOpenRouterModels(['qwen-3-coder'], tmp, 'coder');
      assert.deepEqual(filtered.models, ['qwen-3-coder']);
      assert.deepEqual(filtered.warnings, []);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      cleanUp(tmp);
    }
  });

  it('getOpenRouterProviderMetadata returns correct metadata', () => {
    const tmp = makeTempRepo();
    try {
      writeConfig(tmp, {
        providers: {
          openrouter: {
            enabled: true,
            apiKeyEnv: 'OPENROUTER_API_KEY',
            models: ['qwen-3-coder', 'glm-5.2', 'kimi-k2.7-code'],
          },
        },
      });
      process.env.OPENROUTER_API_KEY = 'sk-test';
      const metadataByModel = new Map(
        ['qwen-3-coder', 'glm-5.2', 'kimi-k2.7-code']
          .map((modelId) => [modelId, getOpenRouterProviderMetadata(modelId, tmp)]),
      );
      assert.equal(metadataByModel.get('qwen-3-coder')?.provider, 'openrouter');
      assert.equal(metadataByModel.get('qwen-3-coder')?.endpoint, 'https://openrouter.ai/api');
      assert.equal(metadataByModel.get('qwen-3-coder')?.openrouterId, 'qwen/qwen3-coder');
      assert.equal(metadataByModel.get('glm-5.2')?.openrouterId, 'z-ai/glm-5.2');
      assert.equal(metadataByModel.get('kimi-k2.7-code')?.openrouterId, 'moonshotai/kimi-k2.7-code');
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      cleanUp(tmp);
    }
  });
});
