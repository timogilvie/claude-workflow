import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache } from './config.ts';
import {
  isOpenRouterModel,
  openrouterIdForModel,
  resolveOpenRouterProviderConfig,
} from './openrouter-provider.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'wavemill-or-provider-'));
}

function cleanUp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function writeConfig(repoDir: string, config: unknown): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf8');
}

console.log('\n--- openrouter-provider Tests ---\n');

test('recognizes launch-priority OpenRouter aliases', () => {
  assert.equal(isOpenRouterModel('qwen-3-coder'), true);
  assert.equal(isOpenRouterModel('gpt-5.4'), false);
  assert.equal(isOpenRouterModel('claude-sonnet-4-6'), false);
});

test('maps wavemill aliases to OpenRouter ids', () => {
  assert.equal(openrouterIdForModel('qwen-3-coder'), 'qwen/qwen3-coder');
  assert.equal(openrouterIdForModel('gpt-5'), 'openai/gpt-5');
  assert.equal(openrouterIdForModel('missing-model'), null);
});

test('resolves typed provider config with defaults and env detection', () => {
  const tmp = makeTempRepo();
  try {
    clearConfigCache();
    writeConfig(tmp, {
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'CUSTOM_OR_KEY',
          models: ['qwen-3-coder', 'kimi-k2', 'claude-sonnet-4-6'],
          stages: ['coder'],
          effortLevel: 'high',
        },
      },
    });
    process.env.CUSTOM_OR_KEY = 'sk-or-test';
    const resolved = resolveOpenRouterProviderConfig(tmp);
    assert.deepEqual(resolved, {
      enabled: true,
      apiKeyEnv: 'CUSTOM_OR_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: ['qwen-3-coder', 'kimi-k2'],
      stages: ['coder'],
      effortLevel: 'high',
      hasApiKey: true,
    });
    delete process.env.CUSTOM_OR_KEY;
  } finally {
    cleanUp(tmp);
  }
});

if (failed > 0) {
  console.error(`\nopenrouter-provider: ${failed} test(s) failed`);
  process.exit(1);
}

console.log(`\nopenrouter-provider: ${passed} test(s) passed`);
