import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TendFatalError } from './tend-errors.ts';
import {
  classifyTendLoopError,
  runTendLoop,
  writeTendHeartbeatBestEffort,
  type TendLoopDeps,
} from './tend-loop.ts';
import type { MergeExecutionResult, TendCandidate, TendDecision } from './tend-controller.ts';

function decision(nextPR: number | null = null): TendDecision {
  const candidate: TendCandidate = {
    number: 42,
    title: 'PR',
    headBranch: 'task/pr',
    createdAt: '2026-01-01T00:00:00Z',
    dependencyDepth: 0,
  };
  return {
    integrationHealth: { state: 'healthy' },
    eligible: nextPR === null ? [] : [candidate],
    blocked: [],
    nextPR,
  };
}

function harness(overrides: Partial<TendLoopDeps> = {}) {
  const lines: string[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const heartbeats: string[] = [];
  const deps: TendLoopDeps = {
    selectNextCandidate: async () => decision(),
    executeMerge: async (candidate) => ({
      status: 'merged',
      prNumber: candidate.number,
      haltLoop: false,
    }),
    writeHeartbeat: async (repoDir) => { heartbeats.push(repoDir); },
    sleep: async (ms) => { sleeps.push(ms); },
    renderer: {
      write: (line) => { lines.push(line); },
      finalize: () => { lines.push('FINALIZE'); },
    },
    log: (line) => { logs.push(line); },
    random: () => 1,
    intervalMs: 1,
    ...overrides,
  };
  return { deps, lines, logs, sleeps, heartbeats };
}

describe('tend-loop', () => {
  it('survives transient select failures and backs off', async () => {
    let attempts = 0;
    const h = harness({
      selectNextCandidate: async () => {
        attempts += 1;
        if (attempts <= 2) {
          throw new Error('HTTP 503: No server is currently available');
        }
        return decision(42);
      },
      executeMerge: async (): Promise<MergeExecutionResult> => ({
        status: 'halted',
        prNumber: 42,
        haltLoop: true,
      }),
    });

    const exit = await runTendLoop('/repo', h.deps);

    assert.deepEqual(exit, { reason: 'halted', prNumber: 42 });
    assert.deepEqual(h.sleeps, [30_000, 60_000]);
    assert.equal(h.heartbeats.length, 3);
    assert.match(h.logs[0], /transient error \(1 consecutive\)/);
    assert.match(h.logs[1], /transient error \(2 consecutive\)/);
    assert.ok(h.lines.some((line) => /action=retry-1/.test(line)));
    assert.ok(h.lines.some((line) => /action=retry-2/.test(line)));
  });

  it('retries unexpected errors', async () => {
    let attempts = 0;
    const h = harness({
      selectNextCandidate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('boom');
        return decision(42);
      },
      executeMerge: async () => ({ status: 'halted', prNumber: 42, haltLoop: true }),
    });

    await runTendLoop('/repo', h.deps);

    assert.deepEqual(h.sleeps, [30_000]);
    assert.match(h.logs[0], /unexpected error/);
  });

  it('exits on fatal and auth errors without backoff', async () => {
    for (const error of [
      new TypeError('bad type'),
      new TendFatalError('bad invariant'),
      Object.assign(new Error('Command failed'), { stderr: 'HTTP 401: Bad credentials' }),
    ]) {
      const h = harness({
        selectNextCandidate: async () => decision(42),
        executeMerge: async () => { throw error; },
      });

      const exit = await runTendLoop('/repo', h.deps);
      assert.equal(exit.reason, 'fatal');
      assert.deepEqual(h.sleeps, []);
      assert.equal(h.lines.at(-1), 'FINALIZE');
    }
  });

  it('classifies 404 as unexpected, not fatal', () => {
    assert.equal(classifyTendLoopError(new Error('HTTP 404: Not Found')), 'unexpected');
  });

  it('caps backoff and resets after a successful iteration', async () => {
    let attempt = 0;
    const h = harness({
      errorBackoffBaseMs: 10,
      errorBackoffMaxMs: 25,
      selectNextCandidate: async () => {
        attempt += 1;
        if ([1, 2, 3, 5].includes(attempt)) throw new Error('HTTP 503');
        return attempt === 4 ? decision() : decision(42);
      },
      executeMerge: async () => ({ status: 'halted', prNumber: 42, haltLoop: true }),
    });

    await runTendLoop('/repo', h.deps);

    assert.deepEqual(h.sleeps, [10, 20, 25, 1, 10]);
  });

  it('heartbeat best-effort writer creates and resets health state', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-heartbeat-'));
    try {
      await writeTendHeartbeatBestEffort(repoDir);
      const health = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf-8'));
      assert.equal(health.status, 'healthy');
      assert.equal(health.restartAttemptCount, 0);
      assert.equal(health.services.tend.status, 'healthy');
      assert.equal(health.services.tend.restartAttemptCount, 0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('classifies loop errors', () => {
    assert.equal(classifyTendLoopError(new TendFatalError('fatal')), 'fatal');
    assert.equal(classifyTendLoopError(new TypeError('type')), 'fatal');
    assert.equal(classifyTendLoopError(new Error('HTTP 503')), 'transient');
    assert.equal(classifyTendLoopError(new Error('plain')), 'unexpected');
  });
});
