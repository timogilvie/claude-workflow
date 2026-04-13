/**
 * Eval Orchestrator
 *
 * Orchestrates complete workflow evaluation:
 * 1. Context gathering (issue, PR, auto-detection)
 * 2. Intervention detection
 * 3. Difficulty/task/repo analysis
 * 4. Outcome collection
 * 5. LLM judging
 * 6. Record enrichment
 * 7. Persistence
 *
 * @module eval-orchestrator
 */

import path from 'node:path';
import { errorMessage } from './error-utils.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import {
  autoDetectContext,
  gatherEvalContext,
  gatherStageArtifacts,
  fetchIssueData,
  fetchRoutingCompleteRaw,
  type EvalContext,
} from './eval-context-gatherer.ts';
import {
  detectAllInterventions,
  toInterventionMeta,
  toInterventionRecords,
  formatForJudge,
  loadPenalties,
} from './intervention-detector.ts';
import { runEvalAnalysis } from './eval-analysis.ts';
import {
  collectCiOutcome,
  collectTestsOutcome,
  collectStaticAnalysisOutcome,
  collectReviewOutcome,
  collectReworkOutcome,
  collectDeliveryOutcome,
} from './outcome-collectors.ts';
import { evaluateTask } from './eval.ts';
import { enrichEvalRecord } from './eval-record-builder.ts';
import { appendEvalRecord } from './eval-persistence.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import { getMaxCostUsd } from './config.ts';
import type {
  EvalRecord,
  Outcomes,
  EvalConstraints,
} from './eval-schema.ts';
import type { RoutingCompleteData } from './eval-context-gatherer.ts';

function resolveEvalConstraints(
  routingComplete: RoutingCompleteData | null,
  repoDir: string,
): EvalConstraints | undefined {
  const maxCostUsd = routingComplete?.maxCostUsd ?? getMaxCostUsd(repoDir);
  return typeof maxCostUsd === 'number' ? { maxCostUsd } : undefined;
}

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Options for running evaluation.
 */
