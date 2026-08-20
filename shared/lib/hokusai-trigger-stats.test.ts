import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { recordTriggerOutcome, readTriggerStats, summarizeTriggerStats } from './hokusai-trigger-stats.ts';

describe('hokusai-trigger-stats', () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join('/tmp', 'hokusai-test-'));
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records enqueued outcome', async () => {
    const result = { status: 'enqueued' as const, entryId: 'test-id', drainStarted: true };
    await recordTriggerOutcome(result, { repoDir: tempDir });

    const stats = readTriggerStats({ repoDir: tempDir });
    assert(stats, 'stats should exist');
    assert.equal(stats.counts.enqueued, 1, 'enqueued count should be 1');
    assert.ok(stats.lastAt.enqueued, 'lastAt.enqueued should be set');
  });

  it('records disabled outcome with reason and blockers', async () => {
    const result = {
      status: 'disabled' as const,
      reason: 'test reason',
      blockers: [
        {
          store: 'user-config' as const,
          path: '/test/config.json',
          setting: 'hokusai.enabled',
          value: 'false',
          remedy: 'run wavemill hokusai enable',
        },
      ],
    };
    await recordTriggerOutcome(result, { repoDir: tempDir });

    const stats = readTriggerStats({ repoDir: tempDir });
    assert(stats, 'stats should exist');
    assert.equal(stats.counts.disabled, 1);
    assert.ok(stats.lastDisabled);
    assert.equal(stats.lastDisabled.reason, 'test reason');
  });

  it('records not_eligible outcome with reasons', async () => {
    const result = { status: 'not_eligible' as const, reasons: ['missing_routing', 'missing_cost'] };
    await recordTriggerOutcome(result, { repoDir: tempDir });

    const stats = readTriggerStats({ repoDir: tempDir });
    assert(stats, 'stats should exist');
    assert.equal(stats.counts.not_eligible, 1);
    assert.ok(stats.lastNotEligible);
    assert.deepEqual(stats.lastNotEligible.reasons, ['missing_routing', 'missing_cost']);
  });

  it('accumulates counts across multiple outcomes', async () => {
    const tempDir2 = mkdtempSync(join('/tmp', 'hokusai-test-'));
    try {
      await recordTriggerOutcome({ status: 'enqueued', drainStarted: false }, { repoDir: tempDir2 });
      await recordTriggerOutcome({ status: 'enqueued', drainStarted: false }, { repoDir: tempDir2 });
      await recordTriggerOutcome({ status: 'duplicate', drainStarted: false }, { repoDir: tempDir2 });

      const stats = readTriggerStats({ repoDir: tempDir2 });
      assert(stats);
      assert.equal(stats.counts.enqueued, 2);
      assert.equal(stats.counts.duplicate, 1);
    } finally {
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });

  it('returns null for non-existent stats file', () => {
    const tempDir2 = mkdtempSync(join('/tmp', 'hokusai-test-'));
    try {
      const stats = readTriggerStats({ repoDir: tempDir2 });
      assert.equal(stats, null);
    } finally {
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });

  it('summarizes stats with warning when disabled is latest', async () => {
    const tempDir2 = mkdtempSync(join('/tmp', 'hokusai-test-'));
    try {
      await recordTriggerOutcome({ status: 'enqueued', drainStarted: false }, { repoDir: tempDir2 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await recordTriggerOutcome(
        { status: 'disabled', reason: 'test' },
        { repoDir: tempDir2, now: new Date() },
      );

      const stats = readTriggerStats({ repoDir: tempDir2 });
      assert(stats);
      const summary = summarizeTriggerStats(stats);

      assert(summary.lines.length > 0);
      assert(summary.warnings.some((w) => w.includes('disabled')));
    } finally {
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });

  it('handles corrupt stats gracefully', () => {
    const stats = readTriggerStats({ repoDir: '/non/existent/path' });
    assert.equal(stats, null);
  });
});
