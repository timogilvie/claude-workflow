import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runEvaluation, evalOrchestratorDeps } from './eval-orchestrator.ts';
import { enrichPostCompletionRecord } from './post-completion-hook.ts';
import type { EvalRecord, InterventionRecord, RoutingDecision } from './eval-schema.ts';
import type { WorkflowCostOutcome } from './workflow-cost.ts';

function makeJudgeRecord(): EvalRecord {
  return {
    id: 'eval-orchestrator-1',
    schemaVersion: '1.19.0',
    originalPrompt: 'Implement unified eval enrichment',
    modelId: '',
    modelVersion: '',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 180,
    timestamp: '2026-05-03T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 1,
    interventionDetails: ['Asked for one clarification'],
    rationale: 'Strong implementation with minor operator involvement.',
    metadata: {
      stageScores: {
        plan: { score: 0.88, rationale: 'Clear plan.' },
        implementation: { score: 0.91, rationale: 'Solid implementation.' },
        review: { score: 0.86, rationale: 'Good review coverage.' },
      },
    },
  };
}

function writeRouteArtifacts(repoDir: string, slug: string, issueId: string): void {
  const featureDir = join(repoDir, 'features', slug);
  const archiveDir = join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });

  const routingComplete = {
    planner: 'claude-opus-4-6',
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-5-20250929',
    codeDepth: 'deep',
    reviewMode: 'full',
    maxCostUsd: 6.5,
  };
  const bootstrapRoute = {
    planner: 'claude-opus-4-6',
    coder: 'gpt-5.4',
    codeDepth: 'deep',
    reviewer: 'claude-sonnet-4-5-20250929',
    reviewMode: 'full',
  };

  writeFileSync(join(featureDir, '.routing-complete'), JSON.stringify(routingComplete));
  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify(bootstrapRoute));
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify(bootstrapRoute));
  writeFileSync(join(archiveDir, 'routing-complete.json'), JSON.stringify(routingComplete));
  writeFileSync(join(archiveDir, 'initial-route.json'), JSON.stringify(bootstrapRoute));
}

