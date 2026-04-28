import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WM_LABELS } from './pr-state-labels.ts';
import {
  executeMerge,
  formatStatusLine,
  selectNextCandidate,
  type ExecuteMergeOptions,
  type ExecuteOps,
  type GhPrListEntry,
  type IntegrationHealth,
  type SelectNextCandidateOptions,
  type TendDecision,
} from './tend-controller.ts';

function metadata(lines: string[] = ['task: HOK-1437']): string {
  return ['<!-- wavemill-meta', ...lines, '-->'].join('\n');
}

function pr(overrides: Partial<GhPrListEntry> = {}): GhPrListEntry {
  return {
    number: 1,
    title: 'Test PR',
    headRefName: 'task/test-pr',
    createdAt: '2026-04-01T00:00:00Z',
    isDraft: false,
    labels: [{ name: WM_LABELS.wavemill }, { name: WM_LABELS.ready }],
    body: metadata(),
    ...overrides,
  };
}

function label(name: string): { name: string } {
  return { name };
}

function buildTestOptions(
  prList: GhPrListEntry[],
  healthOverride: IntegrationHealth = { state: 'healthy' },
): SelectNextCandidateOptions & { cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-'));
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({ integration: { integrationBranch: 'auto/integration' } }),
  );

  return {
    repoDir,
    prFetcher: async () => prList,
    healthChecker: async () => healthOverride,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

async function withDecision(
  prList: GhPrListEntry[],
  test: (decision: TendDecision) => void | Promise<void>,
  healthOverride?: IntegrationHealth,
): Promise<void> {
  const options = buildTestOptions(prList, healthOverride);
  try {
    const decision = await selectNextCandidate(options);
    await test(decision);
  } finally {
    options.cleanup();
  }
}

describe('selectNextCandidate filtering', () => {
  it('blocks draft PRs', async () => {
    await withDecision([pr({ isDraft: true })], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'draft');
    });
  });

  it('blocks PRs with the blocked label', async () => {
    await withDecision([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'blocked-label');
    });
  });

  it('blocks PRs missing metadata', async () => {
    await withDecision([pr({ body: 'No metadata.' })], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'missing-metadata');
    });
  });

  it('blocks PRs without the ready label', async () => {
    await withDecision([
      pr({ labels: [label(WM_LABELS.wavemill)] }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'ready-failed:not-ready');
    });
  });

  it('blocks unresolved PR dependencies', async () => {
    await withDecision([
      pr({ body: metadata(['depends_on: ["PR#99"]']) }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'deps-unresolved');
    });
  });

  it('blocks unresolved Linear dependencies', async () => {
    await withDecision([
      pr({ body: metadata(['depends_on_linear: ["HOK-9999"]']) }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'deps-unresolved');
    });
  });

  it('blocks unresolved challenges', async () => {
    await withDecision([
      pr({
        body: metadata(['challenge: true']),
        labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.challengeUnresolved)],
      }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'challenges-unresolved');
    });
  });

  it('ignores non-Wavemill PRs', async () => {
    await withDecision([
      pr({ labels: [], body: 'No metadata.' }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked.length, 0);
      assert.equal(decision.nextPR, null);
    });
  });
});

describe('selectNextCandidate ordering and health', () => {
  it('sorts eligible PRs by dependency depth then created date', async () => {
    await withDecision([
      pr({ number: 3, createdAt: '2026-04-01T00:00:00Z', body: metadata(['depends_on: ["PR#2"]']) }),
      pr({ number: 1, createdAt: '2026-04-03T00:00:00Z' }),
      pr({ number: 2, createdAt: '2026-04-02T00:00:00Z' }),
      pr({ number: 4, createdAt: '2026-04-04T00:00:00Z', body: metadata(['depends_on: ["PR#3"]']) }),
    ], (decision) => {
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [2, 1, 3, 4]);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.dependencyDepth), [0, 0, 1, 2]);
      assert.equal(decision.nextPR, 2);
    });
  });

  it('short-circuits when integration health is unhealthy', async () => {
    await withDecision([pr()], (decision) => {
      assert.equal(decision.integrationHealth.state, 'unhealthy');
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked.length, 0);
      assert.equal(decision.nextPR, null);
    }, { state: 'unhealthy', reason: 'ci: failure' });
  });

  it('returns an empty decision for empty input', async () => {
    await withDecision([], (decision) => {
      assert.deepEqual(decision.eligible, []);
      assert.deepEqual(decision.blocked, []);
      assert.equal(decision.nextPR, null);
    });
  });

  it('reports mixed eligible and blocked counts', async () => {
    await withDecision([
      pr({ number: 1 }),
      pr({ number: 2, createdAt: '2026-04-02T00:00:00Z' }),
      pr({ number: 3, isDraft: true }),
      pr({ number: 4, body: 'No metadata.' }),
      pr({ number: 5, labels: [label(WM_LABELS.wavemill)] }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 2);
      assert.equal(decision.blocked.length, 3);
      assert.equal(decision.nextPR, 1);
    });
  });
});

