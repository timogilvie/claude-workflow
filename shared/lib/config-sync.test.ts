import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache, CURRENT_CONFIG_VERSION } from './config.ts';
import {
  CANONICAL_CONFIG_TEMPLATE,
  deepMergeConfig,
  identifyConfigAdditions,
  prepareConfigSync,
} from './config-sync.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'config-sync-'));
}

function cleanUp(dir: string) {
  clearConfigCache(dir);
  rmSync(dir, { recursive: true, force: true });
}

function writeLocalConfig(repoDir: string, config: Record<string, unknown>) {
  writeFileSync(join(repoDir, '.wavemill-config.local.json'), JSON.stringify(config), 'utf-8');
}

console.log('\n--- config-sync tests ---\n');

test('deepMergeConfig preserves user values while adding missing defaults', () => {
  const merged = deepMergeConfig(
    { a: 1, nested: { keep: true, missing: 'x' }, arr: [1, 2] },
    { nested: { keep: false }, arr: [9], extra: 'y' },
  );

  assert.deepEqual(merged, {
    a: 1,
    nested: { keep: false, missing: 'x' },
    arr: [9],
    extra: 'y',
  });
});

test('identifyConfigAdditions reports new nested paths', () => {
  const additions = identifyConfigAdditions({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 });
  assert.deepEqual(additions.sort(), ['a.c', 'd']);
});

test('prepareConfigSync merges current config with canonical template', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({
        configVersion: '1.0.0',
        mill: { maxParallel: 7 },
      }),
      'utf-8',
    );
    clearConfigCache(repoDir);

    const prepared = prepareConfigSync(repoDir);
    assert.equal(prepared.configExists, true);
    assert.equal(prepared.mergedConfig.mill?.maxParallel, 7);
    assert.equal(prepared.mergedConfig.linear?.project, CANONICAL_CONFIG_TEMPLATE.linear?.project);
    assert.ok(prepared.additions.includes('linear'));
  } finally {
    cleanUp(repoDir);
  }
});

test('prepareConfigSync alreadyCurrent ignores local overlay', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify(CANONICAL_CONFIG_TEMPLATE),
      'utf-8',
    );
    clearConfigCache(repoDir);
    const withoutLocal = prepareConfigSync(repoDir);

    writeLocalConfig(repoDir, {
      configVersion: '9.9.9',
      router: {
        enabled: false,
        defaultModel: 'gpt-5.5',
      },
      hokusai: {
        dataSubmission: {
          enabled: true,
          endpoint: 'https://example.com/override',
        },
      },
    });
    clearConfigCache(repoDir);
    const withLocal = prepareConfigSync(repoDir);

    assert.equal(withoutLocal.alreadyCurrent, true);
    assert.equal(withLocal.alreadyCurrent, true);
    assert.deepEqual(withLocal.additions, withoutLocal.additions);
  } finally {
    cleanUp(repoDir);
  }
});

test('prepareConfigSync reports additions from base even when local overlay has them', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({
        configVersion: '1.3.0',
        mill: { maxParallel: 7 },
      }),
      'utf-8',
    );
    writeLocalConfig(repoDir, {
      configVersion: CURRENT_CONFIG_VERSION,
      router: {
        enabled: false,
      },
      hokusai: {
        dataSubmission: {
          enabled: true,
          consentVersion: 'local',
          endpoint: 'https://local.invalid/submit',
        },
      },
    });
    clearConfigCache(repoDir);

    const prepared = prepareConfigSync(repoDir);

    assert.equal(prepared.alreadyCurrent, false);
    assert.ok(prepared.additions.includes('router'));
    assert.ok(prepared.additions.includes('hokusai'));
    assert.equal(prepared.mergedConfig.router?.enabled, CANONICAL_CONFIG_TEMPLATE.router?.enabled);
    assert.equal(prepared.mergedConfig.hokusai?.dataSubmission?.endpoint, undefined);
  } finally {
    cleanUp(repoDir);
  }
});

