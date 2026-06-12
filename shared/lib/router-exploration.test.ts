/**
 * Tests for router exploration sampling primitives.
 */

import assert from 'node:assert/strict';
import {
  blendWithPrior,
  formatExplorationReasoning,
  resolveExplorationConfig,
  sampleCandidateIndex,
  ucbBonus,
} from './router-exploration.ts';

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

function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

console.log('\n--- router-exploration Tests ---\n');

test('resolveExplorationConfig applies defaults and clamps values', () => {
  const defaults = resolveExplorationConfig();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.mode, 'epsilon');
  assert.equal(defaults.rate, 0.15);
  assert.equal(defaults.temperature, 0.7);
  assert.equal(defaults.topK, 3);
  assert.equal(defaults.ucbConstant, 0);
  assert.equal(defaults.priorsEnabled, false);
  assert.equal(defaults.priorBlendSamples, 10);

  const clamped = resolveExplorationConfig({
    enabled: true,
    mode: 'softmax',
    rate: 7,
    temperature: 100,
    topK: 1,
    ucbConstant: 5,
    priors: { enabled: true, blendSamples: 0 },
  });
  assert.equal(clamped.enabled, true);
  assert.equal(clamped.mode, 'softmax');
  assert.equal(clamped.rate, 1);
  assert.equal(clamped.temperature, 10);
  assert.equal(clamped.topK, 3);
  assert.equal(clamped.ucbConstant, 1);
  assert.equal(clamped.priorsEnabled, true);
  assert.equal(clamped.priorBlendSamples, 10);
});

test('ucbBonus decays with support and disables at zero constant', () => {
  assert.equal(ucbBonus(0, 100, 1), 0);
  const fresh = ucbBonus(0.3, 11, 1);
  const seasoned = ucbBonus(0.3, 11, 10);
  assert.ok(fresh > seasoned, 'low support should earn a larger bonus');
  assert.ok(seasoned > 0);
  // Zero support is treated as one trial, not infinity
  assert.equal(ucbBonus(0.3, 11, 0), fresh);
});

test('blendWithPrior interpolates from pure prior to pure empirical', () => {
  assert.equal(blendWithPrior(0.5, 0.99, 0, 10), 0.99);
  assert.equal(blendWithPrior(0.5, 0.99, 10, 10), 0.5);
  assert.equal(blendWithPrior(0.5, 0.99, 20, 10), 0.5);
  const half = blendWithPrior(0.5, 0.99, 5, 10);
  assert.ok(Math.abs(half - 0.745) < 1e-9, `expected 0.745, got ${half}`);
  // Result stays clamped to [0, 1]
  assert.equal(blendWithPrior(2, 2, 5, 10), 1);
});

test('sampleCandidateIndex returns argmax when disabled or trivial', () => {
  const enabled = resolveExplorationConfig({ enabled: true, rate: 1 });
  const disabled = resolveExplorationConfig({ enabled: false, rate: 1 });

  assert.deepEqual(sampleCandidateIndex([0.9, 0.8], disabled, () => 0), { index: 0, explored: false });
  assert.deepEqual(sampleCandidateIndex([0.9], enabled, () => 0), { index: 0, explored: false });
  assert.deepEqual(sampleCandidateIndex([], enabled, () => 0), { index: 0, explored: false });
});

test('epsilon mode explores at the configured rate within the top-K window', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'epsilon', rate: 0.5, topK: 3 });
  const scores = [0.9, 0.8, 0.7, 0.6];

  // First roll above rate -> exploit
  assert.deepEqual(sampleCandidateIndex(scores, config, sequenceRandom([0.6])), { index: 0, explored: false });

  // First roll below rate -> explore; second roll picks among non-argmax in window
  assert.deepEqual(sampleCandidateIndex(scores, config, sequenceRandom([0.4, 0])), { index: 1, explored: true });
  assert.deepEqual(sampleCandidateIndex(scores, config, sequenceRandom([0.4, 0.99])), { index: 2, explored: true });

  // Index never escapes the top-K window
  const maxPick = sampleCandidateIndex(scores, config, sequenceRandom([0, 0.999999]));
  assert.ok(maxPick.index <= 2);
});

test('epsilon mode with rate 0 never explores', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'epsilon', rate: 0 });
  for (const roll of [0, 0.5, 0.99]) {
    assert.deepEqual(sampleCandidateIndex([0.9, 0.5], config, () => roll), { index: 0, explored: false });
  }
});

test('softmax mode samples proportionally to exp(score / temperature)', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'softmax', temperature: 0.7, topK: 3 });

  // Threshold at the very start of the cumulative mass -> argmax
  assert.deepEqual(sampleCandidateIndex([0.9, 0.5], config, () => 0), { index: 0, explored: false });

  // Threshold near the end of the cumulative mass -> last candidate
  const tail = sampleCandidateIndex([0.9, 0.5], config, () => 0.9999);
  assert.deepEqual(tail, { index: 1, explored: true });

  // Near-zero temperature concentrates all mass on the argmax
  const sharp = resolveExplorationConfig({ enabled: true, mode: 'softmax', temperature: 0.01 });
  assert.deepEqual(sampleCandidateIndex([0.9, 0.85], sharp, () => 0.99), { index: 0, explored: false });
});

test('softmax mode respects the top-K window', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'softmax', temperature: 10, topK: 2 });
  for (const roll of [0, 0.3, 0.6, 0.9999]) {
    const pick = sampleCandidateIndex([0.9, 0.8, 0.7, 0.6], config, () => roll);
    assert.ok(pick.index <= 1, `expected index within top-2, got ${pick.index}`);
  }
});

test('formatExplorationReasoning describes sampled roles and cost-guard reverts', () => {
  const epsilon = resolveExplorationConfig({ enabled: true, mode: 'epsilon', rate: 0.2 });
  const sampledLine = formatExplorationReasoning(
    { mode: 'epsilon', explored: [{ role: 'coder', sampled: 'gpt-5.4', argmax: 'claude-fable-5' }] },
    epsilon,
  );
  assert.ok(sampledLine.includes('exploration(epsilon, rate=0.2)'));
  assert.ok(sampledLine.includes('coder=gpt-5.4 (argmax claude-fable-5)'));

  const reverted = formatExplorationReasoning(
    { mode: 'epsilon', explored: [], costGuardReverted: true },
    epsilon,
  );
  assert.ok(reverted.includes('reverted'));
  assert.ok(reverted.includes('maxCostUsd'));
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});
