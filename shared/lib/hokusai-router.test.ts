/**
 * Tests for the Hokusai router bridge.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache, getHokusaiRouterConfig } from './config.ts';
import { routeViaHokusai } from './hokusai-router.ts';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'hokusai-router-test-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    router: {
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        timeout: 100,
      },
    },
  }));
  clearConfigCache(repoDir);

  return {
    repoDir,
    cleanup: () => {
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

console.log('\n--- hokusai-router Tests ---\n');

await test('successful routing returns a workflow decision', async () => {
  const { repoDir, cleanup } = makeRepo();
  globalThis.fetch = async () => new Response(JSON.stringify({
    schema_version: '1.0',
    route: {
      planner_model: 'claude-sonnet-4-5-20250929',
      coder_model: 'gpt-5.3-codex',
      reviewer_model: 'claude-haiku-4-5-20251001',
      plan_depth: 'medium',
      code_depth: 'high',
      review_mode: 'standard',
    },
    predictions: {
      expected_success_probability: 0.91,
      expected_cost_usd: 2.5,
      confidence: 0.72,
    },
  }), { status: 200 });

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.ok(decision);
    assert.equal(decision?.coder, 'gpt-5.3-codex');
    assert.equal(decision?.codeDepth, 'deep');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('timeout handling returns null', async () => {
  const { repoDir, cleanup } = makeRepo();
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.equal(decision, null);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('network errors return null and warn', async () => {
  const { repoDir, cleanup } = makeRepo();
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.equal(decision, null);
    assert.ok(warnings.some((message) => message.includes('Hokusai routing failed')));
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('invalid responses return null', async () => {
  const { repoDir, cleanup } = makeRepo();
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

  try {
    const decision = await routeViaHokusai('Implement a backend feature with tests.', { repoDir });
    assert.equal(decision, null);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('config loading returns endpoint and timeout', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const config = getHokusaiRouterConfig(repoDir);
    assert.equal(config.endpoint, 'http://localhost:8080/predict');
    assert.equal(config.timeout, 100);
  } finally {
    cleanup();
  }
});

await test('maxCostUsd is passed through to the Hokusai request', async () => {
  const { repoDir, cleanup } = makeRepo();
  let requestBody = '';
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      schema_version: '1.0',
      route: {
        planner_model: 'claude-sonnet-4-5-20250929',
        coder_model: 'gpt-5.3-codex',
        reviewer_model: 'claude-haiku-4-5-20251001',
        plan_depth: 'low',
        code_depth: 'medium',
        review_mode: 'light',
      },
      predictions: {
        expected_success_probability: 0.7,
        expected_cost_usd: 1.1,
        confidence: 0.6,
      },
    }), { status: 200 });
  };

  try {
    await routeViaHokusai('Implement a backend feature with tests.', { repoDir, maxCostUsd: 3.25 });
    const parsed = JSON.parse(requestBody);
    assert.equal(parsed.constraints.max_cost_usd, 3.25);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