describe('selectNextCandidate dependency cycles', () => {
  it('blocks a 2-cycle', async () => {
    await withDecision([
      pr({ number: 1, body: metadata(['depends_on: ["PR#2"]']) }),
      pr({ number: 2, body: metadata(['depends_on: ["PR#1"]']) }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.deepEqual(decision.blocked.map((candidate) => candidate.reason), ['dependency-cycle', 'dependency-cycle']);
    });
  });

  it('blocks a 3-cycle', async () => {
    await withDecision([
      pr({ number: 1, body: metadata(['depends_on: ["PR#2"]']) }),
      pr({ number: 2, body: metadata(['depends_on: ["PR#3"]']) }),
      pr({ number: 3, body: metadata(['depends_on: ["PR#1"]']) }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked.length, 3);
      assert.ok(decision.blocked.every((candidate) => candidate.reason === 'dependency-cycle'));
    });
  });

  it('blocks a self-loop', async () => {
    await withDecision([
      pr({ number: 1, body: metadata(['depends_on: ["PR#1"]']) }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'dependency-cycle');
    });
  });
});

describe('formatStatusLine', () => {
  it('formats the dry-run status line', async () => {
    await withDecision([pr()], (decision) => {
      assert.match(formatStatusLine(decision), /^tend: integration=healthy eligible=1 blocked=0 next=PR#1$/);
    });
  });

  it('includes unhealthy reasons and none when no PR is selected', () => {
    assert.equal(
      formatStatusLine({
        integrationHealth: { state: 'unhealthy', reason: 'ci: failure' },
        eligible: [],
        blocked: [],
        nextPR: null,
      }),
      'tend: integration=unhealthy:ci: failure eligible=0 blocked=0 next=none',
    );
  });
});

// ─── executeMerge ─────────────────────────────────────────────────────────────

function buildExecuteOptions(
  prList: GhPrListEntry[],
  opsOverrides: Partial<ExecuteOps> = {},
  healthOverride: IntegrationHealth = { state: 'healthy' },
): ExecuteMergeOptions & { cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-exec-'));
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({ integration: { integrationBranch: 'auto/integration', mergeMethod: 'squash' } }),
  );

  const defaultOps: ExecuteOps = {
    prFetcher: async () => prList,
    healthChecker: async () => healthOverride,
    setMerging: () => {},
    setBlocked: () => {},
    setMerged: () => {},
    gitFetch: () => {},
    gitWorktreeAdd: () => {},
    gitWorktreeRemove: () => {},
    gitRebase: () => {},
    gitRebaseAbort: () => {},
    gitGetRemoteSha: () => 'abc123sha',
    gitForcePush: () => {},
    pollPrChecks: async () => ({ pass: true }),
    runReadyCheck: async () => ({ pass: true }),
    mergePr: () => {},
    postComment: () => {},
  };

  return {
    repoDir,
    ops: { ...defaultOps, ...opsOverrides },
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

describe('executeMerge', () => {
  it('merges successfully (REQ-F1)', async () => {
    const calls: string[] = [];
    const prList = [pr({ number: 100, headRefName: 'task/my-feature' })];
    const opts = buildExecuteOptions(prList, {
      setMerging: (n) => calls.push(`setMerging:${n}`),
      gitFetch: () => calls.push('gitFetch'),
      gitRebase: () => calls.push('gitRebase'),
      gitForcePush: () => calls.push('gitForcePush'),
      pollPrChecks: async () => { calls.push('pollPrChecks'); return { pass: true }; },
      runReadyCheck: async () => { calls.push('runReadyCheck'); return { pass: true }; },
      mergePr: () => calls.push('mergePr'),
      setMerged: (n) => calls.push(`setMerged:${n}`),
    });
    try {
      const outcome = await executeMerge(opts);
      assert.deepEqual(outcome, { status: 'merged', pr: 100 });
      assert.ok(calls.includes('setMerging:100'), 'setMerging called');
      assert.ok(calls.includes('gitFetch'), 'gitFetch called');
      assert.ok(calls.includes('gitRebase'), 'gitRebase called');
      assert.ok(calls.includes('gitForcePush'), 'gitForcePush called');
      assert.ok(calls.includes('pollPrChecks'), 'pollPrChecks called');
      assert.ok(calls.includes('runReadyCheck'), 'runReadyCheck called');
      assert.ok(calls.includes('mergePr'), 'mergePr called');
      assert.ok(calls.includes('setMerged:100'), 'setMerged called');
      const mergingIndex = calls.indexOf('setMerging:100');
      const mergedIndex = calls.indexOf('setMerged:100');
      assert.ok(mergingIndex < mergedIndex, 'setMerging happens before setMerged');
    } finally {
      opts.cleanup();
    }
  });

  it('returns skipped when a PR is already merging (REQ-F2)', async () => {
    const prList = [
      pr({ number: 99, labels: [label(WM_LABELS.wavemill), label(WM_LABELS.merging)] }),
      pr({ number: 100 }),
    ];
    const opts = buildExecuteOptions(prList);
    try {
      const outcome = await executeMerge(opts);
      assert.deepEqual(outcome, { status: 'skipped', reason: 'merging-in-progress', activePr: 99 });
    } finally {
      opts.cleanup();
    }
  });

  it('blocks and continues on rebase failure (REQ-F3)', async () => {
    const comments: string[] = [];
    let setBlockedCalled = false;
    let mergePrCalled = false;
    const prList = [pr({ number: 100 })];
    const opts = buildExecuteOptions(prList, {
      gitRebase: () => { throw new Error('CONFLICT (content)'); },
      postComment: (_n, body) => { comments.push(body); },
      setBlocked: () => { setBlockedCalled = true; },
      mergePr: () => { mergePrCalled = true; },
    });
    try {
      const outcome = await executeMerge(opts);
      assert.deepEqual(outcome, { status: 'continue', failure: 'rebase', prNumber: 100 });
      assert.ok(setBlockedCalled, 'setBlocked should be called');
      assert.ok(comments.some((c) => c.toLowerCase().includes('rebase')), 'comment should mention rebase');
      assert.ok(!mergePrCalled, 'mergePr should not be called');
    } finally {
      opts.cleanup();
    }
  });

  it('blocks and continues on PR check failure (REQ-F4)', async () => {
    const comments: string[] = [];
    let setBlockedCalled = false;
    let mergePrCalled = false;
    const prList = [pr({ number: 100 })];
    const opts = buildExecuteOptions(prList, {
      pollPrChecks: async () => ({ pass: false, failed: ['test-suite'] }),
      postComment: (_n, body) => { comments.push(body); },
      setBlocked: () => { setBlockedCalled = true; },
      mergePr: () => { mergePrCalled = true; },
    });
    try {
      const outcome = await executeMerge(opts);
      assert.deepEqual(outcome, { status: 'continue', failure: 'checks', prNumber: 100 });
      assert.ok(setBlockedCalled, 'setBlocked should be called');
      assert.ok(comments.length > 0, 'comment should be posted');
      assert.ok(!mergePrCalled, 'mergePr should not be called');
    } finally {
      opts.cleanup();
    }
  });

  it('blocks and continues on ready engine failure (REQ-F5)', async () => {
    const comments: string[] = [];
    let setBlockedCalled = false;
    let mergePrCalled = false;
    const prList = [pr({ number: 100 })];
    const opts = buildExecuteOptions(prList, {
      runReadyCheck: async () => ({ pass: false, reasons: ['deps-unresolved'] }),
      postComment: (_n, body) => { comments.push(body); },
      setBlocked: () => { setBlockedCalled = true; },
      mergePr: () => { mergePrCalled = true; },
    });
    try {
      const outcome = await executeMerge(opts);
      assert.deepEqual(outcome, { status: 'continue', failure: 'ready', prNumber: 100 });
      assert.ok(setBlockedCalled, 'setBlocked should be called');
      assert.ok(comments.some((c) => c.includes('Ready check failed')), 'comment should mention ready check');
      assert.ok(!mergePrCalled, 'mergePr should not be called');
    } finally {
      opts.cleanup();
    }
  });

  it('halts when integration goes red after merge (REQ-F6)', async () => {
    let mergeComplete = false;
    let setBlockedCalled = false;
    const prList = [pr({ number: 100 })];
    const opts = buildExecuteOptions(prList, {
      healthChecker: async () => {
        if (mergeComplete) {
          return { state: 'unhealthy', reason: 'ci: failure' };
        }
        return { state: 'healthy' };
      },
      mergePr: () => { mergeComplete = true; },
      setBlocked: () => { setBlockedCalled = true; },
    });
    try {
      const outcome = await executeMerge(opts);
      assert.deepEqual(outcome, { status: 'halt', reason: 'integration-red', integrationBranch: 'auto/integration' });
      assert.ok(!setBlockedCalled, 'setBlocked should not be called on integration halt');
    } finally {
      opts.cleanup();
    }
  });

  it('returns idle when there are no ready PRs', async () => {
    const opts = buildExecuteOptions([]);
    try {
      const outcome = await executeMerge(opts);
      assert.deepEqual(outcome, { status: 'idle' });
    } finally {
      opts.cleanup();
    }
  });

  it('cleans up worktree even when rebase fails (REQ-F8)', async () => {
    const removedPaths: string[] = [];
    const prList = [pr({ number: 100 })];
    const opts = buildExecuteOptions(prList, {
      gitRebase: () => { throw new Error('CONFLICT'); },
      gitWorktreeRemove: (path) => { removedPaths.push(path); },
    });
    try {
      await executeMerge(opts);
      assert.ok(removedPaths.length > 0, 'gitWorktreeRemove should be called at least once');
    } finally {
      opts.cleanup();
    }
  });
});
