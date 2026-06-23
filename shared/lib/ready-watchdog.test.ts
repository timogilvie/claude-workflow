import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  classifyReadyTask,
  normalizeDetailFingerprint,
  tickReadyWatchdog,
  type GitHubPRTruth,
  type ReadyTaskSnapshot,
} from './ready-watchdog.ts';

function makeSnapshot(overrides: Partial<ReadyTaskSnapshot> = {}): ReadyTaskSnapshot {
  return {
    issueId: 'HOK-1579',
    slug: 'ready-watchdog-task',
    branch: 'task/ready-watchdog-task',
    worktree: '/tmp/worktree',
    prNumber: 528,
    controllerPhase: 'ready',
    controllerUpdatedAt: '2026-05-05T12:00:00.000Z',
    currentAgent: 'codex',
    currentModel: 'gpt-5.5',
    challengePairId: null,
    readyStateDir: '/tmp/worktree/features/ready-watchdog-task',
    readyResult: null,
    readyArtifacts: null,
    readyResultStatus: 'running',
    readyVerdict: 'fail',
    readyAttentionDetail: null,
    hasNeedsAttention: false,
    hasConflictMarker: false,
    remediationLaunchHead: null,
    currentHead: 'head-sha',
    remediationPaneActive: null,
    worktreeMergeState: {
      mergeHead: null,
      unmergedPaths: [],
      stagedPaths: [],
      unstagedPaths: [],
      untrackedPaths: [],
      rawStatus: [],
    },
    relevantJobs: [],
    lastProgressAt: '2026-05-05T12:00:00.000Z',
    idleMinutes: 30,
    ...overrides,
  };
}

function makeTruth(overrides: Partial<GitHubPRTruth> = {}): GitHubPRTruth {
  return {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [
      { name: 'build', status: 'success', rawStatus: 'SUCCESS' },
    ],
    ...overrides,
  };
}

function setupReadyTask(issueId = 'HOK-1579', prNumber = 528): {
  repoDir: string;
  stateDir: string;
  stateFile: string;
  worktree: string;
  featureDir: string;
} {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      [issueId]: {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: prNumber,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'codex',
        model: 'gpt-5.5',
      },
    },
    jobs: {},
  }, null, 2));

  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pending', prNumber },
  }, null, 2));

  return { repoDir, stateDir, stateFile, worktree, featureDir };
}

const WATCHDOG_CONFIG = {
  enabled: true,
  thresholdMinutes: 10,
  autoRecover: true,
  timeoutSeconds: 30,
} as const;

test('classify clean green stale ready as stuck', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'stuck');
  assert.equal(classification.autoRecoverable, true);
});

test('normalizeDetailFingerprint stabilizes merge-lane idle minutes but keeps PR identity', () => {
  const stalled83 = normalizeDetailFingerprint(
    'Merge lane appears stalled: PR #805 passed ready and has waited 83m for its merge turn without the lane advancing.',
  );
  const stalled84 = normalizeDetailFingerprint(
    'Merge lane appears stalled: PR #805 passed ready and has waited 84m for its merge turn without the lane advancing.',
  );
  const stalledOtherPr = normalizeDetailFingerprint(
    'Merge lane appears stalled: PR #806 passed ready and has waited 84m for its merge turn without the lane advancing.',
  );
  const waiting83 = normalizeDetailFingerprint(
    'PR #805 passed ready and is waiting its turn in the merge lane (idle 83m).',
  );
  const waiting84 = normalizeDetailFingerprint(
    'PR #805 passed ready and is waiting its turn in the merge lane (idle 84m).',
  );

  assert.equal(stalled83, stalled84);
  assert.notEqual(stalled83, stalledOtherPr);
  assert.equal(waiting83, waiting84);
});

test('classify clean green PR parked in merge lane as waiting-on-merge-lane (not stuck)', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'ready-stale' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  // Parked-and-waiting must not be auto-recovered (no needless ready re-run).
  assert.equal(classification.kind, 'waiting-on-merge-lane');
  assert.notEqual(classification.autoRecoverable, true);
});

test('escalate a long-parked merge-lane PR to needs-user (lane stalled)', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 35, // >= thresholdMinutes(10) * 3
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'ready-stale' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /merge lane appears stalled/i);
});

test('a selected merge candidate that is clean green classifies as waiting-on-merge-lane (not stuck)', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  // A merge-candidate PR is in the lane waiting for the merge — auto-recovering
  // it just re-runs ready checks that will pass again, re-arming the watchdog
  // every 10 minutes indefinitely.
  assert.equal(classification.kind, 'waiting-on-merge-lane');
  assert.notEqual(classification.autoRecoverable, true);
});

test('a long-idle merge candidate escalates to needs-user (lane stalled)', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 35, // >= thresholdMinutes(10) * 3
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /merge lane appears stalled/i);
});

