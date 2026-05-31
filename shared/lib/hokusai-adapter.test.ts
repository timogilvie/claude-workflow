import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fromHokusaiModel30Response } from './hokusai-adapter.ts';
import type { HokusaiModel30Response } from './hokusai-schema.ts';

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

function makeResponse(overrides: Partial<HokusaiModel30Response> = {}): HokusaiModel30Response {
  return {
    predictions: {
      recommended_strategy: {
        planner_model: 'planner',
        coder_model: 'coder',
        reviewer_model: 'reviewer',
        stages: ['plan', 'code', 'review'],
        estimated_success_under_budget: 0.82,
        estimated_cost_usd: 12.34,
        estimated_duration_seconds: 600,
        confidence: 0.67,
      },
      ...overrides.predictions,
    },
    metadata: {
      request_id: 'req-1',
      inference_log_id: 'log-1',
      ...overrides.metadata,
    },
  };
}

console.log('\n--- hokusai-adapter Tests ---\n');

test('maps model 30 strategy fields into WorkflowRouteDecision values', () => {
  const decision = fromHokusaiModel30Response(makeResponse({
    predictions: {
      recommended_strategy: {
        planner_model: 'claude-sonnet-4-5-20250929',
        coder_model: 'gpt-5.3-codex',
        reviewer_model: 'claude-haiku-4-5-20251001',
        plan_depth: 'high',
        code_depth: 'low',
        review_mode: 'deep',
        estimated_success_under_budget: 0.91,
        estimated_cost_usd: 9.5,
        confidence: 0.42,
      },
    },
  }));

  assert.equal(decision.planner, 'claude-sonnet-4-5-20250929');
  assert.equal(decision.coder, 'gpt-5.3-codex');
  assert.equal(decision.reviewer, 'claude-haiku-4-5-20251001');
  assert.equal(decision.planDepth, 'deep');
  assert.equal(decision.codeDepth, 'light');
  assert.equal(decision.reviewRecommended, 'static+llm');
  assert.equal(decision.expectedSuccess, 0.91);
  assert.equal(decision.confidence, 0.42);
});

test('apportions estimated_cost_usd across stages using heuristic cost weights', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = fromHokusaiModel30Response(makeResponse(), { repoDir });
    assert.equal(Number((decision.expectedCostPlan + decision.expectedCostCode + decision.expectedCostReview).toFixed(2)), 12.34);
    assert.ok(decision.expectedCostCode > decision.expectedCostPlan);
    assert.ok(decision.expectedCostCode > decision.expectedCostReview);
  } finally {
    cleanup();
  }
});

test('falls back to heuristic costs when estimated_cost_usd is invalid', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const decision = fromHokusaiModel30Response(makeResponse({
      predictions: {
        recommended_strategy: {
          planner_model: 'planner',
          coder_model: 'coder',
          reviewer_model: 'reviewer',
          estimated_cost_usd: Number.NaN,
        },
      },
    }), { repoDir });
    assert.ok(decision.expectedCostPlan > 0);
    assert.ok(decision.expectedCostCode > 0);
    assert.ok(decision.expectedCostReview > 0);
  } finally {
    cleanup();
  }
});

test('clamps probability fields and preserves provenance metadata', () => {
  const decision = fromHokusaiModel30Response(makeResponse({
    predictions: {
      recommended_strategy: {
        planner_model: 'planner',
        coder_model: 'coder',
        reviewer_model: 'reviewer',
        estimated_success_under_budget: 2,
        estimated_cost_usd: 0,
        estimated_duration_seconds: 123,
        confidence: -1,
      },
      alternatives: [{ planner_model: 'alt' }],
      tradeoffs: [{ kind: 'speed' }],
      nearest_neighbors: [{ id: 'n1' }],
    },
  }));

  assert.equal(decision.expectedSuccess, 1);
  assert.equal(decision.confidence, 0);
  assert.equal(decision.provenance?.requestId, 'req-1');
  assert.equal(decision.provenance?.inferenceLogId, 'log-1');
  assert.equal(decision.provenance?.estimatedDurationSeconds, 123);
  assert.deepEqual(decision.provenance?.alternatives, [{ planner_model: 'alt' }]);
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