test('prepareConfigSync output is stable whether local overlay is absent or empty', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({
        configVersion: '1.3.0',
        mill: { maxParallel: 7 },
      }),
      'utf-8',
    );
    clearConfigCache(repoDir);
    const withoutLocal = prepareConfigSync(repoDir);

    writeLocalConfig(repoDir, {});
    clearConfigCache(repoDir);
    const withEmptyLocal = prepareConfigSync(repoDir);

    assert.equal(withoutLocal.alreadyCurrent, withEmptyLocal.alreadyCurrent);
    assert.deepEqual(withoutLocal.additions, withEmptyLocal.additions);
    assert.deepEqual(withoutLocal.mergedConfig, withEmptyLocal.mergedConfig);
  } finally {
    cleanUp(repoDir);
  }
});

test('CANONICAL_CONFIG_TEMPLATE.configVersion matches CURRENT_CONFIG_VERSION', () => {
  assert.equal(CANONICAL_CONFIG_TEMPLATE.configVersion, CURRENT_CONFIG_VERSION);
});

test('CANONICAL_CONFIG_TEMPLATE exposes promoted OpenRouter aliases on user-facing surfaces', () => {
  assert.ok(CANONICAL_CONFIG_TEMPLATE.eval?.pricing?.['glm-5.2']);
  assert.ok(CANONICAL_CONFIG_TEMPLATE.eval?.pricing?.['kimi-k2.7-code']);
  assert.ok(CANONICAL_CONFIG_TEMPLATE.providers?.openrouter?.models?.includes('glm-5.2'));
  assert.ok(CANONICAL_CONFIG_TEMPLATE.providers?.openrouter?.models?.includes('kimi-k2.7-code'));
  assert.ok(CANONICAL_CONFIG_TEMPLATE.challenge?.models?.includes('glm-5.2'));
  assert.ok(CANONICAL_CONFIG_TEMPLATE.challenge?.models?.includes('kimi-k2.7-code'));
  assert.ok(CANONICAL_CONFIG_TEMPLATE.router?.availableModels?.planner?.includes('glm-5.2'));
  assert.ok(CANONICAL_CONFIG_TEMPLATE.router?.availableModels?.planner?.includes('kimi-k2.7-code'));
  assert.ok(CANONICAL_CONFIG_TEMPLATE.router?.availableModels?.coder?.includes('glm-5.2'));
  assert.ok(CANONICAL_CONFIG_TEMPLATE.router?.availableModels?.coder?.includes('kimi-k2.7-code'));
  assert.ok(CANONICAL_CONFIG_TEMPLATE.router?.availableModels?.reviewer?.includes('glm-5.2'));
  assert.ok(CANONICAL_CONFIG_TEMPLATE.router?.availableModels?.reviewer?.includes('kimi-k2.7-code'));
});

test('CANONICAL_CONFIG_TEMPLATE exposes watchlist aliases only in launchable stages', () => {
  const expected = {
    'claude-fable-5': ['planner', 'coder', 'reviewer'],
    'gpt-4.1': ['coder'],
    'deepseek-coder-v2': ['coder'],
    'qwen-3-235b': ['planner', 'coder', 'reviewer'],
    'qwen-2.5-72b': ['coder'],
    'kimi-k2-thinking': ['planner', 'coder', 'reviewer'],
    'gemini-2.0-flash': ['coder'],
    'llama-4-scout': ['coder'],
    'mistral-medium-3': ['coder'],
    'devstral-medium': ['coder'],
    'grok-code-fast': ['coder'],
  } as const;
  const pools = CANONICAL_CONFIG_TEMPLATE.router?.availableModels;
  assert.ok(pools);

  for (const [modelId, stages] of Object.entries(expected)) {
    assert.ok(CANONICAL_CONFIG_TEMPLATE.providers?.openrouter?.models?.includes(modelId));
    for (const stage of ['planner', 'coder', 'reviewer'] as const) {
      assert.equal(
        pools[stage]?.includes(modelId),
        (stages as readonly string[]).includes(stage),
        `${modelId}:${stage}`,
      );
    }
  }
});

test('wavemill init heredoc configVersion matches CURRENT_CONFIG_VERSION', () => {
  const script = readFileSync(join(import.meta.dirname, '..', '..', 'wavemill'), 'utf-8');
  const match = script.match(/"configVersion":\s*"([^"]+)"/);

  assert.ok(match, 'expected wavemill init template to contain configVersion');
  assert.equal(
    match[1],
    CURRENT_CONFIG_VERSION,
    `wavemill init heredoc configVersion (${match[1]}) has drifted from CURRENT_CONFIG_VERSION (${CURRENT_CONFIG_VERSION}). Update wavemill init template.`,
  );
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
});
