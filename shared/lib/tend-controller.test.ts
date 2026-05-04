import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  configOverride: Record<string, unknown> = {},
): SelectNextCandidateOptions & { cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      integration: { integrationBranch: 'auto/integration' },
      ...configOverride,
    }),
  );

  return {
    repoDir,
    prFetcher: async () => prList,
    healthChecker: async () => healthOverride,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function writeWorkflowState(repoDir: string, tasks: Record<string, unknown>): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks }));
}

function writeChallengeComparisons(repoDir: string, records: object[]): void {
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n'),
  );
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
    if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'abc123def456';
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

describe('challenge-mode gating', () => {
  it('blocks both challenge PRs when the pair is unresolved', async () => {
    const first = pr({
      number: 101,
      title: 'Primary',
      headRefName: 'task/primary',
      body: metadata(['task: HOK-1439', 'challenge: true', 'challengePairId: pair-1']),
    });
    const second = pr({
      number: 102,
      title: 'Challenger',
      headRefName: 'task/challenger',
      createdAt: '2026-04-02T00:00:00Z',
      body: metadata(['task: HOK-1439_c', 'challenge: true', 'challengePairId: pair-1']),
    });
    const options = buildTestOptions([first, second]);
    const cleaned: number[] = [];
    options.loserCleanup = (prNumber) => {
      cleaned.push(prNumber);
    };
    writeWorkflowState(options.repoDir, {
      HOK_1439: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
      HOK_1439_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.nextPR, null);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [
          [101, 'challenge:pair-unresolved:no-comparison'],
          [102, 'challenge:pair-unresolved:no-comparison'],
        ],
      );
      assert.deepEqual(cleaned, []);
    } finally {
      options.cleanup();
    }
  });

  it('keeps only the winner eligible and cleans up the loser when auto-merge is enabled', async () => {
    const first = pr({
      number: 101,
      title: 'Primary',
      headRefName: 'task/primary',
      body: metadata(['task: HOK-1439', 'challenge: true', 'challengePairId: pair-1']),
    });
    const second = pr({
      number: 102,
      title: 'Challenger',
      headRefName: 'task/challenger',
      createdAt: '2026-04-02T00:00:00Z',
      body: metadata(['task: HOK-1439_c', 'challenge: true', 'challengePairId: pair-1']),
    });
    const options = buildTestOptions([first, second]);
    const cleaned: number[] = [];
    options.loserCleanup = (prNumber) => {
      cleaned.push(prNumber);
    };
    writeWorkflowState(options.repoDir, {
      HOK_1439: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
      HOK_1439_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
    });
    writeChallengeComparisons(options.repoDir, [{
      challengePairId: 'pair-1',
      primaryPrUrl: 'https://github.com/example/repo/pull/101',
      challengerPrUrl: 'https://github.com/example/repo/pull/102',
      winner: 'primary',
      timestamp: '2026-04-28T12:00:00Z',
    }]);

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [101]);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[102, 'challenge:loser:pair-1']],
      );
      assert.equal(decision.nextPR, 101);
      assert.deepEqual(cleaned, [102]);
    } finally {
      options.cleanup();
    }
  });

  it('does not re-run loser cleanup after the loser has been superseded', async () => {
    const first = pr({
      number: 101,
      title: 'Primary',
      headRefName: 'task/primary',
      body: metadata(['task: HOK-1439', 'challenge: true', 'challengePairId: pair-1']),
    });
    const second = pr({
      number: 102,
      title: 'Challenger',
      headRefName: 'task/challenger',
      createdAt: '2026-04-02T00:00:00Z',
      labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.superseded)],
      body: metadata(['task: HOK-1439_c', 'challenge: true', 'challengePairId: pair-1']),
    });
    const options = buildTestOptions([first, second]);
    const cleaned: number[] = [];
    options.loserCleanup = (prNumber) => {
      cleaned.push(prNumber);
    };
    writeWorkflowState(options.repoDir, {
      HOK_1439: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
      HOK_1439_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
    });
    writeChallengeComparisons(options.repoDir, [{
      challengePairId: 'pair-1',
      primaryPrUrl: 'https://github.com/example/repo/pull/101',
      challengerPrUrl: 'https://github.com/example/repo/pull/102',
      winner: 'primary',
      timestamp: '2026-04-28T12:00:00Z',
    }]);

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [101]);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[102, 'challenge:loser:pair-1']],
      );
      assert.deepEqual(cleaned, []);
    } finally {
      options.cleanup();
    }
  });

  it('holds the winner when autoMergeWinner is false and still cleans up the loser', async () => {
    const first = pr({
      number: 101,
      title: 'Primary',
      headRefName: 'task/primary',
      body: metadata(['task: HOK-1439', 'challenge: true', 'challengePairId: pair-1']),
    });
    const second = pr({
      number: 102,
      title: 'Challenger',
      headRefName: 'task/challenger',
      createdAt: '2026-04-02T00:00:00Z',
      body: metadata(['task: HOK-1439_c', 'challenge: true', 'challengePairId: pair-1']),
    });
    const options = buildTestOptions([first, second], { state: 'healthy' }, {
      challenge: { autoMergeWinner: false },
    });
    const cleaned: number[] = [];
    options.loserCleanup = (prNumber) => {
      cleaned.push(prNumber);
    };
    writeWorkflowState(options.repoDir, {
      HOK_1439: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
      HOK_1439_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
    });
    writeChallengeComparisons(options.repoDir, [{
      challengePairId: 'pair-1',
      primaryPrUrl: 'https://github.com/example/repo/pull/101',
      challengerPrUrl: 'https://github.com/example/repo/pull/102',
      winner: 'primary',
      timestamp: '2026-04-28T12:00:00Z',
    }]);

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.nextPR, null);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [
          [101, 'challenge:winner-held:pair-1'],
          [102, 'challenge:loser:pair-1'],
        ],
      );
      assert.deepEqual(cleaned, [102]);
    } finally {
      options.cleanup();
    }
  });

  it('leaves non-challenge PR behavior unchanged', async () => {
    await withDecision([pr({ number: 201, title: 'Normal PR' })], (decision) => {
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [201]);
      assert.deepEqual(decision.blocked, []);
      assert.equal(decision.nextPR, 201);
    });
  });
});

