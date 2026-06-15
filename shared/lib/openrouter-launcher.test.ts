import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOpenRouterLauncherEnv,
  InvalidOpenRouterModelError,
  InvalidPathSegmentError,
  MissingOpenRouterApiKeyError,
  resolveOpenRouterLauncherStateDir,
} from './openrouter-launcher.ts';

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
  return mkdtempSync(join(tmpdir(), 'wavemill-or-launcher-'));
}

function cleanUp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n--- openrouter-launcher Tests ---\n');

test('resolves state dir under WAVEMILL_RUN_DIR when present', () => {
  const dir = resolveOpenRouterLauncherStateDir({
    repoDir: '/tmp/repo',
    session: 'sess1',
    issue: 'HOK-123',
    processEnv: { WAVEMILL_RUN_DIR: '/tmp/run-root' },
  });
  assert.equal(dir, '/tmp/run-root/providers/openrouter');
});

test('rejects unsafe path segments', () => {
  assert.throws(
    () => resolveOpenRouterLauncherStateDir({
      repoDir: '/tmp/repo',
      session: '../bad',
      issue: 'HOK-123',
    }),
    InvalidPathSegmentError,
  );
});

test('builds an env block using the mapped OpenRouter model id', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildOpenRouterLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      model: 'qwen-3-coder',
      processEnv: { OPENROUTER_API_KEY: 'sk-openrouter' },
    });

    assert.equal(env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api/v1');
    assert.equal(env.ANTHROPIC_MODEL, 'qwen/qwen3-coder');
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'qwen/qwen3-coder');
    assert.equal(env.WAVEMILL_AGENT_KIND, 'claude-openrouter');
    assert.ok(env.WAVEMILL_OPENROUTER_STATE_DIR.includes('.wavemill/runs/sess1-HOK-123/providers/openrouter'));
  } finally {
    cleanUp(tmp);
  }
});

test('throws when API key is missing', () => {
  const tmp = makeTempRepo();
  try {
    assert.throws(
      () => buildOpenRouterLauncherEnv({
        repoDir: tmp,
        session: 'sess1',
        issue: 'HOK-123',
        model: 'qwen-3-coder',
        processEnv: {},
      }),
      MissingOpenRouterApiKeyError,
    );
  } finally {
    cleanUp(tmp);
  }
});

test('throws for unknown aliases', () => {
  const tmp = makeTempRepo();
  try {
    assert.throws(
      () => buildOpenRouterLauncherEnv({
        repoDir: tmp,
        session: 'sess1',
        issue: 'HOK-123',
        model: 'not-a-real-model',
        processEnv: { OPENROUTER_API_KEY: 'sk-openrouter' },
      }),
      InvalidOpenRouterModelError,
    );
  } finally {
    cleanUp(tmp);
  }
});

if (failed > 0) {
  console.error(`\nopenrouter-launcher: ${failed} test(s) failed`);
  process.exit(1);
}

console.log(`\nopenrouter-launcher: ${passed} test(s) passed`);
