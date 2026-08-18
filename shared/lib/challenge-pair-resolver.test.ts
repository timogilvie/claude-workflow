import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readChallengeComparisons } from './challenge-comparison.ts';
import { resolveUnresolvablePair } from './challenge-pair-resolver.ts';
import { applyChallengePairGates, type ChallengeEligibleWorkItem } from './tend-challenge-gate.ts';

function setupRepoDir(config: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-resolver-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      integration: { integrationBranch: 'auto/integration' },
      ...config,
    }),
  );
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function writeWorkflowState(
  repoDir: string,
  tasks: Record<string, unknown>,
  jobs: Record<string, unknown> = {},
): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks, jobs }));
}

function makeWorkItem(number: number, headRefName: string, challengePairId: string): ChallengeEligibleWorkItem {
  return {
    pr: {
      number,
      title: `PR ${number}`,
      headRefName,
      createdAt: '2026-07-01T00:00:00Z',
      labels: [],
    },
    metadata: {
      challenge: true,
      challengePairId,
    },
  };
}

test('resolver is idempotent for orphaned pairs', () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/orphaned',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
      },
    });

    const now = () => new Date('2026-07-17T12:00:00Z');
    const first = resolveUnresolvablePair({ pairId: 'pair-1', repoDir, now });
    const second = resolveUnresolvablePair({ pairId: 'pair-1', repoDir, now });

    assert.equal(first.status, 'resolved');
    assert.equal(second.status, 'already-resolved');
    assert.equal(readChallengeComparisons(join(repoDir, '.wavemill', 'evals')).length, 1);
  } finally {
    cleanup();
  }
});

test('resolver writes a forfeit for an orphaned pair with a completed survivor', () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/orphaned',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
      },
    });

    const result = resolveUnresolvablePair({
      pairId: 'pair-1',
      repoDir,
      reason: 'orphan-sibling',
      now: () => new Date('2026-07-17T12:00:00Z'),
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'forfeit');
    assert.equal(result.record.winner, 'primary');
    assert.equal(result.record.terminalReason, 'orphan_pair');
  } finally {
    cleanup();
  }
});

test('resolver writes a double-forfeit when an orphaned pair has no completed survivor', () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/orphaned',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
      },
    });

    const result = resolveUnresolvablePair({
      pairId: 'pair-1',
      repoDir,
      reason: 'orphan-sibling',
      now: () => new Date('2026-07-17T12:00:00Z'),
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'double-forfeit');
    assert.equal(result.record.comparisonOutcome, 'double-forfeit');
    assert.equal(result.record.terminalReason, 'orphan_pair');
  } finally {
    cleanup();
  }
});

test('resolver writes a forfeit when one side exhausted eval hard-failure retries', () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/primary',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
      },
      HOK_1_c: {
        pr: 102,
        branch: 'task/primary-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'challenger',
        challengeModel: 'claude-opus-4-8',
        evalFailed: true,
        evalHardFailureRetryCount: 2,
      },
    });

    const result = resolveUnresolvablePair({
      pairId: 'pair-1',
      repoDir,
      reason: 'sibling-eval-hard-failed',
      now: () => new Date('2026-07-17T12:00:00Z'),
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'forfeit');
    assert.equal(result.record.winner, 'primary');
    assert.equal(result.record.terminalReason, 'challenger_eval_hard_failed');
  } finally {
    cleanup();
  }
});

test('resolver writes a double-forfeit when both sides exhausted eval hard-failure retries', () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/primary',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalFailed: true,
        evalHardFailureRetryCount: 2,
      },
      HOK_1_c: {
        pr: 102,
        branch: 'task/primary-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'challenger',
        challengeModel: 'claude-opus-4-8',
        evalFailed: true,
        evalHardFailureRetryCount: 2,
      },
    });

    const result = resolveUnresolvablePair({
      pairId: 'pair-1',
      repoDir,
      reason: 'both-eval-hard-failed',
      now: () => new Date('2026-07-17T12:00:00Z'),
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'double-forfeit');
    assert.equal(result.record.terminalReason, 'both_eval_hard_failed');
  } finally {
    cleanup();
  }
});

test('resolver unblocks the surviving PR in applyChallengePairGates', async () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/orphaned',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
      },
    });

    const resolution = resolveUnresolvablePair({
      pairId: 'pair-1',
      repoDir,
      reason: 'orphan-sibling',
      now: () => new Date('2026-07-17T12:00:00Z'),
    });
    assert.equal(resolution.status, 'resolved');

    const result = await applyChallengePairGates(
      [makeWorkItem(101, 'task/orphaned', 'pair-1')],
      [],
      repoDir,
      {
        remoteBranches: ['task/orphaned'],
        coolOffSeconds: 0,
      },
    );

    assert.equal(result.eligible.length, 1);
    assert.equal(result.eligible[0].pr.number, 101);
    assert.equal(result.blocked.length, 0);
  } finally {
    cleanup();
  }
});

