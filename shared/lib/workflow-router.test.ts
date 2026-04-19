/**
 * Tests for the workflow router.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import type { QuotaStatus } from './quota-state.ts';
import { applyDifficultyFloor, readTaskPromptFromFile, routeWorkflow, routeWorkflowAuto, routeWorkflowHokusai, summarizeWorkflowRoute, tryPolicyResolution } from './workflow-router.ts';

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
        'claude-opus-4-7': 'claude',
        'claude-opus-4-6': 'claude',
        'claude-sonnet-4-6': 'claude',
        'claude-sonnet-4-5-20250929': 'claude',
        'claude-haiku-4-5-20251001': 'claude',
        'gpt-5.3-codex': 'codex',
        'gpt-5.4': 'codex',
      },
    },
    eval: {
      pricing: {
        'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-sonnet-4-6': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
        'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
        'gpt-5.4': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
      },
    },
  };
}

function frontierSiblingConfig() {
  return {
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
    modelRegistry: {
      models: {
        'gpt-5.4': {
          vendor: 'openai',
          class: 'frontier',
          strengths: ['code generation'],
          weaknesses: ['api dependency'],
          qualityScores: { planning: 88, coding: 82, review: 85, classify: 70, routing: 72 },
        },
      },
      ladders: {
        planning: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
        coding: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
        review: ['claude-opus-4-7', 'gpt-5.4', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
        routing: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7', 'gpt-5.4'],
        classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'gpt-5.4'],
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

function writeQuotaState(
  repoDir: string,
  models: Record<string, QuotaStatus>,
): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'quota-state.json'), JSON.stringify({
    version: 1,
    updatedAt: '2026-04-17T12:00:00.000Z',
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, status]) => [modelId, {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
        requestHistory: [],
        consecutiveNearLimitSignals: 0,
        lastNearLimitAt: null,
        budgetSignal: null,
      }]),
    ),
  }, null, 2), 'utf-8');
}

async function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ result: T; stderr: string }> {
  let output = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = await fn();
    return { result, stderr: output };
  } finally {
    process.stderr.write = originalWrite;
  }
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
    assert.ok([
      'gpt-5.3-codex',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-6',
      'claude-opus-4-7',
    ].includes(decision.coder));
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

await test('auto mode uses degraded haiku-only routing in survival mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    const selectedModels = [decision.planner, decision.coder, decision.reviewer];

    assert.ok(selectedModels.every((modelId) => modelId.toLowerCase().includes('haiku')));
    assert.ok(selectedModels.every((modelId) => !modelId.toLowerCase().includes('opus')));
    assert.ok(selectedModels.every((modelId) => !modelId.toLowerCase().includes('sonnet')));
    assert.match(decision.reasoning[0], /Survival mode/);
    assert.equal(typeof decision.planner, 'string');
    assert.equal(typeof decision.coder, 'string');
    assert.equal(typeof decision.reviewer, 'string');
    assert.ok(['stage-aware', 'stage-aware-partial', 'heuristic-fallback'].includes(decision.routingMode));
    assert.equal(typeof decision.neighborCount, 'number');
    assert.ok(Array.isArray(decision.neighborSimilarityRange));
  } finally {
    cleanup();
  }
});

await test('auto mode excludes opus in constrained mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    const selectedModels = [decision.planner, decision.coder, decision.reviewer];

    assert.ok(selectedModels.every((modelId) => !modelId.toLowerCase().includes('opus')));
    assert.ok(selectedModels.every((modelId) => modelId.toLowerCase().includes('sonnet') || modelId.toLowerCase().includes('haiku')));
    assert.match(decision.reasoning[0], /Constrained mode/);
  } finally {
    cleanup();
  }
});

await test('auto mode emits a constrained router transparency line when quota is degrading', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir })
    );
    assert.match(stderr, /\[router] constrained mode: claude-opus-4-7 quota is degrading; reserving it for high-complexity steps/);
    assert.ok(result.reasoning[0].includes('Constrained mode'));
  } finally {
    cleanup();
  }
});

await test('auto mode does not prepend degraded reasoning in normal mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'healthy',
    'claude-opus-4-6': 'healthy',
  });

  try {
    const decision = await routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir });
    assert.doesNotMatch(decision.reasoning[0], /Survival mode|Constrained mode/);
  } finally {
    cleanup();
  }
});

await test('auto mode stays silent in normal routing mode', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'healthy',
    'claude-opus-4-6': 'healthy',
  });

  try {
    const { stderr } = await captureStderr(() =>
      routeWorkflowAuto('Build a backend feature with tests and review.', { repoDir })
    );
    assert.doesNotMatch(stderr, /\[(router|coder|planner|reviewer|classifier)]/);
  } finally {
    cleanup();
  }
});

await test('policy routing logs same-class frontier substitution distinctly', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.4': 'healthy',
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      Promise.resolve(tryPolicyResolution(
        'Implement a backend feature with tests and review.',
        { repoDir, taskDifficulty: 'hard', skipDifficultyClassification: true }
      ))
    );
    assert.equal(result?.routingMode, 'policy');
    assert.match(stderr, /\[coder] policy adjustment: claude-opus-4-7 -> gpt-5\.4 \(quota=exhausted, same-class=frontier\)/);
    assert.doesNotMatch(stderr, /\[router] constrained mode:/);
  } finally {
    cleanup();
  }
});

await test('policy routing logs class downgrade without same-class metadata', async () => {
  const { repoDir, cleanup } = makeRepo({
    router: {
      ...baseConfig().router,
      mode: 'auto',
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
  });

  try {
    const { stderr } = await captureStderr(() =>
      Promise.resolve(tryPolicyResolution(
        'Implement a backend feature with tests and review.',
        { repoDir, taskDifficulty: 'hard', skipDifficultyClassification: true }
      ))
    );
    assert.match(stderr, /\[planner] policy adjustment: claude-opus-4-7 -> claude-sonnet-4-6 \(quota=degrading\)/);
    assert.doesNotMatch(stderr, /same-class=/);
  } finally {
    cleanup();
  }
});

await test('auto mode logs frontier substitution without constrained banner when healthy sibling exists', async () => {
  const { repoDir, cleanup } = makeRepo({
    ...frontierSiblingConfig(),
    router: {
      ...frontierSiblingConfig().router,
      hokusai: {
        endpoint: 'http://localhost:8080/predict',
        timeout: 1000,
      },
    },
  });

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.4': 'healthy',
  });

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      schema_version: '1.0',
      route: {
        planner_model: 'gpt-5.4',
        coder_model: 'gpt-5.4',
        reviewer_model: 'gpt-5.4',
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
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', { repoDir })
    );
    assert.equal(result.routingMode, 'hokusai');
    assert.match(stderr, /\[coder] policy adjustment: claude-opus-4-7 -> gpt-5\.4 \(quota=exhausted, same-class=frontier\)/);
    assert.doesNotMatch(stderr, /\[router] constrained mode:/);
    assert.doesNotMatch(result.reasoning[0], /Constrained mode|Survival mode/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

await test('auto mode routes to healthy frontier sibling when anthropic frontier is exhausted', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.4': 'healthy',
  });

  try {
    const decision = await routeWorkflowAuto('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'hard',
      skipDifficultyClassification: true,
    });
    assert.equal(decision.planner, 'gpt-5.4');
    assert.equal(decision.coder, 'gpt-5.4');
    assert.equal(decision.reviewer, 'gpt-5.4');
    assert.doesNotMatch(decision.reasoning[0], /Constrained mode|Survival mode/);
  } finally {
    cleanup();
  }
});

await test('tryPolicyResolution pools select healthy frontier for all three roles', () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.4': 'healthy',
  });

  try {
    const decision = tryPolicyResolution('Implement a backend feature with tests and review.', {
      repoDir,
      taskDifficulty: 'hard',
      skipDifficultyClassification: true,
    });
    assert.equal(decision?.routingMode, 'policy');
    assert.equal(decision?.planner, 'gpt-5.4');
    assert.equal(decision?.coder, 'gpt-5.4');
    assert.equal(decision?.reviewer, 'gpt-5.4');
  } finally {
    cleanup();
  }
});

await test('emits same-class substitution log for every role and no constrained banner in case (a)', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.4': 'healthy',
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      })
    );
    assert.equal(result.planner, 'gpt-5.4');
    assert.equal(result.coder, 'gpt-5.4');
    assert.equal(result.reviewer, 'gpt-5.4');
    assert.match(stderr, /\[planner] policy adjustment: claude-opus-4-7 -> gpt-5\.4 \(quota=exhausted, same-class=frontier\)/);
    assert.match(stderr, /\[coder] policy adjustment: claude-opus-4-7 -> gpt-5\.4 \(quota=exhausted, same-class=frontier\)/);
    assert.match(stderr, /\[reviewer] policy adjustment: claude-opus-4-7 -> gpt-5\.4 \(quota=exhausted, same-class=frontier\)/);
    assert.doesNotMatch(stderr, /\[router] (constrained|survival) mode:/);
    assert.doesNotMatch(result.reasoning[0], /Constrained mode|Survival mode/);
  } finally {
    cleanup();
  }
});

await test('emits constrained-mode banner when every frontier vendor is degrading (case b)', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'degrading',
    'claude-opus-4-6': 'degrading',
    'gpt-5.4': 'degrading',
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', { repoDir })
    );
    assert.match(stderr, /\[router] constrained mode: .* quota is degrading; reserving it for high-complexity steps/);
    assert.ok(result.reasoning[0].includes('Constrained mode'));
    assert.doesNotMatch(stderr, /same-class=frontier/);
  } finally {
    cleanup();
  }
});

await test('emits survival-mode banner when every frontier vendor is exhausted (case c)', async () => {
  const { repoDir, cleanup } = makeRepo(frontierSiblingConfig());

  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
    'gpt-5.4': 'exhausted',
  });

  try {
    const { result, stderr } = await captureStderr(() =>
      routeWorkflowAuto('Implement a backend feature with tests and review.', { repoDir })
    );
    assert.match(stderr, /\[router] survival mode: .* quota is exhausted; restricting routing to fast-economy models/);
    assert.ok(result.reasoning[0].includes('Survival mode'));
    assert.ok([result.planner, result.coder, result.reviewer].every((modelId) => modelId.toLowerCase().includes('haiku')));
    assert.doesNotMatch(stderr, /same-class=frontier/);
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

// ────────────────────────────────────────────────────────────────
// Difficulty integration tests
// ────────────────────────────────────────────────────────────────

await test('routeWorkflow with taskDifficulty=hard never returns haiku as coder', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Fix a small UI bug.',
      {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      },
    );
    assert.ok(
      !decision.coder.toLowerCase().includes('haiku'),
      `Expected non-haiku coder for hard task, got ${decision.coder}`,
    );
  } finally {
    cleanup();
  }
});

await test('routeWorkflow with taskDifficulty=critical includes difficulty in reasoning', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Update the payment processing module.',
      {
        repoDir,
        taskDifficulty: 'critical',
        skipDifficultyClassification: true,
      },
    );
    const hasDifficultyReasoning = decision.reasoning.some(
      (r) => r.includes('critical'),
    );
    assert.ok(hasDifficultyReasoning, `Expected difficulty in reasoning, got: ${decision.reasoning.join(' | ')}`);
  } finally {
    cleanup();
  }
});

await test('routeWorkflow with taskDifficulty=trivial does not add floor restriction to reasoning', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Fix a typo.',
      {
        repoDir,
        taskDifficulty: 'trivial',
        skipDifficultyClassification: true,
      },
    );
    // Trivial difficulty should mention the floor in reasoning (floor applied = true for trivial)
    const hasTrivialReasoning = decision.reasoning.some((r) => r.includes('trivial'));
    assert.ok(hasTrivialReasoning, `Expected trivial in reasoning: ${decision.reasoning.join(' | ')}`);
    // Trivial difficulty floor allows haiku — no upgrade warnings, coder can be any model
    assert.equal(decision.signals.taskDifficulty, 'trivial');
  } finally {
    cleanup();
  }
});

await test('routeWorkflow with taskDifficulty=hard includes taskDifficulty in signals', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Refactor the database layer.',
      {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      },
    );
    assert.equal(decision.signals.taskDifficulty, 'hard');
  } finally {
    cleanup();
  }
});

await test('summarizeWorkflowRoute includes difficulty when present in signals', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Update critical payment service.',
      {
        repoDir,
        taskDifficulty: 'critical',
        skipDifficultyClassification: true,
      },
    );
    const summary = summarizeWorkflowRoute(decision, repoDir);
    assert.match(summary, /difficulty=critical/);
  } finally {
    cleanup();
  }
});

await test('applyDifficultyFloor upgrades haiku to opus for critical difficulty (not sonnet)', () => {
  const pool = ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];
  const criticalFloor = { allowHaiku: false, preferSonnet: false, preferOpus: true };
  const result = applyDifficultyFloor('claude-haiku-4-5-20251001', criticalFloor, pool, 'coder');
  assert.ok(
    result.toLowerCase().includes('opus'),
    `Expected opus upgrade for critical+haiku, got ${result}`,
  );
  assert.ok(
    !result.toLowerCase().includes('sonnet'),
    `Critical floor should prefer opus over sonnet, got ${result}`,
  );
});

await test('routeWorkflow without difficulty options has no taskDifficulty in signals', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Simple feature implementation.',
      {
        repoDir,
        skipDifficultyClassification: true,
      },
    );
    assert.equal(decision.signals.taskDifficulty, undefined);
  } finally {
    cleanup();
  }
});

await test('enforces budget and downgrades when possible', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    // Note: $1.00 budget may or may not require downgrade depending on default model costs.
    // This test verifies budget enforcement works correctly in both cases.
    const decision = routeWorkflow(
      'Implement a new feature',
      { repoDir, maxCostUsd: 1.00 }
    );

    // Final cost after routing (reflects any successful downgrade)
    const totalCost = decision.expectedCostPlan +
                     decision.expectedCostCode +
                     decision.expectedCostReview;

    // Budget enforcement should result in: downgrade succeeded OR violation reported
    if (decision.budgetViolation) {
      // Downgrade failed - verify violation is properly reported
      assert.ok(decision.budgetViolation.attemptedDowngrade);
      assert.ok(decision.budgetViolation.requestedCost > 1.00);
      assert.ok(decision.reasoning.some(r => r.includes('BUDGET VIOLATION')));
    } else {
      // Downgrade succeeded or not needed - verify cost is within budget
      assert.ok(totalCost <= 1.00, `Total cost ${totalCost} should be under $1.00`);
      if (decision.reasoning.some(r => r.includes('downgrade'))) {
        // If downgrade happened, it must have brought cost within budget
        assert.ok(totalCost <= 1.00, 'Downgrade should result in cost within budget');
      }
    }
  } finally {
    cleanup();
  }
});

await test('reports budget violation when impossible', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Complex infrastructure update requiring deep planning',
      { repoDir, maxCostUsd: 0.001 } // Impossibly tight - even cheaper than cheapest option
    );

    assert.ok(decision.budgetViolation, 'Should have budget violation');
    assert.equal(decision.budgetViolation.attemptedDowngrade, true);
    assert.ok(decision.budgetViolation.requestedCost > 0.001);
    assert.ok(decision.reasoning.some(r => r.includes('BUDGET VIOLATION')));
  } finally {
    cleanup();
  }
});

await test('uses survival mode budget when in survival', () => {
  const { repoDir, cleanup } = makeRepo({
    router: baseConfig().router,
    eval: baseConfig().eval,
    budget: {
      normalMode: 25,
      constrainedMode: 15,
      survivalMode: 5,
    }
  });

  // Write quota state showing survival mode
  writeQuotaState(repoDir, {
    'claude-opus-4-7': 'exhausted',
    'claude-opus-4-6': 'exhausted',
  });

  try {
    const decision = routeWorkflow('Implement a feature', { repoDir });

    // Should use $5 survival budget, not $25 normal
    const totalCost = decision.expectedCostPlan +
                     decision.expectedCostCode +
                     decision.expectedCostReview;

    assert.ok(totalCost <= 5 || decision.budgetViolation);
    if (decision.budgetViolation) {
      assert.equal(decision.budgetViolation.operatingMode, 'survival');
      assert.equal(decision.budgetViolation.maxCostUsd, 5);
    }
  } finally {
    cleanup();
  }
});

await test('includes budget rule in reasoning when triggered', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = routeWorkflow(
      'Complex infrastructure update',
      { repoDir, maxCostUsd: 0.20 } // Tight enough to trigger downgrade
    );

    // Should have budget reasoning since we're constraining the cost
    const hasBudgetReasoning = decision.reasoning.some(r =>
      r.includes('budget') || r.includes('downgrade')
    );

    assert.ok(hasBudgetReasoning, 'Should mention budget in reasoning');
  } finally {
    cleanup();
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
