import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyTendLoopError,
  formatLaneStallWarning,
  runTendLoop,
  tendLoopBackoffMs,
  writeTendFailureState,
  writeTendHeartbeat,
  type TendLoopDeps,
} from './tend-loop.ts';
import type { StatusRenderer } from './tend-status-renderer.ts';
import type { MergeExecutionResult, TendDecision } from './tend-controller.ts';

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
    writePollHeartbeat: async (_repoDir, health) => { heartbeats.push({ kind: 'success', ...health }); },
    writeFailureState: async (_repoDir, health) => { heartbeats.push({ kind: 'failure', ...health }); },
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
  it('does not write a heartbeat before selectNextCandidate succeeds', async () => {
    const d = deps({
      selectNextCandidate: async () => {
        throw new TypeError('stop before poll completion');
      },
    });

    await assert.rejects(
      runTendLoop({ repoDir: '/tmp/repo', renderer: renderer(), deps: d }),
      TypeError,
    );

    assert.equal(d.heartbeats.length, 1);
    assert.equal((d.heartbeats[0] as { kind: string }).kind, 'failure');
    assert.equal((d.heartbeats[0] as { status: string }).status, 'unhealthy');
    assert.equal((d.heartbeats[0] as { pollCompletedAt: string | null }).pollCompletedAt, null);
  });

  it('successful poll heartbeat includes iteration and poll timestamps', async () => {
    const r = renderer();
    const d = deps();

    await assert.rejects(
      runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d }),
      TypeError,
    );

    const heartbeat = d.heartbeats.find((entry) => (entry as { kind?: string }).kind === 'success') as {
      iteration: number;
      pollStartedAt: string;
      pollCompletedAt: string;
    };
    assert.equal(heartbeat.iteration, 1);
    assert.equal(heartbeat.pollStartedAt, '2026-08-18T12:00:00.000Z');
    assert.equal(heartbeat.pollCompletedAt, '2026-08-18T12:00:00.000Z');
    assert.match(r.lines[0], /^iter=1 poll_started=2026-08-18T12:00:00.000Z poll_completed=2026-08-18T12:00:00.000Z /);
  });

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
    assert.equal((d.heartbeats[0] as { kind: string }).kind, 'failure');
    assert.equal((d.heartbeats[0] as { failureCount: number }).failureCount, 1);
    const successHeartbeat = d.heartbeats.find((entry) => (entry as { kind?: string }).kind === 'success') as {
      failureCount: number;
    };
    assert.equal(successHeartbeat.failureCount, 0);
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

  it('warns about a stalled merge lane after 3 consecutive lane-held skips', async () => {
    const r = renderer();
    let polls = 0;
    const d = deps({
      selectNextCandidate: async () => candidateDecision(1245),
      executeMerge: async () => laneHeldSkip(1245, [1243]),
      sleep: async () => {
        polls += 1;
        if (polls >= 5) {
          throw new TypeError('stop');
        }
      },
    });

    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d }), TypeError);

    assert.deepEqual(
      r.lines.filter((line) => line.startsWith('warn=merge-lane-stalled')),
      [
        'warn=merge-lane-stalled holder=#1243 candidate=#1245 consecutive=3',
        'warn=merge-lane-stalled holder=#1243 candidate=#1245 consecutive=4',
        'warn=merge-lane-stalled holder=#1243 candidate=#1245 consecutive=5',
      ],
    );
    // The regular status line still appears every poll alongside the warning.
    assert.equal(r.lines.filter((line) => line.includes('action=skipped-#1245')).length, 5);
  });

  it('resets the lane-stall streak when a poll produces any other result', async () => {
    const r = renderer();
    const results: MergeExecutionResult[] = [
      laneHeldSkip(1245, [1243]),
      laneHeldSkip(1245, [1243]),
      { status: 'merged', prNumber: 1243, haltLoop: false },
      laneHeldSkip(1245, [1243]),
      laneHeldSkip(1245, [1243]),
    ];
    let polls = 0;
    const d = deps({
      selectNextCandidate: async () => candidateDecision(1245),
      executeMerge: async () => results[polls] ?? laneHeldSkip(1245, [1243]),
      sleep: async () => {
        polls += 1;
        if (polls >= results.length) {
          throw new TypeError('stop');
        }
      },
    });

    await assert.rejects(runTendLoop({ repoDir: '/tmp/repo', renderer: r, deps: d }), TypeError);

    assert.deepEqual(
      r.lines.filter((line) => line.startsWith('warn=merge-lane-stalled')),
      [],
      'a non-lane-held result between skips must reset the streak below the warning threshold',
    );
  });
});

