import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mock } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import { clearConfigCache } from './config.ts';
import { enrichPostCompletionRecord, runPostCompletionEval, postCompletionHookDeps } from './post-completion-hook.ts';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function makeRecord(): EvalRecord {
  return {
    id: 'eval-hook-1',
    schemaVersion: '1.4.0',
    originalPrompt: 'placeholder',
    modelId: 'claude-sonnet-4-5-20250929',
    modelVersion: 'claude-sonnet-4-5-20250929',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 240,
    timestamp: '2026-04-06T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 1,
    interventionDetails: ['Asked for clarification'],
    rationale: 'Strong result.',
    metadata: {
      stageScores: {
        plan: { score: 0.91, rationale: 'clear plan' },
        implementation: { score: 0.87, rationale: 'solid implementation' },
        review: { score: 0.9, rationale: 'good review' },
      },
    },
  };
}

console.log('\n--- post-completion-hook Tests ---\n');

await test('enrichPostCompletionRecord attaches taskDescriptor for persisted records', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-hook-'));
  const featureDir = join(repoDir, 'features', 'enrich-task');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      router: {
        availableModels: {
          planner: ['gpt-5.5', 'claude-opus-4-7'],
          coder: ['gpt-5.4', 'gpt-5.3-codex'],
          reviewer: ['claude-sonnet-4-6'],
        },
      },
      modelRegistry: {
        models: {
          'gpt-5.3-codex': {
            vendor: 'openai',
            class: 'strong_generalist',
            strengths: ['coding'],
            weaknesses: ['none'],
            qualityScores: { coding: 89 },
            agent: 'codex',
          },
        },
      },
    }),
  );
  clearConfigCache(repoDir);
  writeFileSync(
    join(featureDir, '.routing-complete'),
    JSON.stringify({
      planner: 'claude-opus-4-6',
      coder: 'gpt-5.3-codex',
      reviewer: 'claude-sonnet-4-5-20250929',
      codeDepth: 'deep',
      reviewMode: 'full',
      maxCostUsd: 6.5,
    }),
  );
  writeFileSync(
    join(featureDir, '.initial-route.json'),
    JSON.stringify({
      planner: 'claude-opus-4-6',
      coder: 'gpt-5.3-codex',
      reviewer: 'claude-sonnet-4-5-20250929',
      codeDepth: 'deep',
      reviewMode: 'full',
    }),
  );

  try {
    const record = makeRecord();
    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1123',
      branchName: 'task/enrich-task',
      worktreePath: repoDir,
      agentType: 'codex',
      challengePairId: 'pair-1',
      originalPrompt: 'Add backend tests for auth and tighten review coverage',
      prDiff: '+++ tests/auth.test.ts\n+++ src/auth.ts',
      record,
      difficultyData: {
        difficultyBand: 'medium',
        difficultySignals: {
          locTouched: 140,
          filesTouched: 3,
        },
        stratum: 'ts_express_med',
      },
      taskContextData: {
        taskType: 'test',
        changeKind: 'modify_existing',
        complexity: 'm',
      },
      repoContextData: {
        repoId: 'repo',
        repoVisibility: 'private',
        primaryLanguage: 'TypeScript',
        languages: { TypeScript: 100 },
        frameworks: ['Express'],
        repoSize: { fileCount: 50, loc: 25_000, dependencyCount: 12 },
      },
      costOutcome: {
        status: 'success',
        totalCostUsd: 4.25,
        models: {
          'gpt-5.3-codex': {
            inputTokens: 1000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 500,
            costUsd: 4.25,
          },
        },
        sessionCount: 1,
        turnCount: 2,
        pricingUsed: {},
      },
      interventionRecords: [
        {
          timestamp: '2026-04-06T12:05:00.000Z',
          type: 'clarification',
          severity: 'low',
          note: 'Asked for one clarification',
        },
      ],
      routingDecision: {
        candidates: [
          { agentType: 'claude', modelId: 'claude-opus-4-6' },
          { agentType: 'codex', modelId: 'gpt-5.3-codex' },
        ],
        chosen: { agentType: 'codex', modelId: 'gpt-5.3-codex' },
        decisionPolicyVersion: 'baseline',
        decisionRationale: 'Selected coder model for implementation.',
      },
    });

    assert.ok(record.taskDescriptor);
    assert.equal(record.taskDescriptor?.stages.planner?.model, 'claude-opus-4-6');
    assert.equal(record.taskDescriptor?.stages.coder?.model, 'gpt-5.3-codex');
    assert.equal(record.taskDescriptor?.outcome?.total_cost_usd, 4.25);
    assert.equal(record.taskDescriptor?.outcome?.interventions, 1);
    assert.deepEqual(record.taskDescriptor?.constraints.models_available, [
      'gpt-5.5',
      'claude-opus-4-7',
      'gpt-5.4',
      'gpt-5.3-codex',
      'claude-sonnet-4-6',
    ]);
    assert.equal(record.workflowCostStatus, 'success');
    assert.equal(record.enrichmentDiagnostics, undefined);
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval returns false when no issue or PR is provided', async () => {
  const persisted = await runPostCompletionEval({
    workflowType: 'mill',
    repoDir: process.cwd(),
  });

  assert.equal(persisted, false);
});

