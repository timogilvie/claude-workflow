import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvalRecord } from './eval-schema.ts';
import { clearConfigCache } from './config.ts';
import { isEvalSuccess } from './eval-success-policy.ts';
import {
  collectPostCompletionOutcomes,
  enrichPostCompletionRecord,
  postCompletionHookDeps,
  runPostCompletionEval,
} from './post-completion-hook.ts';

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

function makeInterventionSummary(reviewComments = 0) {
  return {
    interventions: reviewComments > 0
      ? [{ type: 'review_comment', count: reviewComments, details: ['requested change'] }]
      : [],
    totalInterventionScore: reviewComments > 0 ? 0.1 : 0,
  };
}

function makeEligibleRepo(repoDir: string, slug: string, issueId: string): void {
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      router: {
        availableModels: {
          planner: ['gpt-5.5'],
          coder: ['gpt-5.4'],
          reviewer: ['claude-sonnet-4-6'],
        },
      },
    }),
  );
  writeFileSync(
    join(featureDir, '.routing-complete'),
    JSON.stringify({
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'deep',
      reviewMode: 'full',
      maxCostUsd: 6.5,
    }),
  );
  writeFileSync(
    join(featureDir, '.initial-route.json'),
    JSON.stringify({
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'deep',
      reviewMode: 'full',
    }),
  );
  mkdirSync(join(repoDir, '.wavemill', 'evals', 'artifacts', issueId), { recursive: true });
}

