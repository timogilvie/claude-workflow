/**
 * Tests for the workflow router.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import { readTaskPromptFromFile, routeWorkflow, routeWorkflowAuto, routeWorkflowHokusai, summarizeWorkflowRoute } from './workflow-router.ts';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function baseConfig() {
  return {
    router: {
      enabled: true,
      mode: 'heuristic',
      defaultAgent: 'claude',
      minRecords: 4,
      minModels: 2,
      defaultModel: 'claude-sonnet-4-5-20250929',
      agentMap: {
        'claude-opus-4-6': 'claude',
        'claude-sonnet-4-5-20250929': 'claude',
        'claude-haiku-4-5-20251001': 'claude',
        'gpt-5.3-codex': 'codex',
        'gpt-5.4': 'codex',
      },
    },
    eval: {
      pricing: {
        'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
        'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
      },
    },
  };
}

function makeRepo(configOverride?: Record<string, unknown>): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'workflow-router-test-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'evals', 'records.jsonl'), [
    JSON.stringify({ id: '1', modelId: 'gpt-5.3-codex', originalPrompt: 'Create a CLI command', score: 0.91, timeSeconds: 100, interventionCount: 0 }),
    JSON.stringify({ id: '2', modelId: 'gpt-5.3-codex', originalPrompt: 'Add a route tool', score: 0.88, timeSeconds: 110, interventionCount: 0 }),
    JSON.stringify({ id: '3', modelId: 'gpt-5.3-codex', originalPrompt: 'Implement a feature', score: 0.9, timeSeconds: 95, interventionCount: 1 }),
    JSON.stringify({ id: '4', modelId: 'gpt-5.3-codex', originalPrompt: 'Build a new workflow', score: 0.87, timeSeconds: 120, interventionCount: 1 }),
    JSON.stringify({ id: '5', modelId: 'gpt-5.3-codex', originalPrompt: 'Create JSON output for CLI', score: 0.89, timeSeconds: 100, interventionCount: 0 }),
    JSON.stringify({ id: '6', modelId: 'claude-sonnet-4-5-20250929', originalPrompt: 'Create a CLI command', score: 0.84, timeSeconds: 140, interventionCount: 0 }),
    JSON.stringify({ id: '7', modelId: 'claude-sonnet-4-5-20250929', originalPrompt: 'Implement a feature', score: 0.82, timeSeconds: 150, interventionCount: 0 }),
    JSON.stringify({ id: '8', modelId: 'claude-sonnet-4-5-20250929', originalPrompt: 'Build a new workflow', score: 0.83, timeSeconds: 135, interventionCount: 0 }),
    JSON.stringify({ id: '9', modelId: 'claude-sonnet-4-5-20250929', originalPrompt: 'Refactor a route command', score: 0.81, timeSeconds: 160, interventionCount: 1 }),
    JSON.stringify({ id: '10', modelId: 'claude-sonnet-4-5-20250929', originalPrompt: 'Fix a CLI bug', score: 0.85, timeSeconds: 145, interventionCount: 1 }),
    JSON.stringify({ id: '11', modelId: 'claude-opus-4-6', originalPrompt: 'Implement a feature', score: 0.9, timeSeconds: 220, interventionCount: 0 }),
    JSON.stringify({ id: '12', modelId: 'claude-opus-4-6', originalPrompt: 'Fix a migration bug', score: 0.93, timeSeconds: 210, interventionCount: 0 }),
    JSON.stringify({ id: '13', modelId: 'claude-opus-4-6', originalPrompt: 'Complex infrastructure update', score: 0.92, timeSeconds: 230, interventionCount: 0 }),
    JSON.stringify({ id: '14', modelId: 'claude-opus-4-6', originalPrompt: 'Secure auth flow', score: 0.94, timeSeconds: 240, interventionCount: 0 }),
    JSON.stringify({ id: '15', modelId: 'claude-opus-4-6', originalPrompt: 'Review workflow config', score: 0.91, timeSeconds: 235, interventionCount: 0 }),
    '',
  ].join('\n'));

  const config = {
    ...baseConfig(),
    ...configOverride,
  };
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config));
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

console.log('\n--- workflow-router Tests ---\n');

await test('routes broad CLI workflow work to deep planning and medium-or-higher review', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Create a wavemill route CLI command that extends the router, outputs planner coder and reviewer, prints JSON and stdout, and estimates cost and success.',
      { repoDir },
    );
    assert.equal(decision.planDepth, 'deep');
    assert.ok(['gpt-5.3-codex', 'claude-sonnet-4-5-20250929', 'claude-opus-4-6'].includes(decision.coder));
    assert.ok(['llm', 'static+llm'].includes(decision.reviewRecommended));
    assert.ok(['medium', 'deep'].includes(decision.codeDepth));
    assert.ok(decision.expectedCostCode >= 0);
    assert.ok(decision.expectedCostPlan >= 0);
    assert.ok(decision.expectedSuccess <= 0.97 && decision.expectedSuccess >= 0.35);
    assert.ok(decision.confidence >= 0.1 && decision.confidence <= 0.95);
  } finally {
    cleanup();
  }
});

await test('routes documentation work to lighter review', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Update the README.md documentation for the route command and add usage examples.',
      { repoDir },
    );
    assert.equal(decision.reviewRecommended, 'static');
    assert.equal(decision.planDepth, 'light');
  } finally {
    cleanup();
  }
});

await test('includes budget constraints in heuristic routing decisions when provided', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Implement a backend workflow feature with tests.',
      { repoDir, maxCostUsd: 3.5 },
    );
    assert.deepEqual(decision.constraints, { maxCostUsd: 3.5 });
  } finally {
    cleanup();
  }
});

await test('heuristic routing confidence varies across prompts instead of staying constant', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const featureDecision = routeWorkflow('Implement a feature for the workflow router.', { repoDir });
    const bugfixDecision = routeWorkflow('Fix the auth migration router bug in config.ts.', { repoDir });
    assert.notEqual(featureDecision.confidence, bugfixDecision.confidence);
    assert.ok(featureDecision.confidence >= 0.1 && featureDecision.confidence <= 0.95);
    assert.ok(bugfixDecision.confidence >= 0.1 && bugfixDecision.confidence <= 0.95);
  } finally {
    cleanup();
  }
});

await test('reads selected-task style json files', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const filePath = join(repoDir, 'selected-task.json');
    writeFileSync(filePath, JSON.stringify({
      title: 'Create route command',
      description: 'Add JSON output and CLI wiring.',
    }));
    assert.equal(readTaskPromptFromFile(filePath), 'Create route command\n\nAdd JSON output and CLI wiring.');
  } finally {
    cleanup();
  }
});

await test('reads markdown task-packet files without JSON parsing', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const filePath = join(repoDir, 'task-packet.md');
    writeFileSync(filePath, '# Task Packet\n\n## 1. Objective\n\nRoute against this content.\n');
    assert.equal(readTaskPromptFromFile(filePath), '# Task Packet\n\n## 1. Objective\n\nRoute against this content.');
  } finally {
    cleanup();
  }
});

await test('summary output includes stage lines and success', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow('Build a new CLI tool with JSON output and review support.', { repoDir });
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /Planner:/);
    assert.match(summary, /Coder:/);
    assert.match(summary, /Reviewer:/);
    assert.match(summary, /Success:/);
    assert.match(summary, /confidence=\d+\.\d{2}/);
  } finally {
    cleanup();
  }
});

await test('auto mode uses hokusai first when configured', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        timeout: 1000,
      },
    },
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    schema_version: '1.0',
    route: {
      planner_model: 'claude-sonnet-4-5-20250929',
      coder_model: 'gpt-5.3-codex',
      reviewer_model: 'claude-haiku-4-5-20251001',
      plan_depth: 'medium',
      code_depth: 'medium',
      review_mode: 'light',
    },
    predictions: {
      expected_success_probability: 0.88,
      expected_cost_usd: 1.75,
      confidence: 0.81,
    },
  }), { status: 200 });

  try {
    const decision = await routeWorkflowAuto('Add a workflow router mode with tests.', { repoDir });
    assert.equal(decision.routingMode, 'hokusai');
    assert.equal(decision.coder, 'gpt-5.3-codex');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('auto mode falls back to stage-aware chain without hokusai config', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    assert.notEqual(decision.routingMode, 'hokusai');
  } finally {
    cleanup();
  }
});

await test('explicit hokusai mode falls back gracefully to stage-aware', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'hokusai',
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        timeout: 100,
      },
    },
  });

  globalThis.fetch = async () => {
    throw new Error('unreachable');
  };

  try {
    const decision = await routeWorkflowHokusai('Build a backend feature with tests and review.', { repoDir });
    assert.notEqual(decision.routingMode, 'hokusai');
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
