import assert from 'node:assert/strict';
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

function makeOutput(overrides: Partial<HokusaiOutput> = {}): HokusaiOutput {
  return {
    route: {
      plan_depth: 'medium',
      code_depth: 'medium',
      review_mode: 'standard',
      ...overrides.route,
    },
    predictions: {
      success_probability: 0.82,
      confidence: 0.74,
      estimated_tokens: 900_000,
      ...overrides.predictions,
    },
  };
}

console.log('\n--- hokusai-adapter Tests ---\n');

test('maps plan_depth low -> light', () => {
  const decision = fromHokusaiOutput(makeOutput({ route: { plan_depth: 'low', code_depth: 'medium', review_mode: 'standard' } }));
  assert.equal(decision.planDepth, 'light');
});

test('maps plan_depth medium -> medium', () => {
  const decision = fromHokusaiOutput(makeOutput({ route: { plan_depth: 'medium', code_depth: 'medium', review_mode: 'standard' } }));
  assert.equal(decision.planDepth, 'medium');
});

test('maps plan_depth high -> deep', () => {
  const decision = fromHokusaiOutput(makeOutput({ route: { plan_depth: 'high', code_depth: 'medium', review_mode: 'standard' } }));
  assert.equal(decision.planDepth, 'deep');
});

test('maps code_depth low/medium/high to light/medium/deep', () => {
  const low = fromHokusaiOutput(makeOutput({ route: { plan_depth: 'medium', code_depth: 'low', review_mode: 'standard' } }));
  const medium = fromHokusaiOutput(makeOutput({ route: { plan_depth: 'medium', code_depth: 'medium', review_mode: 'standard' } }));
  const high = fromHokusaiOutput(makeOutput({ route: { plan_depth: 'medium', code_depth: 'high', review_mode: 'standard' } }));
  assert.equal(low.codeDepth, 'light');
  assert.equal(medium.codeDepth, 'medium');
  assert.equal(high.codeDepth, 'deep');
});

test('maps review_mode light/standard/deep to static/llm/static+llm', () => {
  const light = fromHokusaiOutput(makeOutput({ route: { plan_depth: 'medium', code_depth: 'medium', review_mode: 'light' } }));
  const standard = fromHokusaiOutput(makeOutput({ route: { plan_depth: 'medium', code_depth: 'medium', review_mode: 'standard' } }));
  const deep = fromHokusaiOutput(makeOutput({ route: { plan_depth: 'medium', code_depth: 'medium', review_mode: 'deep' } }));
  assert.equal(light.reviewRecommended, 'static');
  assert.equal(standard.reviewRecommended, 'llm');
  assert.equal(deep.reviewRecommended, 'static+llm');
});

test('passes through success probability and confidence', () => {
  const decision = fromHokusaiOutput(makeOutput({
    predictions: { success_probability: 0.91, confidence: 0.66, estimated_tokens: 400_000 },
  }));

  assert.equal(decision.expectedSuccess, 0.91);
  assert.equal(decision.confidence, 0.66);
});

test('clamps out-of-range probability values', () => {
  const high = fromHokusaiOutput(makeOutput({
    predictions: { success_probability: 1.5, confidence: 2, estimated_tokens: 10_000 },
  }));
  const low = fromHokusaiOutput(makeOutput({
    predictions: { success_probability: -1, confidence: -0.5, estimated_tokens: 10_000 },
  }));

  assert.equal(high.expectedSuccess, 1);
  assert.equal(high.confidence, 1);
  assert.equal(low.expectedSuccess, 0);
  assert.equal(low.confidence, 0);
});

test('estimates stage costs from estimated tokens', () => {
  const decision = fromHokusaiOutput(makeOutput({
    route: { plan_depth: 'medium', code_depth: 'high', review_mode: 'deep' },
    predictions: { success_probability: 0.8, confidence: 0.7, estimated_tokens: 1_200_000 },
  }));

  assert.ok(decision.expectedCostPlan >= 0);
  assert.ok(decision.expectedCostCode >= 0);
  assert.ok(decision.expectedCostReview >= 0);
  assert.ok(decision.expectedCostCode > decision.expectedCostPlan);
  assert.ok(decision.expectedCostReview > 0);
});

test('handles non-finite or negative estimated_tokens safely', () => {
  const negative = fromHokusaiOutput(makeOutput({
    predictions: { success_probability: 0.8, confidence: 0.7, estimated_tokens: -10 },
  }));
  const notFinite = fromHokusaiOutput(makeOutput({
    predictions: { success_probability: 0.8, confidence: 0.7, estimated_tokens: Number.NaN },
  }));

  assert.equal(negative.expectedCostPlan, 0);
  assert.equal(negative.expectedCostCode, 0);
  assert.equal(negative.expectedCostReview, 0);
  assert.equal(notFinite.expectedCostPlan, 0);
  assert.equal(notFinite.expectedCostCode, 0);
  assert.equal(notFinite.expectedCostReview, 0);
});

test('builds complete WorkflowRouteDecision shape', () => {
  const decision = fromHokusaiOutput(makeOutput());

  assert.equal(decision.planner, 'hokusai-routed');
  assert.equal(decision.coder, 'hokusai-routed');
  assert.equal(decision.reviewer, 'hokusai-routed');
  assert.equal(decision.signals.taskType, 'unknown');
  assert.ok(decision.reasoning.length >= 2);
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