async function withMockedPostCompletionDeps(fn: () => Promise<void> | void): Promise<void> {
  const evalContextGatherer = await import('./eval-context-gatherer.ts');
  const shellUtils = await import('./shell-utils.ts');
  const interventionDetector = await import('./intervention-detector.ts');
  const evalAnalysis = await import('./eval-analysis.ts');
  const evalModule = await import('./eval.ts');
  const evalPersistence = await import('./eval-persistence.ts');
  const outcomeCollectors = await import('./outcome-collectors.ts');

  try {
    await fn();
  } finally {
    postCompletionHookDeps.gatherEvalContext = evalContextGatherer.gatherEvalContext;
    postCompletionHookDeps.gatherStageArtifacts = evalContextGatherer.gatherStageArtifacts;
    postCompletionHookDeps.execShellCommand = shellUtils.execShellCommand;
    postCompletionHookDeps.detectAndFormatInterventions = interventionDetector.detectAndFormatInterventions;
    postCompletionHookDeps.runEvalAnalysis = evalAnalysis.runEvalAnalysis;
    postCompletionHookDeps.evaluateTask = evalModule.evaluateTask;
    postCompletionHookDeps.appendEvalRecord = evalPersistence.appendEvalRecord;
    postCompletionHookDeps.collectCiOutcome = outcomeCollectors.collectCiOutcome;
    postCompletionHookDeps.collectTestsOutcome = outcomeCollectors.collectTestsOutcome;
    postCompletionHookDeps.collectStaticAnalysisOutcome = outcomeCollectors.collectStaticAnalysisOutcome;
    postCompletionHookDeps.collectReviewOutcome = outcomeCollectors.collectReviewOutcome;
    postCompletionHookDeps.collectReworkOutcome = outcomeCollectors.collectReworkOutcome;
    postCompletionHookDeps.collectDeliveryOutcome = outcomeCollectors.collectDeliveryOutcome;
  }
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

await test('collectPostCompletionOutcomes returns stable defaults without PR or branch', () => {
  const outcomes = collectPostCompletionOutcomes({
    repoDir: process.cwd(),
    interventionSummary: makeInterventionSummary(1),
  });

  assert.equal(outcomes.success, false);
  assert.equal(outcomes.ci, undefined);
  assert.equal(outcomes.tests, undefined);
  assert.equal(outcomes.staticAnalysis, undefined);
  assert.deepEqual(outcomes.review, {
    humanReviewRequired: true,
    rounds: 0,
    approvals: 0,
    changeRequests: 0,
  });
  assert.deepEqual(outcomes.rework, { agentIterations: 0 });
  assert.deepEqual(outcomes.delivery, { prCreated: false, merged: false });
});

await test('runPostCompletionEval persists outcomes and clears missing_outcome eligibility failure', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-persist-'));
  makeEligibleRepo(repoDir, 'persist-outcomes', 'HOK-1550');
  clearConfigCache(repoDir);

  try {
    await withMockedPostCompletionDeps(async () => {
      postCompletionHookDeps.gatherEvalContext = () => ({
        taskPrompt: 'Persist outcomes in post-completion evals',
        prDiff: '+++ shared/lib/post-completion-hook.ts',
        prUrl: 'https://example.test/pr/1550',
        issueData: null,
      });
      postCompletionHookDeps.gatherStageArtifacts = () => ({
        taskPacket: undefined,
        planContent: undefined,
        selfReviewSummary: undefined,
        routingDecision: {
          candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
          chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
          decisionPolicyVersion: 'baseline',
          decisionRationale: 'selected coder',
        },
        executionModel: 'gpt-5.4',
      });
      postCompletionHookDeps.detectAndFormatInterventions = () => ({
        meta: [],
        records: [],
        text: 'No interventions.',
        totalCount: 0,
        summary: makeInterventionSummary(0),
      });
      postCompletionHookDeps.runEvalAnalysis = async () => ({
        difficultyData: {
          difficultyBand: 'medium',
          difficultySignals: { locTouched: 20, filesTouched: 1 },
          stratum: 'ts_node_med',
        },
        taskContextData: {
          taskType: 'feature',
          changeKind: 'modify_existing',
          complexity: 'm',
        },
        repoContextData: {
          repoId: 'repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          languages: { TypeScript: 100 },
          frameworks: ['Node'],
          repoSize: { fileCount: 10, loc: 1000, dependencyCount: 3 },
        },
      });
      postCompletionHookDeps.collectCiOutcome = () => ({ ran: true, passed: true, checks: [] });
      postCompletionHookDeps.collectTestsOutcome = () => ({ added: true, passRate: 1 });
      postCompletionHookDeps.collectStaticAnalysisOutcome = () => ({ lintDelta: 0, typecheckPassed: true });
      postCompletionHookDeps.collectReviewOutcome = () => ({
        humanReviewRequired: false,
        rounds: 1,
        approvals: 1,
        changeRequests: 0,
      });
      postCompletionHookDeps.collectReworkOutcome = () => ({ agentIterations: 2 });
      postCompletionHookDeps.collectDeliveryOutcome = () => ({ prCreated: true, merged: false });
      postCompletionHookDeps.evaluateTask = async (_input, outcomes) => ({
        ...makeRecord(),
        modelId: '',
        modelVersion: '',
        workflowCost: 2.25,
        workflowTokenUsage: {},
        constraints: { maxCostUsd: 6.5 },
        routingDecision: {
          candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
          chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
          decisionPolicyVersion: 'baseline',
          decisionRationale: 'selected coder',
        },
        outcomes,
      });

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1550',
        prNumber: '1550',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/persist-outcomes',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
    const persistedLines = readFileSync(evalsPath, 'utf8').trim().split('\n');
    const record = JSON.parse(persistedLines.at(-1) || '{}');

    assert.ok(record.outcomes);
    assert.equal(record.outcomes.success, isEvalSuccess(record));
    assert.deepEqual(record.outcomes.ci, { ran: true, passed: true, checks: [] });
    assert.deepEqual(record.outcomes.tests, { added: true, passRate: 1 });
    assert.ok(!record.eligibilityErrors.includes('missing_outcome'));
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('runPostCompletionEval degrades to default outcomes when a collector throws', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-fallback-'));
  makeEligibleRepo(repoDir, 'collector-fallback', 'HOK-1551');
  clearConfigCache(repoDir);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown, ...args: unknown[]) => {
    warnings.push([message, ...args].map(String).join(' '));
  };

  try {
    await withMockedPostCompletionDeps(async () => {
      postCompletionHookDeps.gatherEvalContext = () => ({
        taskPrompt: 'Persist outcomes in post-completion evals',
        prDiff: '+++ shared/lib/post-completion-hook.ts',
        prUrl: 'https://example.test/pr/1551',
        issueData: null,
      });
      postCompletionHookDeps.gatherStageArtifacts = () => ({
        taskPacket: undefined,
        planContent: undefined,
        selfReviewSummary: undefined,
        routingDecision: undefined,
        executionModel: 'gpt-5.4',
      });
      postCompletionHookDeps.detectAndFormatInterventions = () => ({
        meta: [],
        records: [],
        text: 'No interventions.',
        totalCount: 0,
        summary: makeInterventionSummary(1),
      });
      postCompletionHookDeps.runEvalAnalysis = async () => ({
        difficultyData: null,
        taskContextData: null,
        repoContextData: null,
      });
      postCompletionHookDeps.collectCiOutcome = () => {
        throw new Error('ci exploded');
      };
      postCompletionHookDeps.collectTestsOutcome = () => ({ added: false });
      postCompletionHookDeps.collectStaticAnalysisOutcome = () => ({});
      postCompletionHookDeps.collectReviewOutcome = () => ({
        humanReviewRequired: true,
        rounds: 0,
        approvals: 0,
        changeRequests: 0,
      });
      postCompletionHookDeps.collectReworkOutcome = () => ({ agentIterations: 0 });
      postCompletionHookDeps.collectDeliveryOutcome = () => ({ prCreated: true, merged: false });
      postCompletionHookDeps.evaluateTask = async (_input, outcomes) => ({
        ...makeRecord(),
        workflowCost: 1.5,
        workflowTokenUsage: {},
        constraints: { maxCostUsd: 6.5 },
        routingDecision: undefined,
        outcomes,
      });

      const persisted = await runPostCompletionEval({
        issueId: 'HOK-1551',
        prNumber: '1551',
        workflowType: 'mill',
        repoDir,
        branchName: 'task/collector-fallback',
        worktreePath: repoDir,
        agentType: 'codex',
      });

      assert.equal(persisted, true);
    });

    const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
    const persistedLines = readFileSync(evalsPath, 'utf8').trim().split('\n');
    const record = JSON.parse(persistedLines.at(-1) || '{}');

    assert.deepEqual(record.outcomes.ci, { ran: false, passed: true, checks: [] });
    assert.ok(warnings.some((entry) => entry.includes('failed to collect ci outcome - ci exploded')));
  } finally {
    console.warn = originalWarn;
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
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

await test('enrichPostCompletionRecord attaches full routeProvenance from feature artifacts (HOK-1551)', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-route-prov-'));
  const featureDir = join(repoDir, 'features', 'route-prov');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(featureDir, '.initial-route.json'),
    JSON.stringify({
      planner: 'claude-opus-4-6',
      coder: 'claude-sonnet-4-6',
      reviewer: 'claude-opus-4-6',
      planDepth: 'shallow',
      codeDepth: 'medium',
      reviewMode: 'llm',
      expectedSuccess: 0.78,
      confidence: 0.62,
      expectedCostPlan: 0.05,
      expectedCostCode: 0.2,
      expectedCostReview: 0.05,
      provenance: { source: 'bootstrap', routerMode: 'normal' },
    }),
  );
  writeFileSync(
    join(featureDir, '.post-expansion-route.json'),
    JSON.stringify({
      planner: 'claude-opus-4-6',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      planDepth: 'deep',
      codeDepth: 'deep',
      reviewMode: 'static+llm',
      cache_hit: true,
      route_source: 'cache',
      packet_hash: 'a'.repeat(64),
      expectedSuccess: 0.84,
      confidence: 0.7,
      expectedCost: 0.6,
      expectedCostPlan: 0.1,
      expectedCostCode: 0.4,
      expectedCostReview: 0.1,
      provenance: { source: 'expanded', routerMode: 'normal' },
    }),
  );
  writeFileSync(
    join(featureDir, '.routing-complete'),
    JSON.stringify({
      planner: 'claude-opus-4-6',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'deep',
      reviewMode: 'static+llm',
      maxCostUsd: 6.5,
      provenance: { source: 'live', routerMode: 'normal' },
    }),
  );

  try {
    const record = makeRecord();
    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1551',
      branchName: 'task/route-prov',
      worktreePath: repoDir,
      originalPrompt: 'Persist route provenance fully',
      prDiff: '+++ shared/lib/route-artifact.ts',
      record,
      difficultyData: null,
      taskContextData: null,
      repoContextData: null,
      costOutcome: null,
      interventionRecords: [],
    });

    const provenance = record.routeProvenance;
    assert.ok(provenance, 'expected routeProvenance to be attached');
    assert.equal(provenance.decisionSource, 'expanded');
    assert.equal(provenance.routeChanged, true);
    assert.equal(provenance.expandedCacheHit, true);
    assert.equal(provenance.routeSource, 'cache');
    assert.equal(provenance.packetHash, 'a'.repeat(64));

    assert.equal(provenance.bootstrapRoute?.planner, 'claude-opus-4-6');
    assert.equal(provenance.bootstrapRoute?.planDepth, 'shallow');
    assert.equal(provenance.bootstrapRoute?.routerMode, 'normal');
    assert.equal(provenance.bootstrapRoute?.artifactSource, 'bootstrap');
    assert.equal(provenance.bootstrapRoute?.artifactPath, join(featureDir, '.initial-route.json'));
    assert.match(provenance.bootstrapRoute?.artifactHash || '', /^[0-9a-f]{64}$/);
    assert.equal(provenance.bootstrapRoute?.expectedSuccess, 0.78);
    assert.equal(provenance.bootstrapRoute?.confidence, 0.62);
    assert.equal(provenance.bootstrapRoute?.expectedCostPlan, 0.05);

    assert.equal(provenance.expandedRoute?.planner, 'claude-opus-4-6');
    assert.equal(provenance.expandedRoute?.planDepth, 'deep');
    assert.equal(provenance.expandedRoute?.routerMode, 'normal');
    assert.equal(provenance.expandedRoute?.artifactSource, 'expanded');
    assert.equal(provenance.expandedRoute?.cacheHit, true);
    assert.equal(provenance.expandedRoute?.routeSource, 'cache');
    assert.equal(provenance.expandedRoute?.packetHash, 'a'.repeat(64));
    assert.equal(provenance.expandedRoute?.artifactPath, join(featureDir, '.post-expansion-route.json'));
    assert.match(provenance.expandedRoute?.artifactHash || '', /^[0-9a-f]{64}$/);
    assert.equal(provenance.expandedRoute?.expectedSuccess, 0.84);
    assert.equal(provenance.expandedRoute?.expectedCost, 0.6);

    assert.equal(provenance.activeRoute?.coder, 'gpt-5.4');
    assert.equal(provenance.activeRoute?.routerMode, 'normal');
    assert.equal(provenance.activeRoute?.artifactSource, 'live');
    assert.equal(provenance.activeRoute?.artifactPath, join(featureDir, '.routing-complete'));
    assert.match(provenance.activeRoute?.artifactHash || '', /^[0-9a-f]{64}$/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord attaches routeProvenance from archive when worktree lacks artifacts (HOK-1551)', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-route-archive-'));
  const archiveDir = join(repoDir, '.wavemill', 'evals', 'artifacts', 'HOK-1551-archive');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    join(archiveDir, 'initial-route.json'),
    JSON.stringify({
      planner: 'archived-planner',
      coder: 'archived-coder',
      reviewer: 'archived-reviewer',
      codeDepth: 'medium',
      reviewMode: 'static',
      planDepth: 'light',
      provenance: { source: 'bootstrap', routerMode: 'constrained' },
    }),
  );
  writeFileSync(
    join(archiveDir, 'post-expansion-route.json'),
    JSON.stringify({
      planner: 'archived-planner',
      coder: 'archived-coder',
      reviewer: 'archived-reviewer',
      codeDepth: 'deep',
      reviewMode: 'llm',
      packet_hash: 'f'.repeat(64),
      cache_hit: false,
      route_source: 'single',
      provenance: { source: 'expanded', routerMode: 'normal' },
    }),
  );

  try {
    const record = makeRecord();
    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1551-archive',
      branchName: 'task/missing-worktree',
      worktreePath: join(repoDir, 'no-worktree-here'),
      originalPrompt: 'Re-run after worktree cleanup',
      prDiff: '+++ src/auth.ts',
      record,
      difficultyData: null,
      taskContextData: null,
      repoContextData: null,
      costOutcome: null,
      interventionRecords: [],
    });

    const provenance = record.routeProvenance;
    assert.ok(provenance, 'expected archive-only provenance to attach');
    assert.equal(provenance.bootstrapRoute?.planner, 'archived-planner');
    assert.equal(provenance.bootstrapRoute?.routerMode, 'constrained');
    assert.equal(provenance.bootstrapRoute?.artifactPath, join(archiveDir, 'initial-route.json'));
    assert.equal(provenance.expandedRoute?.cacheHit, false);
    assert.equal(provenance.expandedRoute?.routeSource, 'single');
    assert.equal(provenance.expandedRoute?.packetHash, 'f'.repeat(64));
    assert.equal(provenance.expandedRoute?.artifactPath, join(archiveDir, 'post-expansion-route.json'));
    // bootstrap.codeDepth=medium → expanded.codeDepth=deep is a material change.
    assert.equal(provenance.routeChanged, true);
    assert.equal(provenance.expandedCacheHit, false);
    assert.equal(provenance.packetHash, 'f'.repeat(64));
    assert.equal(provenance.routeSource, 'single');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord omits routeProvenance when no artifacts exist (HOK-1551)', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-route-empty-'));

  try {
    const record = makeRecord();
    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1551-empty',
      branchName: 'task/empty',
      worktreePath: repoDir,
      originalPrompt: 'No route artifacts present',
      prDiff: '',
      record,
      difficultyData: null,
      taskContextData: null,
      repoContextData: null,
      costOutcome: null,
      interventionRecords: [],
    });

    assert.equal(record.routeProvenance, undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('enrichPostCompletionRecord marks complete records with outcomes as training eligible', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'post-completion-eligible-'));
  const featureDir = join(repoDir, 'features', 'eligible-task');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      router: {
        availableModels: {
          planner: ['gpt-5.5'],
          coder: ['gpt-5.4'],
          reviewer: ['claude-sonnet-4-6'],
        },
      },
    }),
  );
  writeFileSync(
    join(featureDir, '.routing-complete'),
    JSON.stringify({
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'deep',
      reviewMode: 'full',
      maxCostUsd: 6.5,
    }),
  );
  writeFileSync(
    join(featureDir, '.initial-route.json'),
    JSON.stringify({
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'deep',
      reviewMode: 'full',
    }),
  );

  try {
    const record = makeRecord();
    record.modelId = 'gpt-5.4';
    record.modelVersion = 'gpt-5.4';
    record.routingDecision = {
      candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
      chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
      decisionPolicyVersion: 'baseline',
      decisionRationale: 'selected coder',
    };
    record.workflowCost = 2.1;
    record.workflowTokenUsage = {};
    record.outcomes = {
      success: true,
      ci: { ran: true, passed: true, checks: [] },
      tests: { added: true, passRate: 1 },
      staticAnalysis: { lintDelta: 0, typecheckPassed: true },
      review: { humanReviewRequired: false, rounds: 1, approvals: 1, changeRequests: 0 },
      rework: { agentIterations: 1 },
      delivery: { prCreated: true, merged: false },
    };

    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: 'HOK-1550',
      branchName: 'task/eligible-task',
      worktreePath: repoDir,
      agentType: 'codex',
      originalPrompt: 'Persist outcomes in post-completion evals',
      prDiff: '+++ shared/lib/post-completion-hook.ts',
      record,
      difficultyData: {
        difficultyBand: 'medium',
        difficultySignals: { locTouched: 20, filesTouched: 1 },
        stratum: 'ts_node_med',
      },
      taskContextData: {
        taskType: 'feature',
        changeKind: 'modify_existing',
        complexity: 'm',
      },
      repoContextData: {
        repoId: 'repo',
        repoVisibility: 'private',
        primaryLanguage: 'TypeScript',
        languages: { TypeScript: 100 },
        frameworks: ['Node'],
        repoSize: { fileCount: 10, loc: 1000, dependencyCount: 3 },
      },
      costOutcome: {
        status: 'success',
        totalCostUsd: 2.1,
        models: {},
        sessionCount: 1,
        turnCount: 2,
        pricingUsed: {},
      },
      interventionRecords: [],
      routingDecision: record.routingDecision,
    });

    assert.equal(record.trainingEligible, true);
    assert.ok(!record.eligibilityErrors?.includes('missing_outcome'));
  } finally {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);

if (failed > 0) {
  process.exit(1);
}