export interface EvalOptions {
  /** Linear issue ID (optional, auto-detected if not provided) */
  issueId?: string;
  /** GitHub PR number (optional, auto-detected if not provided) */
  prNumber?: string;
  /** PR URL (optional) */
  prUrl?: string;
  /** Repository directory */
  repoDir: string;
  /** Agent type (claude, codex, etc.) */
  agentType?: string;
  /** Solution model used by the agent */
  solutionModel?: string;
  /** Routing decision metadata (optional) */
  routingDecision?: any;
  /** Override eval model (optional) */
  evalModel?: string;
  /** Shared challenge pair identifier */
  challengePairId?: string;
  /** Worktree path (optional, for artifact discovery) */
  worktreePath?: string;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Run complete evaluation workflow.
 *
 * Orchestrates:
 * - Context gathering (auto-detect or explicit)
 * - Intervention detection
 * - Difficulty/task/repo analysis
 * - Outcome collection (CI, tests, review, rework, delivery)
 * - LLM judging
 * - Record enrichment
 * - Persistence to eval store
 *
 * @param options - Evaluation options
 * @returns Complete eval record
 *
 * @example
 * ```typescript
 * const record = await runEvaluation({
 *   issueId: 'HOK-123',
 *   prNumber: '456',
 *   repoDir: process.cwd(),
 *   agentType: 'claude',
 * });
 * console.log(`Score: ${record.score}`);
 * ```
 */
export async function runEvaluation(options: EvalOptions): Promise<EvalRecord> {
  const {
    issueId: explicitIssueId,
    prNumber: explicitPrNumber,
    prUrl: explicitPrUrl,
    repoDir,
    agentType = 'claude',
    solutionModel,
    routingDecision,
    evalModel,
    challengePairId,
    worktreePath,
  } = options;

  // 1. Gather context (auto-detect or explicit)
  console.log('Gathering workflow context...');

  let issueId = explicitIssueId || '';
  let prNumber = explicitPrNumber || '';
  let branch = '';
  let prUrl = explicitPrUrl || '';

  // Auto-detect if not explicitly provided
  if (!issueId && !prNumber) {
    const detected = autoDetectContext(repoDir);
    issueId = detected.issueId;
    prNumber = detected.prNumber;
    branch = detected.branch;
    prUrl = detected.prUrl;
  }

  const evalContext = gatherEvalContext({
    issueId,
    prNumber,
    prUrl,
    repoDir,
  });

  // Gather stage artifacts for judge attribution (search worktree first if provided)
  const stageArtifacts = gatherStageArtifacts(repoDir, issueId, branch, worktreePath);

  if (issueId) console.log(`  Issue: ${issueId}`);
  if (prNumber) console.log(`  PR: #${prNumber}`);
  if (evalContext.prDiff) {
    const lines = evalContext.prDiff.split('\n').length;
    console.log(`  Diff: ${lines} lines`);
  }

  // 2. Apply model override if specified
  if (evalModel) {
    process.env.EVAL_MODEL = evalModel;
  }

  // 3. Detect intervention events
  console.log('\nDetecting intervention events...');

  // Ensure we have branch name for intervention detection
  if (!branch) {
    try {
      branch = execShellCommand('git branch --show-current', {
        encoding: 'utf-8',
        cwd: repoDir,
      }).trim();
    } catch {
      // Best-effort
    }
  }

  const runInterventionAnalysis = () =>
    Promise.resolve().then(() => {
      const interventionSummary = detectAllInterventions({
        prNumber,
        branchName: branch,
        baseBranch: 'main',
        repoDir,
        agentType,
        issueId,
      });

      const interventionMeta = toInterventionMeta(interventionSummary);
      const interventionRecords = toInterventionRecords(interventionSummary);
      const penalties = loadPenalties(repoDir);
      const interventionText = formatForJudge(interventionSummary, penalties);

      const totalInterventions = interventionSummary.interventions.reduce(
        (sum, e) => sum + e.count,
        0
      );
      console.log(
        `  Detected ${totalInterventions} intervention event(s) ` +
          `(weighted penalty: ${interventionSummary.totalInterventionScore})`
      );

      return {
        interventionSummary,
        interventionMeta,
        interventionRecords,
        interventionText,
      };
    });

  const [
    {
      interventionSummary,
      interventionMeta,
      interventionRecords,
      interventionText,
    },
    { difficultyData, repoContextData, taskContextData },
  ] = await Promise.all([
    runInterventionAnalysis(),
    runEvalAnalysis({
      prDiff: evalContext.prDiff,
      prNumber,
      repoDir,
      issueData: evalContext.issueData,
      logPrefix: '\n',
    }),
  ]);

  // 7. Collect outcome components
  console.log('\nCollecting outcome components...');
  const outcomes: Outcomes = {
    success: false, // Will be set after scoring based on score threshold
    ci: prNumber
      ? collectCiOutcome(prNumber, repoDir)
      : undefined,
    tests:
      prNumber && branch
        ? collectTestsOutcome(prNumber, branch, 'main', repoDir)
        : undefined,
    staticAnalysis:
      prNumber && branch
        ? collectStaticAnalysisOutcome(prNumber, branch, 'main', repoDir)
        : undefined,
    review: prNumber
      ? collectReviewOutcome(prNumber, interventionSummary, repoDir, undefined, issueId, branch)
      : {
          humanReviewRequired: interventionSummary.interventions.some(
            (e) => e.type === 'review_comment' && e.count > 0
          ),
          rounds: 0,
          approvals: 0,
          changeRequests: 0,
        },
    rework: collectReworkOutcome(repoDir, branch, agentType, repoDir),
    delivery: prNumber
      ? collectDeliveryOutcome(prNumber, repoDir)
      : {
          prCreated: false,
          merged: false,
        },
  };

  console.log(
    `  CI: ${outcomes.ci?.ran ? (outcomes.ci.passed ? 'passed' : 'failed') : 'not run'}`
  );
  console.log(`  Tests: ${outcomes.tests?.added ? 'added' : 'none added'}`);
  console.log(
    `  Review: ${outcomes.review.approvals} approvals, ${outcomes.review.changeRequests} change requests`
  );
  console.log(`  Rework: ${outcomes.rework.agentIterations} iterations`);
  console.log(
    `  Delivery: ${outcomes.delivery.merged ? 'merged' : outcomes.delivery.prCreated ? 'PR created' : 'no PR'}`
  );

  // 8. Invoke judge via shared evaluateTask()
  console.log('\nInvoking LLM judge...');
  // Use explicitly provided routing decision, or fall back to auto-loaded one
  const effectiveRoutingDecision = routingDecision ?? stageArtifacts.routingDecision;

  const record = await evaluateTask(
    {
      taskPrompt: evalContext.taskPrompt,
      prReviewOutput: evalContext.prDiff,
      interventions: interventionMeta,
      interventionRecords,
      interventionText,
      issueId: issueId || undefined,
      prUrl: prUrl || undefined,
      routingDecision: effectiveRoutingDecision,
      taskPacket: stageArtifacts.taskPacket,
      planContent: stageArtifacts.planContent,
      selfReviewSummary: stageArtifacts.selfReviewSummary,
      metadata: { interventionSummary },
    },
    outcomes
  );

  // 9. Set success flag based on score threshold
  if (record.outcomes) {
    record.outcomes.success = (record.score as number) >= 0.5;
  }

  // 9b. Build task descriptor for router training (HOK-1120)
  let taskDescriptor = null;
  let evalConstraints: EvalConstraints | undefined;
  try {
    // Derive feature slug from branch or issue ID
    const slug = branch.replace(/^(task|bug)\//, '') || issueId.toLowerCase();

    // Fetch raw routing data
    const routingComplete = slug
      ? fetchRoutingCompleteRaw(repoDir, slug, worktreePath)
      : null;
    evalConstraints = resolveEvalConstraints(routingComplete, repoDir);

    // Build descriptor from all gathered context
    taskDescriptor = buildTaskDescriptor({
      originalPrompt: evalContext.originalPrompt,
      prDiff: evalContext.prDiff,
      taskContext: taskContextData || undefined,
      repoContext: repoContextData || undefined,
      difficultySignals: difficultyData?.difficultySignals || undefined,
      routingDecision: effectiveRoutingDecision || undefined,
      routingComplete: routingComplete || undefined,
      stageOutcomes: record.stageOutcomes || undefined,
      workflowCost: record.workflowCost || undefined,
      workflowTokenUsage: record.workflowTokenUsage || undefined,
      score: record.score || undefined,
      timeSeconds: record.timeSeconds || undefined,
      interventionCount: record.interventionCount || undefined,
      interventions: interventionRecords || undefined,
      modelsAvailable: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
      objective: 'balanced',
      maxCostUsd: evalConstraints?.maxCostUsd,
    });
  } catch (err) {
    const errorMsg = errorMessage(err);
    console.warn(`Warning: failed to build task descriptor: ${errorMsg}`);
  }

  // 10. Enrich record with metadata
  enrichEvalRecord(record, {
    agentType,
    challengePairId,
    difficulty: difficultyData,
    taskContext: taskContextData,
    repoContext: repoContextData,
    taskDescriptor,
    constraints: evalConstraints,
  });

  // 11. Set solution model if provided
  if (solutionModel) {
    record.modelId = solutionModel;
    record.modelVersion = solutionModel;
  }

  // 12. Persist eval record to disk
  try {
    appendEvalRecord(record);
  } catch (err) {
    const errorMsg = errorMessage(err);
    console.error(`Warning: failed to persist eval record: ${errorMsg}`);
  }

  return record;
}