describe('eval-orchestrator', () => {
  let repoDir: string;
  let routingDecision: RoutingDecision;
  let interventionRecords: InterventionRecord[];
  let costOutcome: WorkflowCostOutcome;

  beforeEach(() => {
    mock.restoreAll();
    repoDir = mkdtempSync(join(tmpdir(), 'eval-orchestrator-'));
    routingDecision = {
      candidates: [
        { agentType: 'claude', modelId: 'claude-opus-4-6' },
        { agentType: 'codex', modelId: 'gpt-5.4' },
      ],
      chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
      decisionPolicyVersion: 'baseline',
      decisionRationale: 'Use the faster implementation model.',
    };
    interventionRecords = [
      {
        timestamp: '2026-05-03T12:10:00.000Z',
        type: 'clarification',
        severity: 'low',
        note: 'Clarified one requirement.',
      },
    ];
    costOutcome = {
      status: 'success',
      totalCostUsd: 3.75,
      models: {
        'gpt-5.4': {
          inputTokens: 1200,
          cacheCreationTokens: 100,
          cacheReadTokens: 0,
          outputTokens: 400,
          costUsd: 3.75,
        },
      },
      sessionCount: 1,
      turnCount: 4,
      pricingUsed: {},
    };

    writeRouteArtifacts(repoDir, 'unified-eval', 'HOK-1495');

    mock.method(evalOrchestratorDeps, 'gatherEvalContext', () => ({
      taskPrompt: 'Implement unified eval enrichment',
      prDiff: '+++ shared/lib/eval-orchestrator.ts\n+++ shared/lib/eval-record-builder.ts',
      prUrl: 'https://example.test/pr/1495',
      issueData: null,
    }));
    mock.method(evalOrchestratorDeps, 'gatherStageArtifacts', () => ({
      taskPacket: undefined,
      planContent: undefined,
      selfReviewSummary: undefined,
      routingDecision,
      executedPlanning: {
        agent: 'codex',
        model: 'claude-opus-4-6',
        status: 'completed',
        source: '.planning-result.json',
      },
      executionModel: 'gpt-5.4',
    }));
    mock.method(evalOrchestratorDeps, 'execShellCommand', () => 'task/unified-eval');
    mock.method(evalOrchestratorDeps, 'computeWallClockSeconds', () => 180);
    mock.method(evalOrchestratorDeps, 'detectAllInterventions', () => ({
      interventions: [{ type: 'clarification', count: 1 }],
      totalInterventionScore: 0.1,
    }));
    mock.method(evalOrchestratorDeps, 'toInterventionMeta', () => [{ description: 'Clarified one requirement', severity: 'minor' }]);
    mock.method(evalOrchestratorDeps, 'toInterventionRecords', () => interventionRecords);
    mock.method(evalOrchestratorDeps, 'loadPenalties', () => ({}));
    mock.method(evalOrchestratorDeps, 'formatForJudge', () => 'No major interventions.');
    mock.method(evalOrchestratorDeps, 'runEvalAnalysis', async () => ({
      difficultyData: {
        difficultyBand: 'medium',
        difficultySignals: { locTouched: 80, filesTouched: 3 },
        stratum: 'ts_express_med',
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
        repoSize: { fileCount: 40, loc: 12000, dependencyCount: 8 },
      },
    }));
    mock.method(evalOrchestratorDeps, 'collectCiOutcome', () => ({ ran: true, passed: true }));
    mock.method(evalOrchestratorDeps, 'collectTestsOutcome', () => ({ added: true }));
    mock.method(evalOrchestratorDeps, 'collectStaticAnalysisOutcome', () => ({ issuesFound: 0 }));
    mock.method(evalOrchestratorDeps, 'collectReviewOutcome', () => ({
      humanReviewRequired: false,
      rounds: 0,
      approvals: 1,
      changeRequests: 0,
    }));
    mock.method(evalOrchestratorDeps, 'collectReworkOutcome', () => ({ agentIterations: 1 }));
    mock.method(evalOrchestratorDeps, 'collectDeliveryOutcome', () => ({ prCreated: true, merged: false }));
    mock.method(evalOrchestratorDeps, 'loadPricingTable', () => ({
      'gpt-5.4': {
        inputCostPerMTok: 1,
        outputCostPerMTok: 2,
      },
    }));
    mock.method(evalOrchestratorDeps, 'computeWorkflowCost', () => costOutcome);
    mock.method(evalOrchestratorDeps, 'appendEvalRecord', () => undefined);
    mock.method(evalOrchestratorDeps, 'evaluateTask', async (_input, outcomes) => ({
      ...makeJudgeRecord(),
      outcomes,
      routingDecision,
    }));
  });

  afterEach(() => {
    mock.restoreAll();
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('computes workflow cost metadata before training enrichment', async () => {
    const record = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    assert.equal(record.workflowCost, 3.75);
    assert.deepEqual(record.workflowTokenUsage, costOutcome.status === 'success' ? costOutcome.models : undefined);
    assert.equal(record.workflowCostStatus, 'success');
    assert.equal(record.taskDescriptor?.outcome?.total_cost_usd, 3.75);
    assert.equal(record.constraints?.maxCostUsd, 6.5);
    assert.equal(record.enrichmentDiagnostics, undefined);
  });

  it('matches post-completion training fields for equivalent inputs', async () => {
    const orchestrated = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      worktreePath: repoDir,
      agentType: 'codex',
    });

    const postCompletion = {
      ...makeJudgeRecord(),
      outcomes: {
        success: true,
        review: { humanReviewRequired: false, rounds: 0, approvals: 1, changeRequests: 0 },
        rework: { agentIterations: 1 },
        delivery: { prCreated: true, merged: false },
      },
      routingDecision,
      modelId: 'gpt-5.4',
      modelVersion: 'gpt-5.4',
    } as EvalRecord;

    enrichPostCompletionRecord(postCompletion, {
      repoDir,
      issueId: 'HOK-1495',
      branchName: 'task/unified-eval',
      worktreePath: repoDir,
      agentType: 'codex',
      originalPrompt: 'Implement unified eval enrichment',
      prDiff: '+++ shared/lib/eval-orchestrator.ts\n+++ shared/lib/eval-record-builder.ts',
      record: postCompletion,
      difficultyData: {
        difficultyBand: 'medium',
        difficultySignals: { locTouched: 80, filesTouched: 3 },
        stratum: 'ts_express_med',
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
        repoSize: { fileCount: 40, loc: 12000, dependencyCount: 8 },
      },
      costOutcome,
      interventionRecords,
      routingDecision,
      executedPlanning: {
        agent: 'codex',
        model: 'claude-opus-4-6',
        status: 'completed',
        source: '.planning-result.json',
      },
    });

    assert.deepEqual(
      {
        workflowCost: orchestrated.workflowCost,
        workflowTokenUsage: orchestrated.workflowTokenUsage,
        workflowCostStatus: orchestrated.workflowCostStatus,
        constraints: orchestrated.constraints,
        routeProvenance: orchestrated.routeProvenance,
        executedPlanning: orchestrated.executedPlanning,
        trainingEligible: orchestrated.trainingEligible,
        budgetEvalEligible: orchestrated.budgetEvalEligible,
        eligibilityErrors: orchestrated.eligibilityErrors,
        enrichmentDiagnostics: orchestrated.enrichmentDiagnostics,
        taskDescriptor: orchestrated.taskDescriptor,
      },
      {
        workflowCost: postCompletion.workflowCost,
        workflowTokenUsage: postCompletion.workflowTokenUsage,
        workflowCostStatus: postCompletion.workflowCostStatus,
        constraints: postCompletion.constraints,
        routeProvenance: postCompletion.routeProvenance,
        executedPlanning: postCompletion.executedPlanning,
        trainingEligible: postCompletion.trainingEligible,
        budgetEvalEligible: postCompletion.budgetEvalEligible,
        eligibilityErrors: postCompletion.eligibilityErrors,
        enrichmentDiagnostics: postCompletion.enrichmentDiagnostics,
        taskDescriptor: postCompletion.taskDescriptor,
      },
    );
  });

  it('diagnoses skipped workflow cost instead of omitting it silently', async () => {
    mock.method(evalOrchestratorDeps, 'computeWorkflowCost', () => {
      throw new Error('should not run without worktreePath');
    });
    const warn = mock.method(console, 'warn', () => undefined);

    const record = await runEvaluation({
      issueId: 'HOK-1495',
      prNumber: '1495',
      repoDir,
      agentType: 'codex',
    });

    assert.equal(record.workflowCost, undefined);
    assert.equal(record.workflowCostStatus, 'skipped');
    assert.ok(record.enrichmentDiagnostics?.includes('workflowCost'));
    assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('workflowCost')));
  });
});
