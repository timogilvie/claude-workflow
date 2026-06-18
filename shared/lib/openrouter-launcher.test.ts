import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOpenRouterLauncherEnv,
  resolveOpenRouterLauncherStateDir,
  MissingOpenRouterApiKeyError,
  InvalidPathSegmentError,
} from './openrouter-launcher.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function throws(fn: () => unknown, ErrorClass: new (...args: unknown[]) => Error): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    assert.ok(err instanceof ErrorClass);
  }
  if (!threw) {
    assert.fail(`Expected ${ErrorClass.name}`);
  }
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'wavemill-or-test-'));
}

function cleanUp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test('resolves default state dir under .wavemill/openrouter-state', () => {
  const tmp = makeTempRepo();
  try {
    const dir = resolveOpenRouterLauncherStateDir(tmp, 'sess1', 'HOK-123');
    assert.ok(dir.includes('.wavemill/openrouter-state/sess1-HOK-123'));
  } finally {
    cleanUp(tmp);
  }
});

test('builds env using OpenRouter model ID', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildOpenRouterLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      model: 'qwen-3-coder',
      processEnv: { OPENROUTER_API_KEY: 'sk-test' },
    });
    assert.equal(env.ANTHROPIC_MODEL, 'qwen/qwen3-coder');
    assert.equal(env.WAVEMILL_AGENT_KIND, 'claude-openrouter');
  } finally {
    cleanUp(tmp);
  }
});

test('defaults to qwen-3-coder when model is omitted', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildOpenRouterLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      processEnv: { OPENROUTER_API_KEY: 'sk-test' },
    });
    assert.equal(env.ANTHROPIC_MODEL, 'qwen/qwen3-coder');
  } finally {
    cleanUp(tmp);
  }
});

test('throws when API key is missing', () => {
  const tmp = makeTempRepo();
  try {
    throws(() => buildOpenRouterLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      model: 'qwen-3-coder',
      processEnv: {},
    }), MissingOpenRouterApiKeyError);
  } finally {
    cleanUp(tmp);
  }
});

test('rejects invalid session', () => {
  const tmp = makeTempRepo();
  try {
    throws(() => resolveOpenRouterLauncherStateDir(tmp, '../bad', 'HOK-123'), InvalidPathSegmentError);
  } finally {
    cleanUp(tmp);
  }
});

process.on('exit', () => {
  if (failed > 0) {
    process.exitCode = 1;
  }
});
