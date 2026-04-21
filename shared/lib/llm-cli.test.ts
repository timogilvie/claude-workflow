import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { readEvalRecords } from './eval-persistence.ts';
import { callLLM, LLMQuotaError, parseJsonFromLLM } from './llm-cli.ts';
import { markExhausted, readQuotaSnapshot } from './quota-state.ts';

let tempRoot: string;
let repoDir: string;

function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ result: T; stderr: string }> {
  let output = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;

  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, stderr: output }))
    .finally(() => {
      process.stderr.write = originalWrite;
    });
}

function captureStderrError(fn: () => Promise<unknown>): Promise<{ error: unknown; stderr: string }> {
  let output = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;

  return Promise.resolve()
    .then(fn)
    .then(() => {
      throw new Error('Expected function to throw');
    })
    .catch((error) => ({ error, stderr: output }))
    .finally(() => {
      process.stderr.write = originalWrite;
    });
}

function git(command: string, cwd: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}

function createRepoDir(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  git('init', dir);
  git('config user.name "Test User"', dir);
  git('config user.email "test@example.com"', dir);
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf-8');
  git('add README.md', dir);
  git('commit -m "init"', dir);
  return dir;
}

function writeRegistryConfig(config: Record<string, unknown>): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  clearConfigCache(repoDir);
}

function createMockCli(
  name: string,
  behavior: Record<string, Array<Record<string, unknown>> | Record<string, unknown>>
): { cliPath: string; logPath: string } {
  const cliPath = join(tempRoot, `${name}.mjs`);
  const logPath = join(tempRoot, `${name}.log`);
  const statePath = join(tempRoot, `${name}.state.json`);
  const script = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const behavior = ${JSON.stringify(behavior)};
const logPath = ${JSON.stringify(logPath)};
const statePath = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : '(default)';
const stdinChunks = [];

function readState() {
  if (!existsSync(statePath)) {
    return {};
  }
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state), 'utf-8');
}

function resolveAction() {
  const state = readState();
  const attempt = state[model] ?? 0;
  state[model] = attempt + 1;
  writeState(state);

  const configured = behavior[model] ?? behavior.default ?? { type: 'success', text: \`ok from \${model}\` };
  if (Array.isArray(configured)) {
    return configured[Math.min(attempt, configured.length - 1)];
  }
  return configured;
}

process.stdin.on('data', (chunk) => stdinChunks.push(chunk));
process.stdin.on('end', () => {
  const action = resolveAction();
  appendFileSync(logPath, JSON.stringify({ model, args, stdin: Buffer.concat(stdinChunks).toString('utf-8') }) + '\\n');

  if (action.type === 'success') {
    process.stdout.write(JSON.stringify({
      result: action.text,
      usage: action.usage,
      total_cost_usd: action.costUsd,
    }));
    process.exit(0);
  }

  process.stderr.write(String(action.message ?? 'error'));
  process.exit(Number(action.code ?? 1));
});

process.stdin.resume();
`;

  writeFileSync(cliPath, script, 'utf-8');
  chmodSync(cliPath, 0o755);
  return { cliPath, logPath };
}

function readInvocations(logPath: string): Array<{ model: string }> {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { model: string });
}

function readFallbackRecords() {
  return readEvalRecords({ dir: join(repoDir, '.wavemill', 'evals') }).filter(
    (record) => record.agentType === 'llm-cli' && record.fallbackEvent,
  );
}