await test('enrichPostCompletionRecord falls back to archived routing-complete data', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-archive-'));
  const archiveDir = join(repoDir, '.wavemill', 'evals', 'artifacts', 'HOK-1123');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    join(archiveDir, 'routing-complete.json'),
    JSON.stringify({
      planner: 'claude-opus-4-6',
      coder: 'gpt-5.3-codex',
      reviewer: 'claude-sonnet-4-5-20250929',
      maxCostUsd: 6.5,
    }),
  );

  try {
    const record = makeRecord();
    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1123',
      branchName: 'task/enrich-task',
      worktreePath: join(repoDir, 'missing-worktree'),
      originalPrompt: 'Re-run post-completion eval after cleanup',
      prDiff: '+++ src/auth.ts',
      record,
      difficultyData: null,
      taskContextData: null,
      repoContextData: null,
      costOutcome: null,
      interventionRecords: [],
    });

    assert.equal(record.taskDescriptor?.stages.planner?.model, 'claude-opus-4-6');
    assert.equal(record.taskDescriptor?.stages.coder?.model, 'gpt-5.3-codex');
    assert.equal(record.constraints?.maxCostUsd, 6.5);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord preserves DeepSeek model identity before eligibility is computed', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-deepseek-'));
  const featureDir = join(repoDir, 'features', 'deepseek-task');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(featureDir, '.coding-result.json'),
    JSON.stringify({
      stage: 'coding',
      status: 'completed',
      startedAt: '2026-04-06T11:00:00.000Z',
      finishedAt: '2026-04-06T11:30:00.000Z',
      agent: 'claude',
      model: 'deepseek-v4-pro',
      notes: '',
    }),
  );

  try {
    const record = { ...makeRecord(), modelId: '', modelVersion: '' } as EvalRecord;
    record.routingDecision = {
      candidates: [{ agentType: 'claude', modelId: 'claude-sonnet-4-6' }],
      chosen: { agentType: 'claude', modelId: 'claude-sonnet-4-6' },
      decisionPolicyVersion: 'baseline',
      decisionRationale: 'fallback',
    };
    record.constraints = { maxCostUsd: 5 };
    record.workflowCost = 1.2;
    record.workflowTokenUsage = {};
    record.outcomes = {
      success: true,
      review: { humanReviewRequired: false, rounds: 0, approvals: 1, changeRequests: 0 },
      rework: { agentIterations: 1 },
      delivery: { prCreated: true, merged: false },
    };
    record.modelId = 'deepseek-v4-pro';
    record.modelVersion = 'deepseek-v4-pro';

    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1488',
      branchName: 'task/deepseek-task',
      worktreePath: repoDir,
      originalPrompt: 'Evaluate deepseek-backed run',
      prDiff: '+++ src/session.ts',
      record,
      difficultyData: null,
      taskContextData: null,
      repoContextData: null,
      costOutcome: null,
      interventionRecords: [],
    });

    assert.equal(record.modelId, 'deepseek-v4-pro');
    assert.equal(record.provider, 'deepseek');
    assert.equal(record.trainingEligible, true);
    assert.ok(!record.eligibilityErrors?.includes('missing_model_identity'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval passes collected outcomes to evaluateTask and persists success', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-outcomes-'));
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });

  const capturedRecord: any[] = [];
  const capturedOutcomes: any[] = [];

  const testContext = {
    issueId: 'HOK-1550',
    prNumber: '789',
    prUrl: 'https://github.com/example/repo/pull/789',
    workflowType: 'mill',
    repoDir,
    branchName: 'task/test-outcomes',
    worktreePath: repoDir,
    agentType: 'claude',
  };

  // Declare stubs before try so they're accessible in finally for cleanup
  let stubs: Record<string, { restore?: () => void }> | undefined;
  try {
    stubs = {
      gatherEvalContext: mock.method(postCompletionHookDeps, 'gatherEvalContext', () => ({
        issueId: 'HOK-1550',
        prNumber: '789',
        prUrl: 'https://github.com/example/repo/pull/789',
        taskPrompt: 'Implement feature X',
        prDiff: '+++ src/index.ts\n+function newFeature() {}',
      })),
      gatherStageArtifacts: mock.method(postCompletionHookDeps, 'gatherStageArtifacts', () => ({
        taskPacket: 'Task packet content',
        planContent: 'Plan content',
        selfReviewSummary: 'Review summary',
        executionModel: 'claude-sonnet-4-6',
        routingDecision: undefined,
      })),
      execShellCommand: mock.method(postCompletionHookDeps, 'execShellCommand', () => 'task/test-outcomes'),
      detectAndFormatInterventions: mock.method(postCompletionHookDeps, 'detectAndFormatInterventions', () => ({
        totalCount: 1,
        summary: { interventions: [{ type: 'clarification', count: 1 }], totalInterventionScore: 0.1 },
        meta: [],
        records: [],
        text: 'One clarification',
      })),
      runEvalAnalysis: mock.method(postCompletionHookDeps, 'runEvalAnalysis', async () => ({
        difficultyData: null,
        repoContextData: null,
        taskContextData: null,
      })),
      collectCiOutcome: mock.method(postCompletionHookDeps, 'collectCiOutcome', () => ({
        ran: true,
        passed: true,
        checks: [],
      })),
      collectTestsOutcome: mock.method(postCompletionHookDeps, 'collectTestsOutcome', () => ({
        added: true,
        passRate: 1.0,
      })),
      collectStaticAnalysisOutcome: mock.method(postCompletionHookDeps, 'collectStaticAnalysisOutcome', () => ({
        typecheckPassed: true,
      })),
      collectReviewOutcome: mock.method(postCompletionHookDeps, 'collectReviewOutcome', () => ({
        humanReviewRequired: false,
        rounds: 1,
        approvals: 1,
        changeRequests: 0,
      })),
      collectReworkOutcome: mock.method(postCompletionHookDeps, 'collectReworkOutcome', () => ({
        agentIterations: 1,
      })),
      collectDeliveryOutcome: mock.method(postCompletionHookDeps, 'collectDeliveryOutcome', () => ({
        prCreated: true,
        merged: false,
      })),
      evaluateTask: mock.method(postCompletionHookDeps, 'evaluateTask', async (input: any, outcomes: any) => {
        assert.ok(outcomes, 'outcomes should be passed to evaluateTask');
        assert.ok(outcomes.ci, 'outcomes.ci should be present');
        assert.equal(outcomes.review.approvals, 1, 'outcomes.review should have correct approvals');
        capturedOutcomes.push(outcomes);
        return {
          ...makeRecord(),
          outcomes,
          score: 0.9,
          scoreBand: 'Minor Feedback',
        };
      }),
      appendEvalRecord: mock.method(postCompletionHookDeps, 'appendEvalRecord', (record: any) => {
        capturedRecord.push(record);
      }),
      loadPricingTable: mock.method(postCompletionHookDeps, 'loadPricingTable', () => ({})),
      computeWorkflowCost: mock.method(postCompletionHookDeps, 'computeWorkflowCost', () => ({
        status: 'skipped',
        reason: 'test',
      })),
    };

    const result = await runPostCompletionEval(testContext);

    assert.equal(result, true, 'should return true when eval persists');
    assert.equal(capturedRecord.length, 1, 'should capture one record');
    assert.equal(capturedOutcomes.length, 1, 'should pass outcomes to evaluateTask');

    const record = capturedRecord[0];
    assert.ok(record.outcomes, 'record should have outcomes');
    assert.equal(record.outcomes.success, true, 'outcomes.success should be true for score 0.9');
    assert.ok(record.outcomes.ci, 'outcomes should have ci');
    assert.equal(record.outcomes.review.approvals, 1, 'outcomes should have correct review data');
  } finally {
    if (stubs) {
      Object.values(stubs).forEach(stub => stub?.restore?.());
    }
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval degrades throwing collectors to partial outcomes', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-degrade-'));
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });

  const capturedRecord: any[] = [];

  const testContext = {
    issueId: 'HOK-1551',
    prNumber: '790',
    prUrl: 'https://github.com/example/repo/pull/790',
    workflowType: 'mill',
    repoDir,
    branchName: 'task/test-degrade',
    worktreePath: repoDir,
    agentType: 'claude',
  };

  const warnMessages: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnMessages.push(args.join(' ')); };

  let degradeStubs: Record<string, { restore?: () => void }> | undefined;
  try {
    degradeStubs = {
      gatherEvalContext: mock.method(postCompletionHookDeps, 'gatherEvalContext', () => ({
        issueId: 'HOK-1551',
        prNumber: '790',
        prUrl: 'https://github.com/example/repo/pull/790',
        taskPrompt: 'Implement feature Y',
        prDiff: '+++ src/index.ts\n+function anotherFeature() {}',
      })),
      gatherStageArtifacts: mock.method(postCompletionHookDeps, 'gatherStageArtifacts', () => ({
        taskPacket: 'Task packet',
        planContent: 'Plan',
        selfReviewSummary: 'Review',
        executionModel: 'claude-sonnet-4-6',
        routingDecision: undefined,
      })),
      execShellCommand: mock.method(postCompletionHookDeps, 'execShellCommand', () => 'task/test-degrade'),
      detectAndFormatInterventions: mock.method(postCompletionHookDeps, 'detectAndFormatInterventions', () => ({
        totalCount: 0,
        summary: { interventions: [], totalInterventionScore: 0 },
        meta: [],
        records: [],
        text: 'No interventions',
      })),
      runEvalAnalysis: mock.method(postCompletionHookDeps, 'runEvalAnalysis', async () => ({
        difficultyData: null,
        repoContextData: null,
        taskContextData: null,
      })),
      collectCiOutcome: mock.method(postCompletionHookDeps, 'collectCiOutcome', () => {
        throw new Error('GitHub API error');
      }),
      collectTestsOutcome: mock.method(postCompletionHookDeps, 'collectTestsOutcome', () => ({
        added: true,
      })),
      collectStaticAnalysisOutcome: mock.method(postCompletionHookDeps, 'collectStaticAnalysisOutcome', () => ({
        typecheckPassed: true,
      })),
      collectReviewOutcome: mock.method(postCompletionHookDeps, 'collectReviewOutcome', () => ({
        humanReviewRequired: false,
        rounds: 0,
        approvals: 1,
        changeRequests: 0,
      })),
      collectReworkOutcome: mock.method(postCompletionHookDeps, 'collectReworkOutcome', () => ({
        agentIterations: 0,
      })),
      collectDeliveryOutcome: mock.method(postCompletionHookDeps, 'collectDeliveryOutcome', () => ({
        prCreated: true,
        merged: false,
      })),
      evaluateTask: mock.method(postCompletionHookDeps, 'evaluateTask', async (input: any, outcomes: any) => {
        assert.equal(outcomes.ci, undefined, 'outcomes.ci should be undefined when collector throws');
        assert.ok(outcomes.review, 'outcomes.review should still be populated');
        return {
          ...makeRecord(),
          outcomes,
          score: 0.75,
          scoreBand: 'Assisted Success',
        };
      }),
      appendEvalRecord: mock.method(postCompletionHookDeps, 'appendEvalRecord', (record: any) => {
        capturedRecord.push(record);
      }),
      loadPricingTable: mock.method(postCompletionHookDeps, 'loadPricingTable', () => ({})),
      computeWorkflowCost: mock.method(postCompletionHookDeps, 'computeWorkflowCost', () => ({
        status: 'skipped',
        reason: 'test',
      })),
    };

    const result = await runPostCompletionEval(testContext);

    assert.equal(result, true, 'hook should return true on collector failure');
    assert.equal(capturedRecord.length, 1, 'should still capture record');

    const record = capturedRecord[0];
    assert.ok(record.outcomes, 'record should have outcomes');
    assert.equal(record.outcomes.ci, undefined, 'outcomes.ci should be undefined');
    assert.ok(record.outcomes.review, 'outcomes.review should be present');

    const ciWarn = warnMessages.find(m => m.includes('ci'));
    assert.ok(ciWarn, 'console.warn should mention the failing ci collector');
  } finally {
    console.warn = originalWarn;
    if (degradeStubs) {
      Object.values(degradeStubs).forEach(stub => stub?.restore?.());
    }
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval sets outcomes.success false for failing scores', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-failing-'));
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });

  const capturedRecord: any[] = [];

  const testContext = {
    issueId: 'HOK-1552',
    prNumber: '791',
    prUrl: 'https://github.com/example/repo/pull/791',
    workflowType: 'mill',
    repoDir,
    branchName: 'task/test-failing',
    worktreePath: repoDir,
    agentType: 'claude',
  };

  let failingStubs: Record<string, { restore?: () => void }> | undefined;
  try {
    failingStubs = {
      gatherEvalContext: mock.method(postCompletionHookDeps, 'gatherEvalContext', () => ({
        issueId: 'HOK-1552',
        prNumber: '791',
        prUrl: 'https://github.com/example/repo/pull/791',
        taskPrompt: 'Task description',
        prDiff: '+++ index.ts',
      })),
      gatherStageArtifacts: mock.method(postCompletionHookDeps, 'gatherStageArtifacts', () => ({
        taskPacket: undefined,
        planContent: undefined,
        selfReviewSummary: undefined,
        executionModel: undefined,
      })),
      execShellCommand: mock.method(postCompletionHookDeps, 'execShellCommand', () => 'task/test-failing'),
      detectAndFormatInterventions: mock.method(postCompletionHookDeps, 'detectAndFormatInterventions', () => ({
        totalCount: 0,
        summary: { interventions: [], totalInterventionScore: 0 },
        meta: [],
        records: [],
        text: '',
      })),
      runEvalAnalysis: mock.method(postCompletionHookDeps, 'runEvalAnalysis', async () => ({
        difficultyData: null,
        repoContextData: null,
        taskContextData: null,
      })),
      collectCiOutcome: mock.method(postCompletionHookDeps, 'collectCiOutcome', () => ({
        ran: false,
        passed: false,
        checks: [],
      })),
      collectTestsOutcome: mock.method(postCompletionHookDeps, 'collectTestsOutcome', () => ({
        added: false,
      })),
      collectStaticAnalysisOutcome: mock.method(postCompletionHookDeps, 'collectStaticAnalysisOutcome', () => ({
        typecheckPassed: false,
      })),
      collectReviewOutcome: mock.method(postCompletionHookDeps, 'collectReviewOutcome', () => ({
        humanReviewRequired: true,
        rounds: 0,
        approvals: 0,
        changeRequests: 1,
      })),
      collectReworkOutcome: mock.method(postCompletionHookDeps, 'collectReworkOutcome', () => ({
        agentIterations: 0,
      })),
      collectDeliveryOutcome: mock.method(postCompletionHookDeps, 'collectDeliveryOutcome', () => ({
        prCreated: false,
        merged: false,
      })),
      evaluateTask: mock.method(postCompletionHookDeps, 'evaluateTask', async (input: any, outcomes: any) => {
        return {
          ...makeRecord(),
          outcomes,
          score: 0.05,
          scoreBand: 'Failure',
        };
      }),
      appendEvalRecord: mock.method(postCompletionHookDeps, 'appendEvalRecord', (record: any) => {
        capturedRecord.push(record);
      }),
      loadPricingTable: mock.method(postCompletionHookDeps, 'loadPricingTable', () => ({})),
      computeWorkflowCost: mock.method(postCompletionHookDeps, 'computeWorkflowCost', () => ({
        status: 'skipped',
        reason: 'test',
      })),
    };

    const result = await runPostCompletionEval(testContext);

    assert.equal(result, true, 'should return true');
    assert.equal(capturedRecord.length, 1, 'should capture record');

    const record = capturedRecord[0];
    assert.ok(record.outcomes, 'record should have outcomes');
    assert.equal(record.outcomes.success, false, 'outcomes.success should be false for score 0.05');
  } finally {
    if (failingStubs) {
      Object.values(failingStubs).forEach(stub => stub?.restore?.());
    }
    rmSync(repoDir, { recursive: true, force: true });
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);

if (failed > 0) {
  process.exit(1);
}
