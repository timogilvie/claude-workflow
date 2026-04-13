import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fromHokusaiOutput } from './hokusai-adapter.ts';
import type { HokusaiOutput } from './hokusai-schema.ts';

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

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'hokusai-adapter-test-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    eval: {
      pricing: {
        planner: { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        coder: { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
        reviewer: { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
      },
    },
  }));

  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function makeOutput(overrides: Partial<HokusaiOutput> = {}): HokusaiOutput {
  return {
    schema_version: '1.0',
    route: {
      planner_model: 'planner',
      coder_model: 'coder',
      reviewer_model: 'reviewer',
      plan_depth: 'medium',
      code_depth: 'medium',
      review_mode: 'standard',
      ...overrides.route,
    },
    predictions: {
      expected_success_probability: 0.82,
      expected_cost_usd: 12.34,
      confidence: 0.67,
      ...overrides.predictions,
    },
    ...overrides,
  };
}

console.log('\n--- hokusai-adapter Tests ---\n');

test('maps depth and review enums into WorkflowRouteDecision values', () => {
  const low = fromHokusaiOutput(makeOutput({
    route: { planner_model: 'planner', coder_model: 'coder', reviewer_model: 'reviewer', plan_depth: 'low', code_depth: 'low', review_mode: 'light' },
  }));
  assert.equal(low.planDepth, 'light');
  assert.equal(low.codeDepth, 'light');
  assert.equal(low.reviewRecommended, 'static');

  const medium = fromHokusaiOutput(makeOutput({
    route: { planner_model: 'planner', coder_model: 'coder', reviewer_model: 'reviewer', plan_depth: 'medium', code_depth: 'medium', review_mode: 'standard' },
  }));
  assert.equal(medium.planDepth, 'medium');
  assert.equal(medium.codeDepth, 'medium');
  assert.equal(medium.reviewRecommended, 'llm');

  const high = fromHokusaiOutput(makeOutput({
    route: { planner_model: 'planner', coder_model: 'coder', reviewer_model: 'reviewer', plan_depth: 'high', code_depth: 'high', review_mode: 'deep' },
  }));
  assert.equal(high.planDepth, 'deep');
  assert.equal(high.codeDepth, 'deep');
  assert.equal(high.reviewRecommended, 'static+llm');
});

test('passes models through and maps predictions to expectedSuccess and confidence', () => {
  const decision = fromHokusaiOutput(makeOutput({
    route: {
      planner_model: 'claude-sonnet-4-5-20250929',
      coder_model: 'gpt-5.3-codex',
      reviewer_model: 'claude-haiku-4-5-20251001',
      plan_depth: 'medium',
      code_depth: 'medium',
      review_mode: 'standard',
    },
    predictions: {
      expected_success_probability: 0.91,
      expected_cost_usd: 9.5,
      confidence: 0.42,
    },
  }));

  assert.equal(decision.planner, 'claude-sonnet-4-5-20250929');
  assert.equal(decision.coder, 'gpt-5.3-codex');
  assert.equal(decision.reviewer, 'claude-haiku-4-5-20251001');
  assert.equal(decision.expectedSuccess, 0.91);
  assert.equal(decision.confidence, 0.42);
});

test('apportions expected_cost_usd across stages using heuristic cost weights', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = fromHokusaiOutput(makeOutput(), { repoDir });
    assert.equal(Number((decision.expectedCostPlan + decision.expectedCostCode + decision.expectedCostReview).toFixed(2)), 12.34);
    assert.ok(decision.expectedCostCode > decision.expectedCostPlan);
    assert.ok(decision.expectedCostCode > decision.expectedCostReview);
    assert.ok(decision.expectedCostPlan > 0);
    assert.ok(decision.expectedCostReview > 0);
  } finally {
    cleanup();
  }
});

test('falls back to heuristic costs when expected_cost_usd is invalid', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = fromHokusaiOutput(makeOutput({
      predictions: {
        expected_success_probability: 0.82,
        expected_cost_usd: Number.NaN,
        confidence: 0.67,
      },
    }), { repoDir });
    assert.ok(decision.expectedCostPlan > 0);
    assert.ok(decision.expectedCostCode > 0);
    assert.ok(decision.expectedCostReview > 0);
  } finally {
    cleanup();
  }
});

test('clamps probability fields and applies default signals', () => {
  const decision = fromHokusaiOutput(makeOutput({
    predictions: {
      expected_success_probability: 2,
      expected_cost_usd: 0,
      confidence: -1,
    },
  }));

  assert.equal(decision.expectedSuccess, 1);
  assert.equal(decision.confidence, 0);
  assert.deepEqual(decision.signals, {
    taskType: 'feature',
    promptLength: 'medium',
    complexityScore: 0,
    fileTypes: [],
    riskScore: 0,
  });
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