function candidateDecision(prNumber: number): TendDecision {
  return {
    integrationHealth: { state: 'healthy' },
    eligible: [{
      number: prNumber,
      title: 'PR',
      headBranch: 'task/pr',
      createdAt: '2026-08-18T00:00:00Z',
      dependencyDepth: 0,
    }],
    blocked: [],
    nextPR: prNumber,
  };
}

function laneHeldSkip(prNumber: number, heldBy: number[]): MergeExecutionResult {
  return { status: 'skipped', prNumber, phase: 'merge-lane-held', heldBy, haltLoop: false };
}

describe('formatLaneStallWarning', () => {
  it('formats holder, candidate, and streak', () => {
    assert.equal(
      formatLaneStallWarning({ holders: [1243], candidate: 1245, consecutive: 5 }),
      'warn=merge-lane-stalled holder=#1243 candidate=#1245 consecutive=5',
    );
  });

  it('joins multiple holders and tolerates an unknown holder list', () => {
    assert.equal(
      formatLaneStallWarning({ holders: [7, 9], candidate: 42, consecutive: 3 }),
      'warn=merge-lane-stalled holder=#7,#9 candidate=#42 consecutive=3',
    );
    assert.equal(
      formatLaneStallWarning({ holders: [], candidate: 42, consecutive: 3 }),
      'warn=merge-lane-stalled holder=unknown candidate=#42 consecutive=3',
    );
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
        iteration: 7,
        pollStartedAt: '2026-08-18T11:59:59Z',
        pollCompletedAt: '2026-08-18T12:00:00Z',
      });
      await writeTendHeartbeat(repoDir, '2026-08-18T12:01:00Z', {
        failureCount: 0,
        lastError: null,
        lastErrorAt: null,
        iteration: 8,
        pollStartedAt: '2026-08-18T12:00:59Z',
        pollCompletedAt: '2026-08-18T12:01:00Z',
      });
      const parsed = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf-8'));
      assert.equal(parsed.services.tend.status, 'healthy');
      assert.equal(parsed.services.tend.failureCount, 0);
      assert.equal(parsed.services.tend.lastError, null);
      assert.equal(parsed.services.tend.iteration, 8);
      assert.equal(parsed.services.tend.lastSuccessfulPollAt, '2026-08-18T12:01:00Z');
      assert.equal(parsed.restartAttemptCount, undefined);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('failure state preserves the last successful heartbeat', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-loop-'));
    try {
      mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
      await writeTendHeartbeat(repoDir, '2026-08-18T12:00:00Z', {
        failureCount: 0,
        lastError: null,
        lastErrorAt: null,
        iteration: 1,
        pollStartedAt: '2026-08-18T11:59:59Z',
        pollCompletedAt: '2026-08-18T12:00:00Z',
      });
      await writeTendFailureState(repoDir, '2026-08-18T12:02:00Z', {
        status: 'degraded',
        detail: 'backstage tend loop poll failed (transient)',
        failureCount: 1,
        lastError: 'transient: timeout',
        lastErrorAt: '2026-08-18T12:02:00Z',
        iteration: 2,
        pollStartedAt: '2026-08-18T12:01:59Z',
        pollCompletedAt: null,
      });
      const parsed = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf-8'));
      assert.equal(parsed.services.tend.status, 'degraded');
      assert.equal(parsed.services.tend.heartbeatAt, '2026-08-18T12:00:00Z');
      assert.equal(parsed.services.tend.iteration, 2);
      assert.equal(parsed.services.tend.pollCompletedAt, null);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
