import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyTendLoopError,
  runTendLoop,
  tendLoopBackoffMs,
  writeTendHeartbeat,
  type TendLoopDeps,
} from './tend-loop.ts';
import type { StatusRenderer } from './tend-status-renderer.ts';
import type { TendDecision } from './tend-controller.ts';

function renderer(): StatusRenderer & { lines: string[]; finalized: boolean } {
  return {
    lines: [],
    finalized: false,
    write(line: string) { this.lines.push(line); },
    finalize() { this.finalized = true; },
  };
}

function idleDecision(): TendDecision {
  return { integrationHealth: { state: 'healthy' }, eligible: [], blocked: [], nextPR: null };
}

function deps(overrides: Partial<TendLoopDeps> = {}): Partial<TendLoopDeps> & { sleeps: number[]; heartbeats: unknown[] } {
  const sleeps: number[] = [];
  const heartbeats: unknown[] = [];
  return {
    sleeps,
    heartbeats,
    selectNextCandidate: async () => idleDecision(),
    executeMerge: async () => ({ status: 'merged', prNumber: 1, haltLoop: false }),
    writeHeartbeat: async (_repoDir, health) => { heartbeats.push(health); },
    sleep: async (ms) => {
      sleeps.push(ms);
      if (ms === 60_000) {
        throw new TypeError('stop');
      }
    },
    now: () => new Date('2026-08-18T12:00:00Z'),
    log: () => undefined,
    random: () => 0.5,
    ...overrides,
  };
}

describe('classifyTendLoopError', () => {
  it('distinguishes transient, terminal, and unknown errors', () => {
    assert.equal(classifyTendLoopError(new Error('HTTP 503 Service Unavailable')), 'transient');
    assert.equal(classifyTendLoopError(new Error('tend: integration branch not configured')), 'terminal');
    assert.equal(classifyTendLoopError(new TypeError('bad shape')), 'terminal');
    assert.equal(classifyTendLoopError(new Error('tend: gh pr list returned non-array JSON')), 'unknown');
  });
});

describe('tendLoopBackoffMs', () => {
  it('caps below the watchdog stale threshold', () => {
    assert.deepEqual(
      [1, 2, 3, 4].map((attempt) => tendLoopBackoffMs(attempt, { random: () => 0.5 })),
      [30_000, 60_000, 120_000, 120_000],
    );
  });
});

describe('runTendLoop', () => {
  it('continues after a transient selection error and clears failure heartbeat on success', async () => {
    const r = renderer();
    let calls = 0;
    const d = deps({
      selectNextCandidate: async () => {
        calls += 1;
        if (calls === 1) throw new Error('HTTP 503 Service Unavailable');
        return idleDecision();
      },
    });

    await assert.rejects(
      runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d }),
      TypeError,
    );

    assert.deepEqual(d.sleeps, [30_000, 60_000]);
    assert.equal(r.lines.some((line) => line.includes('error=transient')), true);
    assert.equal((d.heartbeats[1] as { failureCount: number }).failureCount, 1);
    assert.equal((d.heartbeats.at(-1) as { failureCount: number }).failureCount, 0);
  });

  it('rejects terminal errors immediately', async () => {
    const d = deps({
      selectNextCandidate: async () => {
        throw new TypeError('bad code');
      },
    });

    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: renderer(), deps: d }), TypeError);
    assert.deepEqual(d.sleeps, []);
  });

  it('exits after the unknown error budget is exhausted', async () => {
    const sleeps: number[] = [];
    const d = deps({
      selectNextCandidate: async () => {
        throw new Error('tend: gh pr list returned non-array JSON');
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await assert.rejects(
      runTendLoop({ repoDir: '/tmp/repo', renderer: renderer(), deps: d, maxConsecutiveUnknownFailures: 3 }),
      /non-array JSON/,
    );
    assert.deepEqual(sleeps, [30_000, 60_000]);
  });

  it('returns halted when executeMerge asks the loop to stop', async () => {
    const r = renderer();
    const d = deps({
      selectNextCandidate: async () => ({
        integrationHealth: { state: 'healthy' },
        eligible: [{ number: 42, title: 'PR', headBranch: 'task/pr', createdAt: '2026-08-18T00:00:00Z', dependencyDepth: 0 }],
        blocked: [],
        nextPR: 42,
      }),
      executeMerge: async () => ({ status: 'halted', prNumber: 42, haltLoop: true }),
    });

    const result = await runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d });
    assert.equal(result.reason, 'halted');
    assert.equal(r.finalized, true);
  });
});

describe('writeTendHeartbeat', () => {
  it('merges diagnostics into existing tend service state and clears them on success', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-loop-'));
    try {
      mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
      await writeTendHeartbeat(repoDir, '2026-08-18T12:00:00Z', {
        failureCount: 2,
        lastError: 'transient: HTTP 503',
        lastErrorAt: '2026-08-18T12:00:00Z',
      });
      await writeTendHeartbeat(repoDir, '2026-08-18T12:01:00Z', {
        failureCount: 0,
        lastError: null,
        lastErrorAt: null,
      });
      const parsed = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf-8'));
      assert.equal(parsed.services.tend.status, 'healthy');
      assert.equal(parsed.services.tend.failureCount, 0);
      assert.equal(parsed.services.tend.lastError, null);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