beforeEach(() => {
  tempRoot = join(tmpdir(), `llm-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  repoDir = createRepoDir('repo');
  clearConfigCache();
});

afterEach(() => {
  clearConfigCache();
  if (existsSync(tempRoot)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('parseJsonFromLLM', () => {
  describe('valid JSON extraction', () => {
    it('parses a plain JSON object', () => {
      assert.deepEqual(parseJsonFromLLM('{ "score": 10 }'), { score: 10 });
    });

    it('parses JSON wrapped in markdown fences', () => {
      assert.deepEqual(parseJsonFromLLM('```json\n{ "score": 10 }\n```'), { score: 10 });
    });

    it('extracts JSON from mixed content', () => {
      assert.deepEqual(parseJsonFromLLM('Here is the result: { "score": 10 } done'), { score: 10 });
    });

    it('handles nested objects and arrays', () => {
      assert.deepEqual(parseJsonFromLLM('{ "outer": { "items": [1, 2, 3] } }'), {
        outer: { items: [1, 2, 3] },
      });
    });

    it('preserves escaped unicode characters', () => {
      assert.deepEqual(parseJsonFromLLM('{ "text": "hello \\u4e16\\u754c" }'), {
        text: 'hello \u4e16\u754c',
      });
    });

    it('allows JavaScript-looking text inside valid JSON strings', () => {
      assert.deepEqual(parseJsonFromLLM('{ "note": "Use => only in code examples" }'), {
        note: 'Use => only in code examples',
      });
    });

    it('allows assignment-looking text inside valid JSON strings', () => {
      assert.deepEqual(parseJsonFromLLM('{ "note": "const result = value" }'), {
        note: 'const result = value',
      });
    });
  });

  describe('JavaScript syntax detection', () => {
    it('rejects JavaScript destructuring syntax', () => {
      assert.throws(
        () => parseJsonFromLLM('{ datasetFile, ...rest }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects unquoted property names', () => {
      assert.throws(
        () => parseJsonFromLLM('{ winner: "primary", score: 10 }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects spread syntax', () => {
      assert.throws(
        () => parseJsonFromLLM('{ ...config, override: true }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects JavaScript variable assignments wrapping JSON', () => {
      assert.throws(
        () => parseJsonFromLLM('const result = { "score": 10 }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects arrow functions in invalid JSON candidates', () => {
      assert.throws(
        () => parseJsonFromLLM('{ "fn": () => 10 }'),
        /JavaScript code instead of JSON/
      );
    });
  });

  describe('error handling', () => {
    it('throws on an empty string', () => {
      assert.throws(() => parseJsonFromLLM(''), /Failed to parse JSON from LLM output/);
    });

    it('throws on text with no JSON object', () => {
      assert.throws(() => parseJsonFromLLM('not json at all'), /Failed to parse JSON from LLM output/);
    });

    it('includes a preview in generic parse errors', () => {
      assert.throws(
        () => parseJsonFromLLM('invalid { "broken": true'),
        /First 500 chars:\ninvalid \{ "broken": true/
      );
    });
  });
});

describe('quota fallback', () => {
  it('falls back to the next model, marks exhaustion, and returns the successful model', async () => {
    const { cliPath } = createMockCli('quota-to-success', {
      'model-a': { type: 'quota', message: 'Error: 429 rate_limit_exceeded', code: 1 },
      'model-b': { type: 'success', text: 'ok from b', costUsd: 0.12 },
    });

    const { result, stderr } = await captureStderr(() => callLLM('test prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      difficulty: 'hard',
      fallbackModels: ['model-a', 'model-b'],
    }));

    assert.match(stderr, /\[coder] model-a unavailable \(quota\); falling back to model-b/);
    assert.equal(result.text, 'ok from b');
    assert.equal(result.model, 'model-b');
    assert.deepEqual(result.fallbackChain, [{ model: 'model-a', reason: 'quota' }]);

    const snapshot = readQuotaSnapshot(repoDir);
    assert.equal(snapshot.models['model-a']?.status, 'exhausted');
    assert.equal(snapshot.models['model-b']?.status, 'healthy');

    const records = readFallbackRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].schemaVersion, '1.8.0');
    assert.equal(records[0].modelId, 'model-b');
    assert.equal(records[0].score, 1);
    assert.equal(records[0].fallbackEvent?.preferred_model, 'model-a');
    assert.equal(records[0].fallbackEvent?.fallback_model, 'model-b');
    assert.equal(records[0].fallbackEvent?.task_type, 'coding');
    assert.equal(records[0].fallbackEvent?.difficulty, 'hard');
    assert.equal(records[0].fallbackEvent?.outcome, 'success');
    assert.equal(records[0].fallbackEvent?.cost_usd, 0.12);
    assert.deepEqual(records[0].fallbackEvent?.fallback_chain, [{ model: 'model-a', reason: 'quota' }]);
  });

  it('stays silent when an observer handles quota fallback telemetry', async () => {
    const { cliPath } = createMockCli('quota-observer', {
      'model-a': { type: 'quota', message: 'Error: 429 rate_limit_exceeded', code: 1 },
      'model-b': { type: 'success', text: 'ok from b' },
    });

    const fallbackEvents: Array<{ failedModel: string; nextModel?: string; reason?: string; resetAt?: string | null }> = [];
    const { result, stderr } = await captureStderr(() => callLLM('observer prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
      observer: {
        onQuotaFallback(event) {
          fallbackEvents.push(event);
          return Promise.resolve();
        },
      },
    }));

    assert.equal(stderr, '');
    assert.equal(result.model, 'model-b');
    assert.deepEqual(fallbackEvents, [{ failedModel: 'model-a', nextModel: 'model-b', reason: 'quota', resetAt: null }]);
  });

  it('throws LLMQuotaError when every candidate is exhausted', async () => {
    const { cliPath } = createMockCli('all-quota', {
      'model-a': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'model-b': { type: 'quota', message: '429 quota exceeded', code: 1 },
    });

    const { error, stderr } = await captureStderrError(() => callLLM('all fail', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
    }));

    assert.ok(error instanceof LLMQuotaError);
    assert.match((error as Error).message, /model-a/);
    assert.match((error as Error).message, /model-b/);

    assert.match(
      stderr,
      /\[coder] model-b unavailable \(quota\); no remaining fallback candidates after: model-a -> model-b/,
    );

    const records = readFallbackRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].modelId, 'model-a');
    assert.equal(records[0].score, 0);
    assert.equal(records[0].fallbackEvent?.outcome, 'all_exhausted');
    assert.equal(records[0].fallbackEvent?.fallback_model, null);
    assert.deepEqual(records[0].fallbackEvent?.fallback_chain, [
      { model: 'model-a', reason: 'quota' },
      { model: 'model-b', reason: 'quota' },
    ]);
  });

  it('uses task-specific ladders from the registry', async () => {
    writeRegistryConfig({
      configVersion: '1.3.0',
      modelRegistry: {
        models: {
          'model-a': { class: 'frontier', qualityScores: { coding: 90, review: 50 } },
          'model-b': { class: 'strong_generalist', qualityScores: { coding: 80, review: 95 } },
          'model-c': { class: 'fast_economy', qualityScores: { coding: 70, review: 60 } },
        },
        ladders: {
          coding: ['model-a', 'model-b', 'model-c'],
          review: ['model-b', 'model-a', 'model-c'],
        },
      },
    });

    const codingCli = createMockCli('coding-ladder', {
      'model-a': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'model-b': { type: 'success', text: 'coding winner' },
    });
    const codingResult = await callLLM('coding prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: codingCli.cliPath,
      repoDir,
      taskType: 'coding',
    });
    assert.equal(codingResult.model, 'model-b');

    repoDir = createRepoDir('review-repo');
    writeRegistryConfig({
      configVersion: '1.3.0',
      modelRegistry: {
        models: {
          'model-a': { class: 'frontier', qualityScores: { coding: 90, review: 50 } },
          'model-b': { class: 'strong_generalist', qualityScores: { coding: 80, review: 95 } },
          'model-c': { class: 'fast_economy', qualityScores: { coding: 70, review: 60 } },
        },
        ladders: {
          coding: ['model-a', 'model-b', 'model-c'],
          review: ['model-b', 'model-a', 'model-c'],
        },
      },
    });

    const reviewCli = createMockCli('review-ladder', {
      'model-b': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'model-a': { type: 'success', text: 'review winner' },
    });
    const reviewResult = await callLLM('review prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: reviewCli.cliPath,
      repoDir,
      taskType: 'review',
    });
    assert.equal(reviewResult.model, 'model-a');
  });

  it('persists a non_quota_error fallback event when a later candidate fails for another reason', async () => {
    const { cliPath } = createMockCli('quota-then-other-error', {
      'model-a': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'model-b': { type: 'other', message: 'syntax explosion', code: 1 },
    });

    await assert.rejects(
      () => callLLM('mixed failure', {
        provider: 'claude',
        mode: 'stream',
        cliCmd: cliPath,
        repoDir,
        taskType: 'review',
        fallbackModels: ['model-a', 'model-b'],
      }),
      /syntax explosion/,
    );

    const records = readFallbackRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].score, 0);
    assert.equal(records[0].fallbackEvent?.outcome, 'non_quota_error');
    assert.equal(records[0].fallbackEvent?.task_type, 'review');
    assert.deepEqual(records[0].fallbackEvent?.fallback_chain, [{ model: 'model-a', reason: 'quota' }]);
  });

  it('does not persist fallback evals when logFallbackEvents is false', async () => {
    const { cliPath } = createMockCli('fallback-opt-out', {
      'model-a': { type: 'quota', message: '429 quota exceeded', code: 1 },
      'model-b': { type: 'success', text: 'ok from b' },
    });

    const result = await callLLM('opt-out prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
      logFallbackEvents: false,
    });

    assert.equal(result.model, 'model-b');
    assert.deepEqual(readFallbackRecords(), []);
  });

  it('bypasses exponential backoff for quota fallbacks', async () => {
    const { cliPath } = createMockCli('quota-fast-fallback', {
      'model-a': { type: 'quota', message: '429 rate_limit_exceeded', code: 1 },
      'model-b': { type: 'success', text: 'fast fallback' },
    });

    const startedAt = Date.now();
    const result = await callLLM('timing prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      retry: true,
      maxRetries: 2,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.model, 'model-b');
    assert.ok(elapsedMs < 1000, `expected quota fallback without backoff, got ${elapsedMs}ms`);
  });

  it('keeps exponential backoff for transient errors on the same model', async () => {
    const { cliPath, logPath } = createMockCli('transient-retry', {
      'model-a': [
        { type: 'transient', message: 'socket hang up', code: 1 },
        { type: 'success', text: 'recovered' },
      ],
      'model-b': { type: 'success', text: 'should not run' },
    });

    const startedAt = Date.now();
    const result = await callLLM('retry prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      retry: true,
      maxRetries: 1,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.model, 'model-a');
    assert.ok(elapsedMs >= 1900, `expected retry backoff, got ${elapsedMs}ms`);
    assert.deepEqual(readInvocations(logPath).map((entry) => entry.model), ['model-a', 'model-a']);
  });

  it('preserves backward compatibility when fallback is not enabled', async () => {
    const { cliPath } = createMockCli('backward-compat', {
      default: { type: 'quota', message: '429 rate limit exceeded', code: 1 },
    });

    await assert.rejects(
      () => callLLM('legacy prompt', {
        provider: 'claude',
        mode: 'sync',
        cliCmd: cliPath,
        repoDir,
      }),
      /rate limit or quota exceeded/
    );

    assert.equal(existsSync(join(repoDir, '.wavemill', 'quota-state.json')), false);
  });

  it('skips models already marked exhausted before invoking the CLI', async () => {
    markExhausted({ modelId: 'model-a', reason: 'quota' }, repoDir);
    const { cliPath, logPath } = createMockCli('skip-exhausted', {
      'model-b': { type: 'success', text: 'started on b' },
    });

    const result = await callLLM('skip prompt', {
      provider: 'claude',
      mode: 'stream',
      cliCmd: cliPath,
      repoDir,
      taskType: 'coding',
      fallbackModels: ['model-a', 'model-b'],
    });

    assert.equal(result.model, 'model-b');
    assert.deepEqual(readInvocations(logPath).map((entry) => entry.model), ['model-b']);
  });
});
