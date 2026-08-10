import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import { runMillConfigPreflight } from './mill-config-preflight.ts';
import { REMOVED_MODEL_SETTING_PATHS } from './model-settings-migrator.ts';

function makeRepo(config: unknown): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'mill-config-preflight-'));
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2));
  return repoDir;
}

function cleanup(repoDir: string): void {
  clearConfigCache(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
}

function legacyConfigWithEveryRemovedField(): Record<string, unknown> {
  return {
    modelRegistry: {
      models: { 'legacy-model': { provider: 'openrouter' } },
      ladders: { coder: ['legacy-model'] },
    },
    router: {
      enabled: true,
      defaultAgent: 'claude',
      defaultModel: 'legacy-model',
      models: ['legacy-model'],
      availableModels: { coder: ['legacy-model'] },
      agentMap: { 'legacy-model': 'native-openrouter' },
    },
    challenge: {
      enabled: true,
      models: ['legacy-model'],
      comparisonModel: 'legacy-judge',
    },
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: ['legacy-model'],
        stages: ['coder'],
      },
      deepseek: {
        enabled: true,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        models: ['deepseek-legacy'],
        stages: ['coder'],
      },
    },
    nativeAgent: {
      providers: {
        openai: {
          enabled: true,
          apiKeyEnv: 'OPENAI_API_KEY',
          models: ['gpt-legacy'],
        },
        openrouter: {
          enabled: true,
          apiKeyEnv: 'OPENROUTER_API_KEY',
          models: ['openrouter/legacy'],
        },
      },
    },
  };
}

test('runMillConfigPreflight rejects every removed HOK-2587 model field', () => {
  const repoDir = makeRepo(legacyConfigWithEveryRemovedField());
  try {
    const result = runMillConfigPreflight(repoDir);
    assert.equal(result.ok, false);
    assert.equal(result.report.removedFields.length, REMOVED_MODEL_SETTING_PATHS.length);
    assert.deepEqual(
      result.report.removedFields.map((entry) => entry.path).sort(),
      [...REMOVED_MODEL_SETTING_PATHS].sort(),
    );
    assert.match(result.report.validationError ?? '', /wavemill config migrate-model-settings/);
  } finally {
    cleanup(repoDir);
  }
});

test('runMillConfigPreflight accepts clean config', () => {
  const repoDir = makeRepo({
    router: { enabled: true, defaultAgent: 'claude' },
    observer: { enabled: false },
  });
  try {
    const result = runMillConfigPreflight(repoDir);
    assert.equal(result.ok, true);
    assert.equal(result.report.removedFields.length, 0);
    assert.equal(result.report.validationError, null);
  } finally {
    cleanup(repoDir);
  }
});

test('runMillConfigPreflight reports only present legacy fields', () => {
  const repoDir = makeRepo({
    router: {
      enabled: true,
      defaultAgent: 'claude',
      defaultModel: 'legacy-model',
    },
  });
  try {
    const result = runMillConfigPreflight(repoDir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.report.removedFields.map((entry) => entry.path), ['router.defaultModel']);
  } finally {
    cleanup(repoDir);
  }
});