test('a completed-ready PR (queueState=ready) with clean green classifies as waiting-on-merge-lane', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      readyResultStatus: 'completed',
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'ready' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  // PR passed checks against current base, not yet selected by the merge queue.
  // Auto-recovering it is needless — the queue will select it on the next tick.
  assert.equal(classification.kind, 'waiting-on-merge-lane');
  assert.notEqual(classification.autoRecoverable, true);
});

test('a running-ready PR with queueState=ready and clean green still classifies as stuck', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      readyResultStatus: 'running',
      readyArtifacts: { type: 'ready', verdict: 'pending', queueState: 'ready' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  // A running (not completed) ready stage with queueState=ready is unexpected
  // for a clean/green PR — classify as stuck so the controller can recover it.
  assert.equal(classification.kind, 'stuck');
});

test('classify failing CI as waiting-on-ci', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'build', status: 'failure', rawStatus: 'FAILURE' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'waiting-on-ci');
  assert.match(classification.detail, /Failing checks/);
});

test('classify pending CI as waiting-on-ci', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'build', status: 'pending', rawStatus: 'PENDING' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'waiting-on-ci');
  assert.match(classification.detail, /pending/);
});

test('classify completed failing CI as auto-remediable waiting-on-ci', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'waiting-on-ci');
  assert.equal(classification.autoRemediable, true);
});

test('classify stable safe failing CI as stable-failing-safe after repeated polls', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'lint', status: 'failure', rawStatus: 'FAILURE' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
      stableFailureConsecutivePolls: 2,
      stableFailureEscalateAfterPolls: 4,
      safeRemediationCategories: ['lint', 'type', 'test', 'build', 'migration-chain', 'alembic'],
    },
    {
      issueId: 'HOK-1579',
      slug: 'ready-watchdog-task',
      prNumber: 528,
      classification: 'waiting-on-ci',
      displayLabel: 'waiting on CI',
      detail: 'Failing checks: lint (FAILURE).',
      action: 'reported',
      updatedAt: '2026-05-05T12:20:00.000Z',
      idleMinutes: 20,
      lastProgressAt: '2026-05-05T12:00:00.000Z',
      prStateKey: 'OPEN|MERGEABLE|CLEAN',
      detailFingerprint: 'Failing checks: lint (FAILURE).',
      consecutiveFailurePolls: 1,
    },
  );

  assert.equal(classification.kind, 'stable-failing-safe');
  assert.deepEqual(classification.remediationCategories, ['lint (FAILURE)']);
  assert.equal(classification.autoRemediable, true);
});

test('classify resets consecutiveFailurePolls when prStateKey changes between polls', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'lint', status: 'failure', rawStatus: 'FAILURE' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
      stableFailureConsecutivePolls: 2,
      stableFailureEscalateAfterPolls: 4,
      safeRemediationCategories: ['lint', 'type', 'test', 'build', 'migration-chain', 'alembic'],
    },
    {
      issueId: 'HOK-1579',
      slug: 'ready-watchdog-task',
      prNumber: 528,
      classification: 'waiting-on-ci',
      displayLabel: 'waiting on CI',
      detail: 'Failing checks: lint (FAILURE).',
      action: 'reported',
      updatedAt: '2026-05-05T12:20:00.000Z',
      idleMinutes: 20,
      lastProgressAt: '2026-05-05T12:00:00.000Z',
      prStateKey: 'OPEN|UNKNOWN|UNKNOWN',
      detailFingerprint: 'Failing checks: lint (FAILURE).',
      consecutiveFailurePolls: 5,
    },
  );

  assert.equal(classification.kind, 'waiting-on-ci');
  assert.equal(classification.consecutiveFailurePolls, 1);
});

test('classify repeated unsafe failing CI as needs-user after the escalation threshold', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'deploy', status: 'failure', rawStatus: 'FAILURE' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
      stableFailureConsecutivePolls: 2,
      stableFailureEscalateAfterPolls: 3,
      safeRemediationCategories: ['lint', 'type', 'test', 'build', 'migration-chain', 'alembic'],
    },
    {
      issueId: 'HOK-1579',
      slug: 'ready-watchdog-task',
      prNumber: 528,
      classification: 'waiting-on-ci',
      displayLabel: 'waiting on CI',
      detail: 'Failing checks: deploy (FAILURE).',
      action: 'reported',
      updatedAt: '2026-05-05T12:20:00.000Z',
      idleMinutes: 20,
      lastProgressAt: '2026-05-05T12:00:00.000Z',
      prStateKey: 'OPEN|MERGEABLE|CLEAN',
      detailFingerprint: 'Failing checks: deploy (FAILURE).',
      consecutiveFailurePolls: 2,
    },
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /unsafe/);
});

test('classify active eval or comparison as waiting-on-eval-comparison', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      relevantJobs: [{
        id: 'eval-HOK-1579-primary-528',
        kind: 'eval',
        issueId: 'HOK-1579',
        side: 'primary',
        pairId: undefined,
        prNumbers: [528],
        pid: 1,
        startedAt: '2026-05-05T12:10:00.000Z',
        timeoutSeconds: 600,
        logPath: '/tmp/eval.log',
        resultPath: '/tmp/eval.json',
        status: 'running',
        exitCode: null,
        finishedAt: null,
        reason: null,
        excerpt: null,
        settled: false,
      }],
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'waiting-on-eval-comparison');
});

