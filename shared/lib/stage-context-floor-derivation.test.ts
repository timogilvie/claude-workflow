import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  INCIDENT_SEED_OBSERVATIONS,
  PROVISIONAL_CONTEXT_FLOOR_TOKENS,
  computeStageContextFloorRecommendations,
  percentile,
  readObservationFile,
  roundUpTo1024,
  scanNativeSessionTranscripts,
} from './stage-context-floor-derivation.ts';

describe('stage-context-floor-derivation', () => {
  it('rounds up to the next 1024-token boundary', () => {
    assert.equal(roundUpTo1024(131_182 * 1.10), 144_384);
    assert.equal(roundUpTo1024(1024), 1024);
    assert.equal(roundUpTo1024(1025), 2048);
  });

  it('interpolates percentiles instead of collapsing the tail onto the max', () => {
    assert.equal(percentile([10, 30, 20, 40], 0.50), 25);
    assert.equal(percentile([10, 30, 20, 40], 0.95), 38.5);
    // The nearest-rank form returned the max for any p >= 1 - 1/n, which made
    // p95 meaningless on the small samples this module actually sees.
    assert.notEqual(percentile([10, 30, 20, 40], 0.95), 40);
  });

  it('keeps thin stages provisional and derives sampled stages from p95', () => {
    const recommendations = computeStageContextFloorRecommendations([
      { stage: 'expansion', peakRequestTokens: 10_000, source: 'a' },
      { stage: 'expansion', peakRequestTokens: 20_000, source: 'b' },
      { stage: 'expansion', peakRequestTokens: 62_295, source: 'c' },
      ...INCIDENT_SEED_OBSERVATIONS,
    ]);

    const expansion = recommendations.find((item) => item.stage === 'expansion');
    assert.ok(expansion);
    assert.equal(expansion.provisional, false);
    assert.equal(expansion.recommendedFloor, 58_368);

    // The only coding sample is the kimi-k2 incident seed, whose prompt filled
    // that model's own window. It is an overflow incident, not a workload
    // measurement, so it is discarded and the stage stays provisional.
    const coding = recommendations.find((item) => item.stage === 'coding');
    assert.ok(coding);
    assert.equal(coding.provisional, true);
    assert.equal(coding.samples, 0);
    assert.equal(coding.discardedOverflowSamples, 1);
    assert.equal(coding.recommendedFloor, PROVISIONAL_CONTEXT_FLOOR_TOKENS);
  });

  it('excludes prompts that filled the running model\'s own context window', () => {
    const recommendations = computeStageContextFloorRecommendations([
      // Comfortably inside a 200k window.
      { stage: 'coding', peakRequestTokens: 100_000, source: 'a', contextWindowTokens: 200_000 },
      { stage: 'coding', peakRequestTokens: 120_000, source: 'b', contextWindowTokens: 200_000 },
      { stage: 'coding', peakRequestTokens: 140_000, source: 'c', contextWindowTokens: 200_000 },
      // Overflow: 130k against a 131k window. Counting it would ratchet the
      // floor above the models that handled the samples above.
      { stage: 'coding', peakRequestTokens: 130_000, source: 'd', contextWindowTokens: 131_072 },
    ]);

    const coding = recommendations.find((item) => item.stage === 'coding');
    assert.ok(coding);
    assert.equal(coding.samples, 3);
    assert.equal(coding.discardedOverflowSamples, 1);
    assert.equal(coding.max, 140_000);
    assert.equal(coding.provisional, false);
  });

  it('keeps observations with no known context window', () => {
    const recommendations = computeStageContextFloorRecommendations([
      { stage: 'coding', peakRequestTokens: 100_000, source: 'a' },
      { stage: 'coding', peakRequestTokens: 120_000, source: 'b' },
      { stage: 'coding', peakRequestTokens: 140_000, source: 'c' },
    ]);

    const coding = recommendations.find((item) => item.stage === 'coding');
    assert.ok(coding);
    assert.equal(coding.samples, 3);
    assert.equal(coding.discardedOverflowSamples, 0);
  });

  it('reads observations and skips invalid JSONL lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-observations-'));
    try {
      const path = join(dir, 'observations.jsonl');
      writeFileSync(path, [
        JSON.stringify({ stage: 'coding', peakRequestTokens: 123, source: 'ok' }),
        'not json',
        JSON.stringify({ stage: 'coding', peakRequestTokens: 0, source: 'skip' }),
      ].join('\n'), 'utf-8');
      assert.deepEqual(readObservationFile(path), [
        { stage: 'coding', peakRequestTokens: 123, source: 'ok' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans native transcripts and ignores turns without usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-transcripts-'));
    try {
      const sessions = join(dir, 'run-1', 'native-sessions');
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, 'expansion-run-1.jsonl'), [
        JSON.stringify({ type: 'assistant', usage: { input: 100, cacheRead: 7, cacheWrite: 3 } }),
        JSON.stringify({ type: 'assistant', content: 'no usage' }),
        JSON.stringify({ type: 'assistant', usage: { inputTokens: 80, cacheReadTokens: 5, cacheCreationTokens: 1 } }),
      ].join('\n'), 'utf-8');

      const observations = scanNativeSessionTranscripts(dir);
      assert.equal(observations.length, 1);
      assert.equal(observations[0]?.stage, 'expansion');
      assert.equal(observations[0]?.peakRequestTokens, 110);
      assert.equal(observations[0]?.turns, 2);
      assert.equal(observations[0]?.totalInputTokens, 180);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
