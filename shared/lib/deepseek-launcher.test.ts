/**
 * Tests for deepseek-launcher — env/state construction for claude-deepseek agent path.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import {
  buildDeepSeekLauncherEnv,
  resolveDeepSeekLauncherStateDir,
  MissingDeepSeekApiKeyError,
  InvalidPathSegmentError,
  UnsafeStateDirError,
} from './deepseek-launcher.ts';

// ────────────────────────────────────────────────────────────────
// Minimal test harness (matches project convention)
// ────────────────────────────────────────────────────────────────

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

function throws(fn: () => unknown, ErrorClass: new (...args: unknown[]) => Error, msgPattern?: RegExp): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    assert.ok(err instanceof ErrorClass, `Expected ${ErrorClass.name} but got ${Object.getPrototypeOf(err as object).constructor.name}`);
    if (msgPattern) {
      assert.match((err as Error).message, msgPattern);
    }
  }
  if (!threw) {
    assert.fail(`Expected ${ErrorClass.name} to be thrown`);
  }
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wavemill-ds-test-'));
  return dir;
}

function cleanUp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────
// resolveDeepSeekLauncherStateDir
// ────────────────────────────────────────────────────────────────

test('resolves default state dir under .wavemill/deepseek-state', () => {
  const tmp = makeTempRepo();
  try {
    const dir = resolveDeepSeekLauncherStateDir({ repoDir: tmp, session: 'sess1', issue: 'HOK-123' });
    assert.ok(dir.includes('.wavemill/deepseek-state/sess1-HOK-123'), `Unexpected state dir: ${dir}`);
    assert.ok(dir.startsWith(tmp), `State dir should be under repoDir`);
  } finally {
    cleanUp(tmp);
  }
});

test('accepts custom stateDir when valid', () => {
  const tmp = makeTempRepo();
  try {
    const custom = join(tmp, 'my-state');
    const dir = resolveDeepSeekLauncherStateDir({ repoDir: tmp, session: 'sess1', issue: 'HOK-123', configuredStateDir: custom });
    assert.equal(dir, custom);
  } finally {
    cleanUp(tmp);
  }
});

test('rejects stateDir pointing at real ~/.claude', () => {
  const tmp = makeTempRepo();
  try {
    throws(
      () => resolveDeepSeekLauncherStateDir({
        repoDir: tmp,
        session: 'sess1',
        issue: 'HOK-123',
        configuredStateDir: join(homedir(), '.claude'),
      }),
      UnsafeStateDirError,
    );
  } finally {
    cleanUp(tmp);
  }
});

test('rejects stateDir under ~/.claude', () => {
  const tmp = makeTempRepo();
  try {
    throws(
      () => resolveDeepSeekLauncherStateDir({
        repoDir: tmp,
        session: 'sess1',
        issue: 'HOK-123',
        configuredStateDir: join(homedir(), '.claude', 'projects', 'foo'),
      }),
      UnsafeStateDirError,
    );
  } finally {
    cleanUp(tmp);
  }
});

test('rejects empty session', () => {
  const tmp = makeTempRepo();
  try {
    throws(
      () => resolveDeepSeekLauncherStateDir({ repoDir: tmp, session: '', issue: 'HOK-123' }),
      InvalidPathSegmentError,
    );
  } finally {
    cleanUp(tmp);
  }
});

test('rejects session with path traversal', () => {
  const tmp = makeTempRepo();
  try {
    throws(
      () => resolveDeepSeekLauncherStateDir({ repoDir: tmp, session: '../evil', issue: 'HOK-123' }),
      InvalidPathSegmentError,
    );
  } finally {
    cleanUp(tmp);
  }
});

test('rejects issue with shell-special chars', () => {
  const tmp = makeTempRepo();
  try {
    throws(
      () => resolveDeepSeekLauncherStateDir({ repoDir: tmp, session: 'sess1', issue: 'HOK;123' }),
      InvalidPathSegmentError,
    );
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// buildDeepSeekLauncherEnv — env keys and model defaults
// ────────────────────────────────────────────────────────────────

test('emits all required env keys with valid key set', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildDeepSeekLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      processEnv: { DEEPSEEK_API_KEY: 'sk-test' },
    });

    const required = [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'CLAUDE_CODE_EFFORT_LEVEL',
      'CLAUDE_CONFIG_DIR',
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'WAVEMILL_AGENT_KIND',
      'WAVEMILL_DEEPSEEK_STATE_DIR',
    ] as const;

    for (const key of required) {
      assert.ok(typeof env[key] === 'string' && env[key].length > 0, `Missing env key: ${key}`);
    }
  } finally {
    cleanUp(tmp);
  }
});

test('uses deepseek-v4-flash as default model', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildDeepSeekLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      processEnv: { DEEPSEEK_API_KEY: 'sk-test' },
    });
    assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-flash');
  } finally {
    cleanUp(tmp);
  }
});

test('respects explicit model override when it is a DeepSeek model', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildDeepSeekLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      model: 'deepseek-v4-pro',
      processEnv: { DEEPSEEK_API_KEY: 'sk-test' },
    });
    assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-pro');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro');
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-v4-pro');
  } finally {
    cleanUp(tmp);
  }
});

test('ignores non-DeepSeek model override and falls back to default', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildDeepSeekLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      model: 'claude-sonnet-4-6',
      processEnv: { DEEPSEEK_API_KEY: 'sk-test' },
    });
    assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-flash');
  } finally {
    cleanUp(tmp);
  }
});

test('sets correct ANTHROPIC_BASE_URL', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildDeepSeekLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      processEnv: { DEEPSEEK_API_KEY: 'sk-test' },
    });
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  } finally {
    cleanUp(tmp);
  }
});

test('sets WAVEMILL_AGENT_KIND to claude-deepseek', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildDeepSeekLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      processEnv: { DEEPSEEK_API_KEY: 'sk-test' },
    });
    assert.equal(env.WAVEMILL_AGENT_KIND, 'claude-deepseek');
  } finally {
    cleanUp(tmp);
  }
});

test('HOME, XDG_CONFIG_HOME, XDG_DATA_HOME are under state dir', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildDeepSeekLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      processEnv: { DEEPSEEK_API_KEY: 'sk-test' },
    });
    assert.ok(env.HOME.startsWith(env.WAVEMILL_DEEPSEEK_STATE_DIR), 'HOME should be under state dir');
    assert.ok(env.XDG_CONFIG_HOME.startsWith(env.WAVEMILL_DEEPSEEK_STATE_DIR), 'XDG_CONFIG_HOME should be under state dir');
    assert.ok(env.XDG_DATA_HOME.startsWith(env.WAVEMILL_DEEPSEEK_STATE_DIR), 'XDG_DATA_HOME should be under state dir');
    assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(env.WAVEMILL_DEEPSEEK_STATE_DIR), 'CLAUDE_CONFIG_DIR should be under state dir');
  } finally {
    cleanUp(tmp);
  }
});

test('state dir never points at real ~/.claude', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildDeepSeekLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      processEnv: { DEEPSEEK_API_KEY: 'sk-test' },
    });
    const realClaudeHome = join(homedir(), '.claude');
    assert.ok(!env.WAVEMILL_DEEPSEEK_STATE_DIR.startsWith(realClaudeHome));
    assert.ok(!env.HOME.startsWith(realClaudeHome));
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Missing API key
// ────────────────────────────────────────────────────────────────

test('throws MissingDeepSeekApiKeyError when DEEPSEEK_API_KEY is not set', () => {
  const tmp = makeTempRepo();
  try {
    throws(
      () => buildDeepSeekLauncherEnv({
        repoDir: tmp,
        session: 'sess1',
        issue: 'HOK-123',
        processEnv: {},
      }),
      MissingDeepSeekApiKeyError,
      /DEEPSEEK_API_KEY/,
    );
  } finally {
    cleanUp(tmp);
  }
});

test('error message does not reveal the actual key value', () => {
  const tmp = makeTempRepo();
  try {
    let errorMsg = '';
    try {
      buildDeepSeekLauncherEnv({
        repoDir: tmp,
        session: 'sess1',
        issue: 'HOK-123',
        processEnv: {},
      });
    } catch (err) {
      errorMsg = (err as Error).message;
    }
    assert.ok(errorMsg.length > 0, 'Should have thrown');
    assert.ok(!errorMsg.includes('sk-'), 'Error message must not include API key prefix');
  } finally {
    cleanUp(tmp);
  }
});

test('throws MissingDeepSeekApiKeyError when key is empty string', () => {
  const tmp = makeTempRepo();
  try {
    throws(
      () => buildDeepSeekLauncherEnv({
        repoDir: tmp,
        session: 'sess1',
        issue: 'HOK-123',
        processEnv: { DEEPSEEK_API_KEY: '' },
      }),
      MissingDeepSeekApiKeyError,
    );
  } finally {
    cleanUp(tmp);
  }
});

test('throws MissingDeepSeekApiKeyError when key is whitespace only', () => {
  const tmp = makeTempRepo();
  try {
    throws(
      () => buildDeepSeekLauncherEnv({
        repoDir: tmp,
        session: 'sess1',
        issue: 'HOK-123',
        processEnv: { DEEPSEEK_API_KEY: '   ' },
      }),
      MissingDeepSeekApiKeyError,
    );
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Custom apiKeyEnv precedence
// ────────────────────────────────────────────────────────────────

test('uses ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY as the resolved key', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildDeepSeekLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-123',
      processEnv: { DEEPSEEK_API_KEY: 'sk-test-value' },
    });
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-test-value');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-test-value');
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// REQ-F5: env injection validation (HOK-1489)
// Verify ANTHROPIC_BASE_URL, auth env var, and ANTHROPIC_MODEL are all
// present in the launcher env without making a real network call.
// ────────────────────────────────────────────────────────────────

test('REQ-F5: ANTHROPIC_BASE_URL points to DeepSeek endpoint (no network call)', () => {
  const tmp = makeTempRepo();
  try {
    const env = buildDeepSeekLauncherEnv({
      repoDir: tmp,
      session: 'sess1',
      issue: 'HOK-1489',
      processEnv: { DEEPSEEK_API_KEY: 'sk-test' },
    });
    assert.ok(
      env.ANTHROPIC_BASE_URL.startsWith('https://api.deepseek.com'),
      `ANTHROPIC_BASE_URL should point to DeepSeek, got: ${env.ANTHROPIC_BASE_URL}`,
    );
    assert.ok(
      typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.length > 0,
      'ANTHROPIC_AUTH_TOKEN must be a non-empty string',
    );
    assert.ok(
      typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL.length > 0,
      'ANTHROPIC_MODEL must be set',
    );
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
if (failed > 0) {
  process.exit(1);
}