test('classify real conflict as needs-user', () => {
  const classification = classifyReadyTask(
    makeSnapshot({ hasConflictMarker: true }),
    makeTruth({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /merge conflicts/);
});

test('classify disconnected resolved merge remediation as auto-resumable', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      hasConflictMarker: true,
      readyResultStatus: 'running',
      remediationLaunchHead: 'head-sha',
      currentHead: 'head-sha',
      remediationPaneActive: false,
      worktreeMergeState: {
        mergeHead: 'base-sha',
        unmergedPaths: [],
        stagedPaths: ['package.json'],
        unstagedPaths: [],
        untrackedPaths: [],
        rawStatus: ['M  package.json'],
      },
    }),
    makeTruth({ mergeStateStatus: 'DIRTY' }),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'disconnected-remediation');
  assert.equal(classification.autoRecoverable, true);
  assert.match(classification.detail, /package\.json/);
});

test('classify disconnected unresolved merge remediation as needs-user with next command', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      hasConflictMarker: true,
      readyResultStatus: 'running',
      remediationLaunchHead: 'head-sha',
      currentHead: 'head-sha',
      remediationPaneActive: false,
      worktreeMergeState: {
        mergeHead: 'base-sha',
        unmergedPaths: ['package.json'],
        stagedPaths: [],
        unstagedPaths: [],
        untrackedPaths: [],
        rawStatus: ['UU package.json'],
      },
    }),
    makeTruth({ mergeStateStatus: 'DIRTY' }),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /MERGE_HEAD=base-sha/);
  assert.match(classification.detail, /unmerged=package\.json/);
  assert.match(classification.detail, /Next command: cd/);
});

test('classify mergeable behind PR as auto-update eligible', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({ mergeStateStatus: 'BEHIND', baseRefName: 'auto/integration' }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'auto-update');
  assert.match(classification.detail, /behind auto\/integration/);
});

