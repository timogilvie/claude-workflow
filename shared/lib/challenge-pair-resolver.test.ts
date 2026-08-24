import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('resolver is idempotent for orphaned pairs', async () => {
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
    const first = await resolveUnresolvablePair({ pairId: 'pair-1', repoDir, now });
    const second = await resolveUnresolvablePair({ pairId: 'pair-1', repoDir, now });

    assert.equal(first.status, 'resolved');
    assert.equal(second.status, 'already-resolved');
    assert.equal(readChallengeComparisons(join(repoDir, '.wavemill', 'evals')).length, 1);
  } finally {
    cleanup();
  }
});

test('resolver writes a forfeit for an orphaned pair with a completed survivor', async () => {
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

    const result = await resolveUnresolvablePair({
      pairId: 'pair-1',
      repoDir,
      reason: 'orphan-sibling',
      now: () => new Date('2026-07-17T12:00:00Z'),
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'forfeit');
    assert.equal(result.record.winner, 'primary');
    assert.equal(result.record.terminalReason, 'orphan_pair');
    assert.equal(result.record.noComparisonReason, 'challenger_never_launched');
  } finally {
    cleanup();
  }
});

test('resolver marks lone primary with launched challenger marker as orphan_pair', async () => {
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
        challengerLaunched: true,
      },
    });

    const result = await resolveUnresolvablePair({
      pairId: 'pair-1',
      repoDir,
      reason: 'orphan-sibling',
      now: () => new Date('2026-07-17T12:00:00Z'),
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'forfeit');
    assert.equal(result.record.winner, 'primary');
    assert.equal(result.record.terminalReason, 'orphan_pair');
    assert.equal(result.record.noComparisonReason, 'orphan_pair');
  } finally {
    cleanup();
  }
});

test('resolver repairs a blank primary role instead of writing an orphan forfeit', async () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      'HOK-2870': {
        pr: 1226,
        branch: 'task/eight-test-files',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'HOK-2870',
        challengeRole: '',
        challengeModel: 'gpt-5',
        evalCompleted: true,
      },
      'HOK-2870_c': {
        pr: 1225,
        branch: 'task/eight-test-files-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'HOK-2870',
        challengeRole: 'challenger',
        challengeModel: 'claude-sonnet-4',
        evalCompleted: true,
      },
    });

    const result = await resolveUnresolvablePair({
      pairId: 'HOK-2870',
      repoDir,
      reason: 'orphan-sibling',
      now: () => new Date('2026-07-17T12:00:00Z'),
    });

    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /manual repair|not currently unresolvable|requires manual repair/);
    assert.equal(readChallengeComparisons(join(repoDir, '.wavemill', 'evals')).length, 0);
    const state = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), 'utf-8'));
    assert.equal(state.tasks['HOK-2870'].challengeRole, 'primary');
  } finally {
    cleanup();
  }
});

test('resolver suppresses a non-decisive orphan record when no side completed eval', async () => {
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

    const result = await resolveUnresolvablePair({
      pairId: 'pair-1',
      repoDir,
      reason: 'orphan-sibling',
      now: () => new Date('2026-07-17T12:00:00Z'),
    });

    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /non-decisive stall record suppressed/);
    assert.equal(readChallengeComparisons(join(repoDir, '.wavemill', 'evals')).length, 0);
  } finally {
    cleanup();
  }
});

test('resolver writes a forfeit when one side exhausted eval hard-failure retries', async () => {
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

    const result = await resolveUnresolvablePair({
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

test('resolver writes a double-forfeit when both sides exhausted eval hard-failure retries', async () => {
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

    const result = await resolveUnresolvablePair({
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
  const { repoDir, cleanup } = setupRepoDir({ challenge: { autoMergeWinner: true } });
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

    const resolution = await resolveUnresolvablePair({
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

test('resolver auto-detects both aborted arms and forfeits to completed survivor', async () => {
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
        challengeAborted: 'terminal_stage_failure:tool-use-unsupported',
        challengeAbortedDetail: '404 No endpoints found that support tool use',
        challengeAbortedStage: 'coding',
      },
      HOK_1_c: {
        branch: 'task/primary-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-abort',
        challengeRole: 'challenger',
        challengeModel: 'qwen-2.5-coder-32b',
        challengeAborted: 'terminal_stage_failure:tool-use-unsupported',
        challengeAbortedDetail: '404 No endpoints found that support tool use.',
        challengeAbortedStage: 'coding',
      },
    });

    const result = await resolveUnresolvablePair({ pairId: 'pair-abort', repoDir });

    assert.equal(result.status, 'resolved');
    assert.equal(result.reason, 'both-challenge-aborted');
    assert.equal(result.outcome, 'forfeit');
    assert.equal(result.record.winner, 'primary');
    assert.equal(result.record.terminalReason, 'challenger_challenge_aborted');
    assert.equal(result.record.primaryEvalScore, null);
    assert.equal(result.record.challengerEvalScore, null);
    assert.equal(result.record.primaryCompleted, true);
    assert.equal(result.record.challengerCompleted, false);
    assert.equal(result.record.armFailures?.[1].model, 'qwen-2.5-coder-32b');
    assert.equal(result.record.armFailures?.[1].failureKind, 'tool-use-unsupported');
    assert.equal(result.record.armFailures?.[1].faultClass, 'selection-fault');
    assert.match(result.record.rationale, /qwen-2\.5-coder-32b/);
    assert.match(result.record.rationale, /tool-use-unsupported/);
    assert.doesNotMatch(result.record.rationale, /orphaned/);
  } finally {
    cleanup();
  }
});

test('resolver skips aborted pair when lone surviving PR has not persisted eval', async () => {
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
        challengeAborted: 'terminal_stage_failure:tool-use-unsupported',
        challengeAbortedDetail: '404 No endpoints found that support tool use',
        challengeAbortedStage: 'coding',
      },
    });

    const result = await resolveUnresolvablePair({ pairId: 'pair-abort', repoDir });

    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /surviving arm has not persisted an eval/);
    assert.equal(readChallengeComparisons(join(repoDir, '.wavemill', 'evals')).length, 0);
  } finally {
    cleanup();
  }
});

test('resolver writes forfeit when a sibling challenge-aborted and survivor completed eval', async () => {
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
        challengeAborted: 'terminal_stage_failure:tool-use-unsupported',
        challengeAbortedDetail: '404 No endpoints found that support tool use',
        challengeAbortedStage: 'coding',
      },
    });

    const result = await resolveUnresolvablePair({ pairId: 'pair-abort', repoDir });

    assert.equal(result.status, 'resolved');
    assert.equal(result.reason, 'sibling-challenge-aborted');
    assert.equal(result.outcome, 'forfeit');
    assert.equal(result.record.winner, 'primary');
    assert.equal(result.record.terminalReason, 'challenger_challenge_aborted');
    assert.equal(result.record.primaryEvalScore, null);
    assert.equal(result.record.challengerEvalScore, null);
    assert.equal(result.record.challengerCompleted, false);
    assert.equal(result.record.armFailures?.[0].model, 'qwen-2.5-coder-32b');
    assert.equal(result.record.armFailures?.[0].failureKind, 'tool-use-unsupported');
    assert.equal(result.record.armFailures?.[0].faultClass, 'selection-fault');
    assert.match(result.record.rationale, /qwen-2\.5-coder-32b/);
    assert.match(result.record.rationale, /tool-use-unsupported/);
  } finally {
    cleanup();
  }
});

