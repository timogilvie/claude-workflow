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
  type GhPrListEntry,
  type IntegrationHealth,
  type MergeExecutionDeps,
  type SelectNextCandidateOptions,
  type TendCandidate,
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

function candidate(overrides: Partial<TendCandidate> = {}): TendCandidate {
  return {
    number: 42,
    title: 'Merge me',
    headBranch: 'task/merge-me',
    createdAt: '2026-04-01T00:00:00Z',
    dependencyDepth: 0,
    ...overrides,
  };
}

function buildMergeTestOptions(overrides: {
  shellRunner?: MergeExecutionDeps['shellRunner'];
  readyChecker?: MergeExecutionDeps['readyChecker'];
  healthChecker?: MergeExecutionDeps['healthChecker'];
} = {}): {
  repoDir: string;
  calls: string[];
  labels: string[];
  deps: Partial<MergeExecutionDeps>;
  cleanup: () => void;
} {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-merge-'));
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({ integration: { integrationBranch: 'auto/integration', mergeMethod: 'squash' } }),
  );

  const calls: string[] = [];
  const labels: string[] = [];
  const defaultShellRunner: MergeExecutionDeps['shellRunner'] = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('gh pr list --label')) return '[]';
    if (cmd.includes('git rev-parse --git-common-dir')) return join(repoDir, '.git');
    if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'success' }]);
    return '';
  };

  return {
    repoDir,
    calls,
    labels,
    deps: {
      shellRunner: overrides.shellRunner ?? defaultShellRunner,
      readyChecker: overrides.readyChecker ?? (async () => ({ ready: true })),
      healthChecker: overrides.healthChecker ?? (async () => ({ state: 'healthy' })),
      acquireMerging: (prNumber) => {
        labels.push(`merging:${prNumber}`);
      },
      releaseToBlocked: (prNumber) => {
        labels.push(`blocked:${prNumber}`);
      },
      releaseMerged: (prNumber) => {
        labels.push(`merged:${prNumber}`);
      },
      restoreReady: (prNumber) => {
        labels.push(`ready:${prNumber}`);
      },
    },
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function hasCall(calls: string[], pattern: RegExp): boolean {
  return calls.some((call) => pattern.test(call));
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

describe('executeMerge', () => {
  it('rebases, pushes, waits, merges, and marks merged', async () => {
    const options = buildMergeTestOptions();
    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.deepEqual(result, { status: 'merged', prNumber: 42, haltLoop: false });
      assert.ok(hasCall(options.calls, /git worktree add/));
      assert.ok(hasCall(options.calls, /git fetch origin 'auto\/integration'/));
      assert.ok(hasCall(options.calls, /git rebase 'origin\/auto\/integration'/));
      assert.ok(hasCall(options.calls, /git push --force-with-lease origin 'task\/merge-me'/));
      assert.ok(hasCall(options.calls, /gh pr checks 42/));
      assert.ok(hasCall(options.calls, /gh pr merge 42 --squash --delete-branch/));
      assert.ok(hasCall(options.calls, /git worktree remove --force/));
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
    } finally {
      options.cleanup();
    }
  });

  it('blocks and comments when rebase fails', async () => {
    const options = buildMergeTestOptions();
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      if (cmd.includes('git rebase')) {
        throw new Error('rebase conflict\nfile.ts');
      }
      return defaultRunner(cmd, opts);
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: { ...options.deps, shellRunner },
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'rebase');
      assert.ok(hasCall(options.calls, /gh pr comment 42 --body/));
      assert.ok(hasCall(options.calls, /Wavemill Rebase failed/));
      assert.ok(hasCall(options.calls, /git worktree remove --force/));
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
    } finally {
      options.cleanup();
    }
  });

  it('blocks when PR checks fail and does not merge', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'failure' }]);
        return '';
      },
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'checks');
      assert.ok(!hasCall(options.calls, /gh pr merge/));
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
    } finally {
      options.cleanup();
    }
  });

  it('blocks when the ready re-check fails', async () => {
    const options = buildMergeTestOptions({
      readyChecker: async () => ({ ready: false, reason: 'missing risk field' }),
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'ready');
      assert.ok(hasCall(options.calls, /missing risk field/));
      assert.ok(!hasCall(options.calls, /gh pr merge/));
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
    } finally {
      options.cleanup();
    }
  });

  it('halts after merge when integration becomes unhealthy', async () => {
    const options = buildMergeTestOptions({
      healthChecker: async () => ({ state: 'unhealthy', reason: 'ci: failure' }),
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.equal(result.status, 'halted');
      assert.equal(result.haltLoop, true);
      assert.equal(result.phase, 'integration');
      assert.ok(hasCall(options.calls, /gh pr merge 42/));
      assert.ok(hasCall(options.calls, /gh pr comment 42 --body/));
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
    } finally {
      options.cleanup();
    }
  });

  it('skips when another PR is already marked merging', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return JSON.stringify([{ number: 7 }]);
        return '';
      },
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.deepEqual(result, { status: 'skipped', prNumber: 42, haltLoop: false });
      assert.ok(!hasCall(options.calls, /git worktree add/));
      assert.deepEqual(options.labels, []);
    } finally {
      options.cleanup();
    }
  });
});