test('tick auto-recovers stale local state for clean green PRs', async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    updated: '2026-05-05T12:00:00.000Z',
    tasks: {
      'HOK-1579': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: 528,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'codex',
        model: 'gpt-5.5',
      },
    },
    jobs: {},
  }, null, 2));
  writeFileSync(path.join(featureDir, '.needs-attention'), 'stale local state\n');
  writeFileSync(path.join(featureDir, '.conflict-detected'), '');
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: 'Ready checks failed',
    artifacts: {
      type: 'ready',
      verdict: 'fail',
      prNumber: 528,
      remediationLaunchHead: 'old-head',
    },
  }, null, 2));

  const result = await tickReadyWatchdog({
    repoDir,
    stateFile,
    config: {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
    deps: {
      fetchGitHubTruth: async () => makeTruth(),
      getCurrentHead: async () => 'new-head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].classification, 'stuck');
  assert.equal(result.findings[0].action, 'auto-recovered');
  assert.equal(existsSync(path.join(featureDir, '.needs-attention')), false);
  assert.equal(existsSync(path.join(featureDir, '.conflict-detected')), false);

  const readyResult = JSON.parse(readFileSync(path.join(featureDir, '.ready-result.json'), 'utf-8')) as {
    status: string;
    artifacts: { verdict: string };
  };
  assert.equal(readyResult.status, 'running');
  assert.equal(readyResult.artifacts.verdict, 'pending');

  const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
    tasks: Record<string, { action: string; failingChecksFingerprint?: string }>;
  };
  assert.equal(watchdogState.tasks['HOK-1579'].action, 'auto-recovered');
  assert.equal(watchdogState.tasks['HOK-1579'].failingChecksFingerprint, undefined);

  await rm(repoDir, { recursive: true, force: true });
});

test('tick completes disconnected resolved conflict remediation', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2268', 2268);
  writeFileSync(path.join(featureDir, '.conflict-detected'), '');
  writeFileSync(path.join(featureDir, '.needs-attention'), 'stale conflict detail\n');
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: 'Conflict remediation in progress',
    artifacts: {
      type: 'ready',
      verdict: 'pending',
      prNumber: 2268,
      mergeConflict: 'CONFLICTED',
      launchHead: 'head-1',
    },
  }, null, 2));
  let resumed = false;

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'DIRTY' }),
        getCurrentHead: async () => 'head-1',
        getWorktreeMergeState: async () => ({
          mergeHead: 'base-sha',
          unmergedPaths: [],
          stagedPaths: ['package.json'],
          unstagedPaths: [],
          untrackedPaths: [],
          rawStatus: ['M  package.json'],
        }),
        isTaskPaneActive: async () => false,
        resumeResolvedConflictRemediation: async () => {
          resumed = true;
          return { status: 'completed', detail: 'Committed and pushed resolved conflict remediation for PR #2268.' };
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(resumed, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'disconnected-remediation');
    assert.equal(result.findings[0].action, 'completed-conflict-remediation');
    assert.equal(existsSync(path.join(featureDir, '.conflict-detected')), false);
    assert.equal(existsSync(path.join(featureDir, '.needs-attention')), false);

    const readyResult = JSON.parse(readFileSync(path.join(featureDir, '.ready-result.json'), 'utf-8')) as {
      status: string;
      artifacts: { verdict: string; launchHead?: string };
    };
    assert.equal(readyResult.status, 'running');
    assert.equal(readyResult.artifacts.verdict, 'pending');
    assert.equal(readyResult.artifacts.launchHead, undefined);

    const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { action: string }>;
    };
    assert.equal(watchdogState.tasks['HOK-2268'].action, 'completed-conflict-remediation');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick writes needs-attention for disconnected unsafe merge remediation', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2268', 2268);
  writeFileSync(path.join(featureDir, '.conflict-detected'), '');
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: 'Conflict remediation in progress',
    artifacts: {
      type: 'ready',
      verdict: 'pending',
      prNumber: 2268,
      mergeConflict: 'CONFLICTED',
      launchHead: 'head-1',
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'DIRTY' }),
        getCurrentHead: async () => 'head-1',
        getWorktreeMergeState: async () => ({
          mergeHead: 'base-sha',
          unmergedPaths: ['package.json'],
          stagedPaths: [],
          unstagedPaths: [],
          untrackedPaths: [],
          rawStatus: ['UU package.json'],
        }),
        isTaskPaneActive: async () => false,
        resumeResolvedConflictRemediation: async () => {
          throw new Error('should not resume unsafe merge');
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'needs-user');
    assert.equal(result.findings[0].action, 'needs-user');
    const attention = readFileSync(path.join(featureDir, '.needs-attention'), 'utf-8');
    assert.match(attention, /unmerged=package\.json/);
    assert.match(attention, /Next command:/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick launches remediation on stable completed failure', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-2039', 2039);
  const readyWatchdogToolPath = '/opt/wavemill/tools/ready-watchdog.ts';
  const launches: Array<{ summary: string; names: string[]; attemptNumber: number; maxAttempts: number; toolPath: string }> = [];

  try {
    const deps = {
      fetchGitHubTruth: async () => makeTruth({
        checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE' }],
      }),
      getCurrentHead: async () => 'head-1',
      launchReadyRemediation: async (
        _snapshot: ReadyTaskSnapshot,
        failedCheckSummary: string,
        failedCheckNames: string[],
        attemptNumber: number,
        maxAttempts: number,
        _repoDir: string,
        toolPath: string,
      ) => {
        launches.push({ summary: failedCheckSummary, names: failedCheckNames, attemptNumber, maxAttempts, toolPath });
        return {
          status: 'launched' as const,
          detail: `Launched ready remediation attempt ${attemptNumber}/${maxAttempts} for failing checks: ${failedCheckSummary}.`,
          attemptNumber,
          launchHead: 'head-1',
        };
      },
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    };

    const first = await tickReadyWatchdog({ repoDir, stateFile, config: WATCHDOG_CONFIG, deps });
    assert.equal(first.findings.length, 1);
    assert.equal(first.findings[0].action, 'waiting-on-ci-stabilizing');
    assert.equal(launches.length, 0);

    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      readyWatchdogToolPath,
      deps: { ...deps, now: () => new Date('2030-05-05T12:31:00.000Z') },
    });
    assert.equal(second.findings.length, 1);
    assert.equal(second.findings[0].action, 'launched-remediation');
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0], {
      summary: 'Alembic Check (FAILURE)',
      names: ['Alembic Check'],
      attemptNumber: 1,
      maxAttempts: 3,
      toolPath: readyWatchdogToolPath,
    });

    const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { failingChecksObservedCount?: number; action: string }>;
    };
    assert.equal(watchdogState.tasks['HOK-2039'].failingChecksObservedCount, 2);
    assert.equal(watchdogState.tasks['HOK-2039'].action, 'launched-remediation');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick does not launch remediation while checks are still pending', async () => {
  const { repoDir, stateFile } = setupReadyTask('HOK-2039', 2039);
  let launchCalled = false;

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [
            { name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE' },
            { name: 'Unit Tests', status: 'pending', rawStatus: 'IN_PROGRESS' },
          ],
        }),
        getCurrentHead: async () => 'head-1',
        launchReadyRemediation: async () => {
          launchCalled = true;
          return { status: 'failed', detail: 'unexpected', attemptNumber: 1 };
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'reported');
    assert.equal(launchCalled, false);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick respects same-head remediation in-flight guard', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2039', 2039);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'fail', prNumber: 2039, remediationAttempts: 1, remediationLaunchHead: 'head-1' },
  }, null, 2));
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-2039': {
        issueId: 'HOK-2039',
        slug: 'ready-watchdog-task',
        prNumber: 2039,
        classification: 'waiting-on-ci',
        displayLabel: 'waiting on CI',
        detail: 'prior',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
        failingChecksFingerprint: 'alembic check:failure',
        failingChecksObservedCount: 1,
      },
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE' }],
        }),
        getCurrentHead: async () => 'head-1',
        launchReadyRemediation: async () => {
          throw new Error('should not launch');
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'remediation-in-flight');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick respects remediation max attempts', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2039', 2039);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'fail', prNumber: 2039, remediationAttempts: 3 },
  }, null, 2));
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-2039': {
        issueId: 'HOK-2039',
        slug: 'ready-watchdog-task',
        prNumber: 2039,
        classification: 'waiting-on-ci',
        displayLabel: 'waiting on CI',
        detail: 'prior',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
        failingChecksFingerprint: 'alembic check:failure',
        failingChecksObservedCount: 1,
      },
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE' }],
        }),
        getCurrentHead: async () => 'head-2',
        launchReadyRemediation: async () => {
          throw new Error('should not launch');
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'remediation-exhausted');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick relaunches remediation when head advances past prior launch head', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2039', 2039);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'fail', prNumber: 2039, remediationAttempts: 1, remediationLaunchHead: 'head-1' },
  }, null, 2));
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-2039': {
        issueId: 'HOK-2039',
        slug: 'ready-watchdog-task',
        prNumber: 2039,
        classification: 'waiting-on-ci',
        displayLabel: 'waiting on CI',
        detail: 'prior',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
        failingChecksFingerprint: 'alembic check:failure',
        failingChecksObservedCount: 1,
      },
    },
  }, null, 2));
  const launches: Array<{ attemptNumber: number }> = [];

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE' }],
        }),
        getCurrentHead: async () => 'head-2',
        launchReadyRemediation: async (_snapshot, _summary, _names, attemptNumber, maxAttempts) => {
          launches.push({ attemptNumber });
          return {
            status: 'launched' as const,
            detail: `Launched ready remediation attempt ${attemptNumber}/${maxAttempts} for PR #2039.`,
            attemptNumber,
            launchHead: 'head-2',
          };
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'launched-remediation');
    assert.equal(launches.length, 1);
    assert.equal(launches[0].attemptNumber, 2);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick surfaces remediation launch failures', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-2039', 2039);
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-2039': {
        issueId: 'HOK-2039',
        slug: 'ready-watchdog-task',
        prNumber: 2039,
        classification: 'waiting-on-ci',
        displayLabel: 'waiting on CI',
        detail: 'prior',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
        failingChecksFingerprint: 'alembic check:failure',
        failingChecksObservedCount: 1,
      },
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE' }],
        }),
        getCurrentHead: async () => 'head-2',
        launchReadyRemediation: async () => ({
          status: 'failed',
          detail: 'Failed to launch ready remediation attempt 1/3 for PR #2039.',
          attemptNumber: 1,
        }),
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'remediation-launch-failed');
    assert.match(result.findings[0].detail, /Failed to launch ready remediation attempt 1\/3/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick suppresses repeated needs-user when classification and detail are unchanged', async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-1581': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: 541,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
      },
    },
    jobs: {},
  }, null, 2));
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pending', prNumber: 541 },
  }, null, 2));

  const tickOptions = {
    repoDir,
    stateFile,
    config: {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: false,
      timeoutSeconds: 30,
    },
    deps: {
      fetchGitHubTruth: async () => makeTruth({ state: 'MERGED' }),
      getCurrentHead: async () => 'head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  };

  const first = await tickReadyWatchdog(tickOptions);
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0].classification, 'needs-user');

  const second = await tickReadyWatchdog(tickOptions);
  assert.equal(second.findings.length, 0, 'repeated needs-user should be suppressed on second tick');

  await rm(repoDir, { recursive: true, force: true });
});