test('resolver auto-detects both aborted arms and forfeits to completed survivor', () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/primary',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
        challengeAborted: 'Native coding failed: quarantined peer',
      },
      HOK_1_c: {
        branch: 'task/primary-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'challenger',
        challengeModel: 'qwen-2.5-coder-32b',
        challengeAborted: 'Native coding failed: 404 No endpoints found that support tool use.',
      },
    });

    const result = resolveUnresolvablePair({ pairId: 'pair-abort', repoDir });

    assert.equal(result.status, 'resolved');
    assert.equal(result.reason, 'both-challenge-aborted');
    assert.equal(result.outcome, 'forfeit');
    assert.equal(result.record.winner, 'primary');
    assert.equal(result.record.terminalReason, 'challenger_challenge_aborted');
  } finally {
    cleanup();
  }
});

test('resolver skips aborted pair when lone surviving PR has not persisted eval', () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/primary',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        challengeAborted: 'Native coding failed: quarantined peer',
      },
      HOK_1_c: {
        branch: 'task/primary-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'challenger',
        challengeModel: 'qwen-2.5-coder-32b',
        challengeAborted: 'Native coding failed: no endpoints support tool use',
      },
    });

    const result = resolveUnresolvablePair({ pairId: 'pair-abort', repoDir });

    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /surviving arm has not persisted an eval/);
    assert.equal(readChallengeComparisons(join(repoDir, '.wavemill', 'evals')).length, 0);
  } finally {
    cleanup();
  }
});

test('resolver writes forfeit when a sibling challenge-aborted and survivor completed eval', () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/primary',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
      },
      HOK_1_c: {
        pr: 102,
        branch: 'task/primary-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'challenger',
        challengeModel: 'qwen-2.5-coder-32b',
        challengeAborted: 'Native coding failed: no endpoints support tool use',
      },
    });

    const result = resolveUnresolvablePair({ pairId: 'pair-abort', repoDir });

    assert.equal(result.status, 'resolved');
    assert.equal(result.reason, 'sibling-challenge-aborted');
    assert.equal(result.outcome, 'forfeit');
    assert.equal(result.record.winner, 'primary');
    assert.equal(result.record.terminalReason, 'challenger_challenge_aborted');
  } finally {
    cleanup();
  }
});

test('resolver writes double-forfeit when both aborted arms have no completed evals but both produced PRs', () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/primary',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        challengeAborted: 'Native coding failed: context overflow',
      },
      HOK_1_c: {
        pr: 102,
        branch: 'task/primary-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'challenger',
        challengeModel: 'qwen-2.5-coder-32b',
        challengeAborted: 'Native coding failed: no endpoints support tool use',
      },
    });

    const result = resolveUnresolvablePair({ pairId: 'pair-abort', repoDir });

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'double-forfeit');
    assert.equal(result.record.terminalReason, 'both_challenge_aborted');
  } finally {
    cleanup();
  }
});

test('resolver and gate agree on aborted pair reason and unblock after resolution', async () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/primary',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
        challengeAborted: 'Native coding failed: quarantined peer',
      },
      HOK_1_c: {
        branch: 'task/primary-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'challenger',
        challengeModel: 'qwen-2.5-coder-32b',
        challengeAborted: 'Native coding failed: no endpoints support tool use',
      },
    });

    const blocked = await applyChallengePairGates(
      [makeWorkItem(101, 'task/primary', 'pair-abort')],
      [],
      repoDir,
      { remoteBranches: ['task/primary'], coolOffSeconds: 0 },
    );
    assert.equal(blocked.eligible.length, 0);
    assert.equal(blocked.blocked[0]?.reason, 'challenge:pair-unresolvable:both-challenge-aborted');

    const resolution = resolveUnresolvablePair({ pairId: 'pair-abort', repoDir });
    assert.equal(resolution.status, 'resolved');

    const unblocked = await applyChallengePairGates(
      [makeWorkItem(101, 'task/primary', 'pair-abort')],
      [],
      repoDir,
      { remoteBranches: ['task/primary'], coolOffSeconds: 0 },
    );
    assert.equal(unblocked.eligible.length, 1);
    assert.equal(unblocked.blocked.length, 0);
  } finally {
    cleanup();
  }
});