test('resolver writes double-forfeit when both aborted arms have no completed evals but both produced PRs', async () => {
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

    const result = await resolveUnresolvablePair({ pairId: 'pair-abort', repoDir });

    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'double-forfeit');
    assert.equal(result.record.terminalReason, 'both_challenge_aborted');
  } finally {
    cleanup();
  }
});

test('resolver and gate agree on aborted pair reason and unblock after resolution', async () => {
  const { repoDir, cleanup } = setupRepoDir({ challenge: { autoMergeWinner: true } });
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

    const resolution = await resolveUnresolvablePair({ pairId: 'pair-abort', repoDir });
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
test('resolver treats a removed primary with stale refs as orphan-sibling', async () => {
  const { repoDir, cleanup } = setupRepoDir({ challenge: { autoMergeWinner: true } });
  try {
    writeWorkflowState(repoDir, {
      HOK_1_c: {
        pr: 1130,
        branch: 'task/challenge-intent-is-rewritten-challenger',
        updated: '2026-08-17T12:00:00Z',
        challengePairId: 'pair-2767',
        challengeRole: 'challenger',
        challengeModel: 'claude-opus-4-8',
        evalCompleted: true,
      },
    });

    const resolution = await resolveUnresolvablePair({
      pairId: 'pair-2767',
      repoDir,
      remoteBranches: [
        'task/challenge-intent-is-rewritten',
        'task/challenge-intent-is-rewritten-challenger',
      ],
      now: () => new Date('2026-08-17T12:02:00Z'),
    });

    assert.equal(resolution.status, 'resolved');
    assert.equal(resolution.reason, 'orphan-sibling');
    assert.equal(resolution.outcome, 'forfeit');
    assert.equal(resolution.record.winner, 'challenger');

    const gate = await applyChallengePairGates(
      [makeWorkItem(1130, 'task/challenge-intent-is-rewritten-challenger', 'pair-2767')],
      [],
      repoDir,
      {
        remoteBranches: [
          'task/challenge-intent-is-rewritten',
          'task/challenge-intent-is-rewritten-challenger',
        ],
        coolOffSeconds: 0,
      },
    );

    assert.equal(gate.eligible.length, 1);
    assert.equal(gate.eligible[0].pr.number, 1130);
    assert.equal(gate.blocked.length, 0);
  } finally {
    cleanup();
  }
});

test('resolver keeps both tracked arms unresolved even with stale refs', async () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1: {
        pr: 101,
        branch: 'task/pair-primary',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
      },
      HOK_1_c: {
        pr: 102,
        branch: 'task/pair-primary-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'challenger',
        challengeModel: 'claude-opus-4-8',
        evalCompleted: true,
      },
    });

    const result = await resolveUnresolvablePair({
      pairId: 'pair-1',
      repoDir,
      remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
      now: () => new Date('2026-07-01T00:02:00Z'),
    });

    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /not currently unresolvable/);
  } finally {
    cleanup();
  }
});

test('resolver dry run reports orphan-sibling without writing a comparison', async () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_1_c: {
        pr: 102,
        branch: 'task/pair-primary-challenger',
        updated: '2026-07-01T00:00:00Z',
        challengePairId: 'pair-1',
        challengeRole: 'challenger',
        challengeModel: 'claude-opus-4-8',
        evalCompleted: true,
      },
    });

    const result = await resolveUnresolvablePair({
      pairId: 'pair-1',
      repoDir,
      dryRun: true,
      remoteBranches: ['task/pair-primary', 'task/pair-primary-challenger'],
      now: () => new Date('2026-07-01T00:02:00Z'),
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.dryRun, true);
    assert.equal(readChallengeComparisons(join(repoDir, '.wavemill', 'evals')).length, 0);
  } finally {
    cleanup();
  }
});