describe('challenge-gate race prevention', () => {
  it('blocks primary when challenger sibling branch exists but no workflow state', async () => {
    const primary = pr({
      number: 497,
      title: 'Primary',
      headRefName: 'task/hok-1523',
      createdAt: '2020-01-01T00:00:00Z',
    });
    const options = buildTestOptions([primary]);
    options.challengeGateOptions = {
      remoteBranches: ['task/hok-1523', 'task/hok-1523-challenger'],
      coolOffSeconds: 0,
    };

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.nextPR, null);
      assert.equal(decision.blocked[0]?.reason, 'challenge:pair-unresolved:branch-pair');
    } finally {
      options.cleanup();
    }
  });

  it('blocks primary when challenger task is in workflow state but has no open PR', async () => {
    const primary = pr({
      number: 497,
      title: 'Primary',
      headRefName: 'task/hok-1523',
      body: metadata(['task: HOK-1523', 'challenge: true', 'challengePairId: pair-hok-1523']),
    });
    const options = buildTestOptions([primary]);
    options.challengeGateOptions = {
      remoteBranches: ['task/hok-1523'],
      coolOffSeconds: 0,
    };
    writeWorkflowState(options.repoDir, {
      HOK_1523: { pr: 497, challengePairId: 'pair-hok-1523', challengeRole: 'primary' },
      HOK_1523_c: { challengePairId: 'pair-hok-1523', challengeRole: 'challenger' },
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.nextPR, null);
      assert.equal(decision.blocked[0]?.reason, 'challenge:pair-unresolved:no-comparison');
    } finally {
      options.cleanup();
    }
  });

  it('blocks a young task PR via cool-off when no branch/workflow signal exists', async () => {
    const now = Date.parse('2026-04-01T00:03:00Z');
    const young = pr({
      number: 301,
      title: 'Young PR',
      headRefName: 'task/young',
      createdAt: '2026-04-01T00:01:00Z',
    });
    const options = buildTestOptions([young]);
    options.challengeGateOptions = {
      remoteBranches: [],
      coolOffSeconds: 300,
      nowMs: () => now,
    };

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'challenge:cool-off');
    } finally {
      options.cleanup();
    }
  });

  it('allows an old task PR when no branch/workflow signal exists', async () => {
    const now = Date.parse('2026-04-01T01:00:00Z');
    const old = pr({
      number: 302,
      title: 'Old PR',
      headRefName: 'task/old',
      createdAt: '2026-04-01T00:01:00Z',
    });
    const options = buildTestOptions([old]);
    options.challengeGateOptions = {
      remoteBranches: [],
      coolOffSeconds: 300,
      nowMs: () => now,
    };

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 1);
      assert.equal(decision.nextPR, 302);
    } finally {
      options.cleanup();
    }
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
      assert.equal(formatStatusLine(decision), 'eligible=1 blocked=0 health=ok last=none action=idle');
    });
  });

  it('includes degraded health, last merged PR, and action overrides', () => {
    assert.equal(
      formatStatusLine({
        integrationHealth: { state: 'unhealthy', reason: 'ci: failure' },
        eligible: [],
        blocked: [],
        nextPR: null,
      }, { action: 'merged-#42', lastPR: 42 }),
      'eligible=0 blocked=0 health=degraded last=#42 action=merged-#42',
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
      assert.ok(hasCall(options.calls, /git push --force-with-lease/));
      assert.ok(hasCall(options.calls, /gh pr checks 42 --json name,state,bucket 2>&1 \|\| true/));
      assert.ok(hasCall(options.calls, /gh pr merge 42 --squash --delete-branch/));
      assert.ok(hasCall(options.calls, /git worktree remove --force/));
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
    } finally {
      options.cleanup();
    }
  });

  it('uses a detached scratch worktree so it does not fight mill task worktrees', async () => {
    // Mill's task worktree at worktrees/<slug>/ already holds the PR branch
    // checked out. Tend's scratch worktree must NOT try to check it out by
    // name — git only allows a branch in one worktree at a time. The fix:
    // `git worktree add --detach <path> origin/<branch>` so HEAD is detached.
    const options = buildMergeTestOptions();
    try {
      await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      // The worktree-add command must include --detach and the origin/ ref,
      // not just the branch name.
      assert.ok(
        hasCall(options.calls, /git worktree add --detach .* 'origin\/task\/merge-me'/),
        'expected: git worktree add --detach <path> origin/<branch>',
      );

      // The PR branch must be fetched before the worktree-add so origin/<branch>
      // is fresh.
      assert.ok(
        hasCall(options.calls, /git fetch origin 'task\/merge-me'/),
        'expected: git fetch origin <branch> before scratch worktree creation',
      );

      // The push must use HEAD:<branch> syntax because we are operating from
      // a detached HEAD.
      assert.ok(
        hasCall(options.calls, /git push --force-with-lease=.* origin HEAD:'task\/merge-me'/),
        'expected: git push ... origin HEAD:<branch>',
      );

      // The legacy form (which would break on a detached HEAD) must NOT appear.
      assert.ok(
        !options.calls.some((cmd) =>
          /git push --force-with-lease=[^ ]+ origin 'task\/merge-me'/.test(cmd) &&
          !cmd.includes('HEAD:')
        ),
        'expected legacy `git push origin <branch>` form to be replaced',
      );
    } finally {
      options.cleanup();
    }
  });

  it('queries gh pr checks with bucket, not the removed conclusion field', async () => {
    // gh CLI ≥ 2.72.0 removed `conclusion` from `gh pr checks --json`'s
    // accepted fields. Asking for it now fails the whole call with
    // "Unknown JSON field: conclusion". We must request `bucket` instead
    // and synthesize a conclusion-shaped value internally.
    const options = buildMergeTestOptions();
    try {
      await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      const checksCall = options.calls.find((c) => c.startsWith('gh pr checks'));
      assert.ok(checksCall, 'expected at least one gh pr checks call');
      assert.match(checksCall, /--json [^ ]*\bbucket\b/);
      assert.ok(
        !/--json [^ ]*\bconclusion\b/.test(checksCall),
        'expected `conclusion` to no longer be requested',
      );
    } finally {
      options.cleanup();
    }
  });

  it('treats checks as passing when only bucket is present (post-2.72.0 gh shape)', async () => {
    // Simulate the new gh CLI output shape where conclusion is absent and
    // bucket carries the categorization. Without the bucket→conclusion
    // synthesis, the merge would never reach `pass` and would block on
    // the "all checks passing" gate.
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        const calls = options.calls;
        calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'abc123def456';
        if (cmd.includes('gh pr checks')) {
          // New gh shape: only `bucket` and `state`, no `conclusion`.
          return JSON.stringify([{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }]);
        }
        return '';
      },
    });
    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });
      assert.equal(result.status, 'merged');
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

  it('blocks when PR checks report a failing gh bucket', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', bucket: 'fail' }]);
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

  it('cleans up worktree on all exit paths', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('git rebase')) throw new Error('rebase failed');
        return '';
      },
    });

    try {
      await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      // Verify worktree was both added and removed, even though rebase failed
      assert.ok(hasCall(options.calls, /git worktree add/));
      assert.ok(hasCall(options.calls, /git worktree remove --force/));
      // Verify the remove call happened even on error path
      const addIdx = options.calls.findIndex((c) => c.includes('git worktree add'));
      const removeIdx = options.calls.findIndex((c) => c.includes('git worktree remove --force'));
      assert.ok(addIdx >= 0 && removeIdx > addIdx, 'worktree remove should happen after add');
    } finally {
      options.cleanup();
    }
  });
});