test('tick suppresses repeated stalled merge-lane findings while keeping state fresh', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2298', 805);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-05-05T11:00:00.000Z',
    finishedAt: '2030-05-05T11:01:00.000Z',
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 805, queueState: 'ready-stale' },
  }, null, 2));

  try {
    const baseDeps = {
      fetchGitHubTruth: async () => makeTruth(),
      getCurrentHead: async () => 'head',
    };

    const first = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        ...baseDeps,
        now: () => new Date('2030-05-05T11:35:00.000Z'),
      },
    });
    assert.equal(first.findings.length, 1);
    assert.equal(first.findings[0].classification, 'needs-user');

    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        ...baseDeps,
        now: () => new Date('2030-05-05T11:36:00.000Z'),
      },
    });
    assert.equal(second.findings.length, 0);

    const auditRows = readFileSync(path.join(stateDir, 'ready-watchdog.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(auditRows.length, 1);

    const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, ReadyWatchdogStateEntry>;
    };
    assert.match(watchdogState.tasks['HOK-2298'].detail, /35m/);
    assert.equal(watchdogState.tasks['HOK-2298'].lastLoggedAt, '2030-05-05T11:35:00.000Z');
    assert.equal(
      watchdogState.tasks['HOK-2298'].lastLoggedFingerprint,
      normalizeDetailFingerprint(first.findings[0].detail),
    );
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick suppresses repeated waiting-on-merge-lane findings while keeping state fresh', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2298_c', 806);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-05-05T11:00:00.000Z',
    finishedAt: '2030-05-05T11:01:00.000Z',
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 806, queueState: 'merge-candidate' },
  }, null, 2));

  try {
    const baseDeps = {
      fetchGitHubTruth: async () => makeTruth(),
      getCurrentHead: async () => 'head',
    };

    const first = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        ...baseDeps,
        now: () => new Date('2030-05-05T11:16:00.000Z'),
      },
    });
    assert.equal(first.findings.length, 1);
    assert.equal(first.findings[0].classification, 'waiting-on-merge-lane');

    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        ...baseDeps,
        now: () => new Date('2030-05-05T11:17:00.000Z'),
      },
    });
    assert.equal(second.findings.length, 0);

    const auditRows = readFileSync(path.join(stateDir, 'ready-watchdog.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(auditRows.length, 1);

    const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, ReadyWatchdogStateEntry>;
    };
    assert.match(watchdogState.tasks['HOK-2298_c'].detail, /16m/);
    assert.equal(watchdogState.tasks['HOK-2298_c'].lastLoggedAt, '2030-05-05T11:16:00.000Z');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick re-emits merge-lane findings after the relog interval', async () => {
  const originalRelogSeconds = process.env.READY_WATCHDOG_RELOG_SECONDS;
  process.env.READY_WATCHDOG_RELOG_SECONDS = '3600';
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2298', 805);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-05-05T11:00:00.000Z',
    finishedAt: '2030-05-05T11:01:00.000Z',
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 805, queueState: 'ready-stale' },
  }, null, 2));

  try {
    const baseDeps = {
      fetchGitHubTruth: async () => makeTruth(),
      getCurrentHead: async () => 'head',
    };

    const first = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        ...baseDeps,
        now: () => new Date('2030-05-05T11:35:00.000Z'),
      },
    });
    assert.equal(first.findings.length, 1);

    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        ...baseDeps,
        now: () => new Date('2030-05-05T12:34:59.000Z'),
      },
    });
    assert.equal(second.findings.length, 0);

    const third = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        ...baseDeps,
        now: () => new Date('2030-05-05T12:35:00.000Z'),
      },
    });
    assert.equal(third.findings.length, 1);

    const auditRows = readFileSync(path.join(stateDir, 'ready-watchdog.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(auditRows.length, 2);
    const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, ReadyWatchdogStateEntry>;
    };
    assert.equal(watchdogState.tasks['HOK-2298'].lastLoggedAt, '2030-05-05T12:35:00.000Z');
  } finally {
    if (originalRelogSeconds === undefined) {
      delete process.env.READY_WATCHDOG_RELOG_SECONDS;
    } else {
      process.env.READY_WATCHDOG_RELOG_SECONDS = originalRelogSeconds;
    }
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick re-emits and refreshes log fingerprint when a material classification change occurs', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2298', 805);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-05-05T11:00:00.000Z',
    finishedAt: '2030-05-05T11:01:00.000Z',
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 805, queueState: 'ready-stale' },
  }, null, 2));

  const priorWaitingDetail = 'PR #805 passed ready and is waiting its turn in the merge lane (idle 15m).';
  const priorFingerprint = normalizeDetailFingerprint(priorWaitingDetail);
  const watchdogStatePath = path.join(stateDir, 'ready-watchdog-state.json');
  writeFileSync(watchdogStatePath, JSON.stringify({
    updatedAt: '2030-05-05T11:16:00.000Z',
    tasks: {
      'HOK-2298': {
        issueId: 'HOK-2298',
        slug: 'ready-watchdog-task',
        prNumber: 805,
        classification: 'waiting-on-merge-lane',
        displayLabel: 'waiting on merge lane',
        detail: priorWaitingDetail,
        action: 'reported',
        updatedAt: '2030-05-05T11:16:00.000Z',
        idleMinutes: 15,
        lastProgressAt: '2030-05-05T11:01:00.000Z',
        prStateKey: 'OPEN|MERGEABLE|CLEAN',
        detailFingerprint: priorFingerprint,
        lastReportedAction: 'reported',
        lastLoggedFingerprint: priorFingerprint,
        lastLoggedAt: '2030-05-05T11:16:00.000Z',
      },
    },
  }, null, 2));

  try {
    // 35m idle is past the 3x escalation threshold, so the classification
    // must flip from waiting-on-merge-lane to needs-user. That material change
    // has to bypass suppression, re-emit, and refresh lastLoggedFingerprint
    // and lastLoggedAt to reflect the new finding.
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth(),
        getCurrentHead: async () => 'head',
        now: () => new Date('2030-05-05T11:36:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'needs-user');
    assert.match(result.findings[0].detail, /merge lane appears stalled/i);

    const watchdogState = JSON.parse(readFileSync(watchdogStatePath, 'utf-8')) as {
      tasks: Record<string, ReadyWatchdogStateEntry>;
    };
    const entry = watchdogState.tasks['HOK-2298'];
    assert.equal(entry.classification, 'needs-user');
    assert.equal(entry.lastLoggedAt, '2030-05-05T11:36:00.000Z');
    assert.notEqual(entry.lastLoggedFingerprint, priorFingerprint);
    assert.equal(entry.lastLoggedFingerprint, normalizeDetailFingerprint(result.findings[0].detail));
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick re-surfaces needs-user when detail changes', async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-1581': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: 541,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
      },
    },
    jobs: {},
  }, null, 2));
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pending', prNumber: 541 },
  }, null, 2));

  // Seed prior state with an old needs-user entry for the same issue
  const watchdogStatePath = path.join(stateDir, 'ready-watchdog-state.json');
  writeFileSync(watchdogStatePath, JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-1581': {
        issueId: 'HOK-1581',
        slug: 'ready-watchdog-task',
        prNumber: 541,
        classification: 'needs-user',
        displayLabel: 'needs user',
        detail: 'PR #541 is merged, so ready cannot advance automatically.',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
      },
    },
  }, null, 2));

  // Tick with different GitHub state (CLOSED instead of MERGED) → different detail string
  const result = await tickReadyWatchdog({
    repoDir,
    stateFile,
    config: {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: false,
      timeoutSeconds: 30,
    },
    deps: {
      fetchGitHubTruth: async () => makeTruth({ state: 'CLOSED' }),
      getCurrentHead: async () => 'head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  });

  assert.equal(result.findings.length, 1, 'changed detail should re-surface the finding');
  assert.match(result.findings[0].detail, /closed/i);

  await rm(repoDir, { recursive: true, force: true });
});

test('tick ignores merged tasks still held in ready phase for review', async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-1579': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: 528,
        phase: 'ready',
        status: 'merged',
        updated: '2026-05-05T12:00:00.000Z',
      },
    },
    jobs: {},
  }, null, 2));
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: '2026-05-05T12:00:00.000Z',
    artifacts: {
      type: 'ready',
      verdict: 'pass',
      prNumber: 528,
    },
  }, null, 2));

  let queriedGitHub = false;
  const result = await tickReadyWatchdog({
    repoDir,
    stateFile,
    config: {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
    deps: {
      fetchGitHubTruth: async () => {
        queriedGitHub = true;
        return makeTruth({ state: 'MERGED' });
      },
      getCurrentHead: async () => 'head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  });

  assert.equal(result.findings.length, 0);
  assert.equal(queriedGitHub, false);

  await rm(repoDir, { recursive: true, force: true });
});

test('tick surfaces a manual recovery command when auto-recover is disabled', async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const readyWatchdogToolPath = '/opt/wavemill/tools/ready-watchdog.ts';
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-1579': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: 528,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
      },
    },
    jobs: {},
  }, null, 2));
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: 'Ready checks failed',
    artifacts: {
      type: 'ready',
      verdict: 'fail',
      prNumber: 528,
    },
  }, null, 2));

  const result = await tickReadyWatchdog({
    repoDir,
    stateFile,
    config: {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: false,
      timeoutSeconds: 30,
    },
    readyWatchdogToolPath,
    deps: {
      fetchGitHubTruth: async () => makeTruth(),
      getCurrentHead: async () => 'head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  });

  assert.equal(result.findings[0].action, 'recovery-command');
  assert.match(result.findings[0].recoveryCommand ?? '', /--recover 'HOK-1579'/);
  assert.match(result.findings[0].recoveryCommand ?? '', /'\/opt\/wavemill\/tools\/ready-watchdog\.ts'/);
  assert.ok(
    !(result.findings[0].recoveryCommand ?? '').includes(path.join(repoDir, 'tools', 'ready-watchdog.ts')),
    'recovery command should not point at the target repo tools directory',
  );

  await rm(repoDir, { recursive: true, force: true });
});

test('tick auto-updates mergeable behind PRs and resets ready state without reporting needs-user', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-1716', 716);
  let updateCalls = 0;

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          mergeStateStatus: 'BEHIND',
          headRefName: 'task/ready-watchdog-task',
          baseRefName: 'auto/integration',
        }),
        getCurrentHead: async () => 'head',
        updateBehindBranch: async () => {
          updateCalls += 1;
          return {
            status: 'success',
            detail: 'updated task/ready-watchdog-task with origin/auto/integration',
          };
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(updateCalls, 1);
    assert.equal(result.findings.length, 0);
    const readyResult = JSON.parse(readFileSync(path.join(featureDir, '.ready-result.json'), 'utf-8')) as {
      status: string;
      notes: string;
      artifacts: { verdict: string };
    };
    assert.equal(readyResult.status, 'running');
    assert.equal(readyResult.artifacts.verdict, 'pending');
    assert.match(readyResult.notes, /updated the PR branch/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick escalates auto-update conflicts as needs-user with git output', async () => {
  const { repoDir, stateFile } = setupReadyTask('HOK-1716', 716);

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          mergeStateStatus: 'BEHIND',
          baseRefName: 'auto/integration',
        }),
        getCurrentHead: async () => 'head',
        updateBehindBranch: async () => ({
          status: 'conflict',
          detail: 'CONFLICT (content): merge conflict in shared/lib/ready-watchdog.ts',
        }),
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'needs-user');
    assert.match(result.findings[0].detail, /CONFLICT \(content\)/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick retries push failures, defaults missing attempts to zero, and exhausts after three attempts', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-1716', 716);
  const watchdogStatePath = path.join(stateDir, 'ready-watchdog-state.json');
  writeFileSync(watchdogStatePath, JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-1716': {
        issueId: 'HOK-1716',
        slug: 'ready-watchdog-task',
        prNumber: 716,
        classification: 'auto-update',
        displayLabel: 'auto update',
        detail: 'older failure',
        action: 'auto-update-failed',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
      },
    },
  }, null, 2));

  try {
    const baseDeps = {
      fetchGitHubTruth: async () => makeTruth({
        mergeStateStatus: 'BEHIND',
        baseRefName: 'auto/integration',
      }),
      getCurrentHead: async () => 'head',
    };

    const first = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        ...baseDeps,
        updateBehindBranch: async () => ({ status: 'push-failed', detail: 'remote rejected push' }),
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });
    assert.equal(first.findings.length, 1);
    assert.equal(first.findings[0].classification, 'auto-update');
    assert.equal(first.findings[0].autoUpdateAttempts, 1);

    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        ...baseDeps,
        updateBehindBranch: async () => ({ status: 'push-failed', detail: 'remote rejected push' }),
        now: () => new Date('2030-05-05T12:31:00.000Z'),
      },
    });
    assert.equal(second.findings.length, 1);
    assert.equal(second.findings[0].autoUpdateAttempts, 2);

    const third = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        ...baseDeps,
        updateBehindBranch: async () => ({ status: 'push-failed', detail: 'remote rejected push' }),
        now: () => new Date('2030-05-05T12:32:00.000Z'),
      },
    });
    assert.equal(third.findings.length, 1);
    assert.equal(third.findings[0].classification, 'needs-user');
    assert.match(third.findings[0].detail, /exhausted after 3 attempts/);

    let calledAgain = false;
    const fourth = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        ...baseDeps,
        updateBehindBranch: async () => {
          calledAgain = true;
          return { status: 'push-failed', detail: 'remote rejected push' };
        },
        now: () => new Date('2030-05-05T12:33:00.000Z'),
      },
    });
    assert.equal(calledAgain, false);
    assert.equal(fourth.findings.length, 0);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick retains prior actionable findings across fresh ticks and suppresses repeat spam', async () => {
  const { repoDir, stateFile } = setupReadyTask('HOK-1716', 716);

  try {
    const blockingTruth = makeTruth({ state: 'MERGED' });

    const first = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: false,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => blockingTruth,
        getCurrentHead: async () => 'head',
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });
    assert.equal(first.findings.length, 1);

    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: false,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => blockingTruth,
        getCurrentHead: async () => 'head',
        now: () => new Date('2026-05-05T12:04:00.000Z'),
      },
    });
    assert.equal(second.findings.length, 0);

    const third = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: false,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => blockingTruth,
        getCurrentHead: async () => 'head',
        now: () => new Date('2030-05-05T12:40:00.000Z'),
      },
    });
    assert.equal(third.findings.length, 0);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick prunes retained watchdog state when a task leaves ready', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-1716', 716);
  const watchdogStatePath = path.join(stateDir, 'ready-watchdog-state.json');
  writeFileSync(watchdogStatePath, JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-1716': {
        issueId: 'HOK-1716',
        slug: 'ready-watchdog-task',
        prNumber: 716,
        classification: 'needs-user',
        displayLabel: 'needs user',
        detail: 'persisted finding',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
      },
    },
  }, null, 2));

  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-1716': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree: path.join(repoDir, 'worktrees', 'ready-watchdog-task'),
        pr: 716,
        phase: 'review',
        updated: '2026-05-05T12:00:00.000Z',
      },
    },
    jobs: {},
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: false,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => makeTruth(),
        getCurrentHead: async () => 'head',
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 0);
    const watchdogState = JSON.parse(readFileSync(watchdogStatePath, 'utf-8')) as {
      tasks: Record<string, unknown>;
    };
    assert.equal(watchdogState.tasks['HOK-1716'], undefined);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});
