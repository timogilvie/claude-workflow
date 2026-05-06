import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  classifyReadyTask,
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
    tasks: Record<string, { action: string }>;
  };
  assert.equal(watchdogState.tasks['HOK-1579'].action, 'auto-recovered');

  await rm(repoDir, { recursive: true, force: true });
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
    deps: {
      fetchGitHubTruth: async () => makeTruth(),
      getCurrentHead: async () => 'head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  });

  assert.equal(result.findings[0].action, 'recovery-command');
  assert.match(result.findings[0].recoveryCommand ?? '', /--recover HOK-1579/);

  await rm(repoDir, { recursive: true, force: true });
});
