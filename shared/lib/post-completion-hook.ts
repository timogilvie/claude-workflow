/**
 * Post-completion hook for wavemill workflows.
 *
 * Automatically triggers eval after a workflow finishes (PR created).
 * Non-blocking: eval failures log a warning but never fail the workflow.
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import path from 'node:path';
import { evaluateTask } from './eval.ts';
import { appendEvalRecord } from './eval-persistence.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { execShellCommand } from './shell-utils.ts';
import { detectAndFormatInterventions } from './intervention-detector.ts';
import { computeWorkflowCost, loadPricingTable } from './workflow-cost.ts';
import { getDeepSeekProviderMetadata } from './deepseek-provider.ts';
import { runEvalAnalysis } from './eval-analysis.ts';
import { callClaude } from './llm-cli.ts';
import { detectSubsystems } from './subsystem-detector.ts';
import { formatLintResults, lintSubsystemSpecs } from './context-linter.ts';
import { updateAffectedSubsystems } from './subsystem-updater.ts';
import { detectAffectedSubsystems } from './subsystem-mapper.ts';
import { gatherEvalContext, gatherStageArtifacts } from './eval-context-gatherer.ts';
import { fetchRoutingCompleteRawWithArchive } from './eval-context-gatherer.ts';
import { attachStageOutcomes, enrichTrainingMetadata } from './eval-record-builder.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import { getMaxCostUsd, getPostEvalConfig } from './config.ts';
import { getConfiguredModelsForDescriptor } from './model-registry.ts';
import { getCurrentOperatingMode } from './operating-mode.ts';
import { isEvalSuccess } from './eval-success-policy.ts';
import {
  collectCiOutcome,
  collectTestsOutcome,
  collectStaticAnalysisOutcome,
  collectReviewOutcome,
  collectReworkOutcome,
  collectDeliveryOutcome,
} from './outcome-collectors.ts';
import {
  buildRouteLifecycleProvenance,
  deriveRouteDecisionSource,
  readRouteLifecycleArtifacts,
} from './route-artifact.ts';
import { printEvalSummary, formatDifficultyDisplay, formatTaskContextDisplay, formatRepoContextDisplay, formatInterventionDisplay } from './eval-summary-printer.ts';
import { errorMessage } from './error-utils.ts';
import type { EvalRecord, EvalRouteProvenance, InterventionRecord, RoutingDecision, TaskContext, RepoContext, Outcomes } from './eval-schema.ts';
import type { DifficultyAnalysis } from './difficulty-analyzer.ts';
import type { ChallengeRouteContext } from './challenge-mode.ts';
import type { WorkflowCostOutcome } from './workflow-cost.ts';
import type { InterventionSummary } from './intervention-detector.ts';

function isFiniteNonNegativeBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function resolvePostCompletionBudget(input: Pick<PostCompletionEnrichmentInput, 'repoDir' | 'issueId' | 'branchName' | 'worktreePath' | 'record'>): number | undefined {
  const slug = input.branchName?.replace(/^(task|bug)\//, '') || input.issueId?.toLowerCase() || '';
  const routingComplete = slug
    ? fetchRoutingCompleteRawWithArchive(input.repoDir, slug, input.issueId || '', input.worktreePath)
    : null;
  return [
    input.record.constraints?.maxCostUsd,
    routingComplete?.maxCostUsd,
    routingComplete?.constraints?.maxCostUsd,
    getMaxCostUsd(input.repoDir),
  ].find(isFiniteNonNegativeBudget);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ────────────────────────────────────────────────────────────────
// Post-Eval Update Settings
// ────────────────────────────────────────────────────────────────

export interface PostEvalUpdateSettings {
  shouldRun: boolean;
  reason?: 'env' | 'config' | 'degraded-mode';
  timeoutMs: number;
  activityTimeoutMs: number;
  maxRetries: number;
}

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

let operatingModeWarned = false;

/**
 * Resolve whether post-eval context/subsystem updates should run.
 *
 * Precedence:
 * 1. WAVEMILL_SKIP_POST_EVAL_CONTEXT env var (if truthy)
 * 2. postEval.skipContextUpdates config
 * 3. postEval.skipInDegradedModes + current operating mode
 * 4. Default: run with configured timeouts/retries
 */
export function resolvePostEvalUpdateSettings(
  repoDir: string,
  env: NodeJS.ProcessEnv = process.env
): PostEvalUpdateSettings {
  const config = getPostEvalConfig(repoDir);

  // Check env var first (highest precedence)
  if (isTruthyEnvValue(env.WAVEMILL_SKIP_POST_EVAL_CONTEXT)) {
    return {
      shouldRun: false,
      reason: 'env',
      timeoutMs: config.timeoutMs,
      activityTimeoutMs: config.activityTimeoutMs,
      maxRetries: config.maxRetries,
    };
  }

  // Check config skip
  if (config.skipContextUpdates) {
    return {
      shouldRun: false,
      reason: 'config',
      timeoutMs: config.timeoutMs,
      activityTimeoutMs: config.activityTimeoutMs,
      maxRetries: config.maxRetries,
    };
  }

  // Check degraded mode skip
  if (config.skipInDegradedModes) {
    let operatingMode: 'normal' | 'constrained' | 'survival' = 'normal';
    try {
      operatingMode = postCompletionHookDeps.getCurrentOperatingMode(repoDir);
    } catch (err) {
      if (!operatingModeWarned) {
        console.warn(
          `Post-eval settings: failed to read operating mode — ${errorMessage(err)}. ` +
          'Continuing in normal mode.'
        );
        operatingModeWarned = true;
      }
    }

    if (operatingMode === 'constrained' || operatingMode === 'survival') {
      return {
        shouldRun: false,
        reason: 'degraded-mode',
        timeoutMs: config.timeoutMs,
        activityTimeoutMs: config.activityTimeoutMs,
        maxRetries: config.maxRetries,
      };
    }
  }

  // Default: run updates with configured bounds
  return {
    shouldRun: true,
    timeoutMs: config.timeoutMs,
    activityTimeoutMs: config.activityTimeoutMs,
    maxRetries: config.maxRetries,
  };
}

// ────────────────────────────────────────────────────────────────
// Post-Eval Warning Diagnostics
// ────────────────────────────────────────────────────────────────

export interface PostEvalWarningRecord {
  timestamp: string;
  issueId?: string;
  prUrl?: string;
  phase: 'project-context' | 'subsystem-update' | 'post-eval-updates';
  reason: 'timeout' | 'non-zero-exit' | 'error' | 'unknown';
  message: string;
  command?: string;
  model?: string;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
  attempts?: number;
  stderrTail?: string;
}

/**
 * Write a post-eval warning to the sidecar JSONL file.
 * Best-effort: failures are logged but don't throw.
 */
function writePostEvalWarning(
  warning: PostEvalWarningRecord,
  repoDir: string
): void {
  try {
    const { dir: evalsDir } = resolveEvalsDir(undefined, repoDir);
    const warningPath = join(evalsDir, 'post-eval-warnings.jsonl');
    const line = JSON.stringify(warning) + '\n';
    appendFileSync(warningPath, line, 'utf-8');
  } catch (err) {
    console.warn(
      `Failed to write post-eval warning to sidecar file: ${errorMessage(err)}`
    );
  }
}

export interface PostCompletionContext {
  issueId?: string;
  prNumber?: string;
  prUrl?: string;
  workflowType: string;
  repoDir?: string;
  branchName?: string;
  worktreePath?: string;
  agentType?: string;
  solutionModel?: string;
  challengePairId?: string;
}

interface PostCompletionOutcomeInput {
  prNumber?: string;
  branchName?: string;
  repoDir: string;
  worktreePath?: string;
  agentType?: string;
  issueId?: string;
  interventionSummary: InterventionSummary;
}

function defaultReviewOutcome(interventionSummary: InterventionSummary) {
  return {
    humanReviewRequired: interventionSummary.interventions.some(
      (entry) => entry.type === 'review_comment' && entry.count > 0
    ),
    rounds: 0,
    approvals: 0,
    changeRequests: 0,
  };
}

function safeCollectOutcome<T>(
  label: string,
  fallback: T,
  collector: () => T,
): T {
  try {
    return collector();
  } catch (err) {
    console.warn(`Post-completion eval: failed to collect ${label} outcome - ${errorMessage(err)}`);
    return fallback;
  }
}

export const postCompletionHookDeps = {
  gatherEvalContext,
  gatherStageArtifacts,
  execShellCommand,
  detectAndFormatInterventions,
  runEvalAnalysis,
  evaluateTask,
  appendEvalRecord,
  collectCiOutcome,
  collectTestsOutcome,
  collectStaticAnalysisOutcome,
  collectReviewOutcome,
  collectReworkOutcome,
  collectDeliveryOutcome,
  updateProjectContext,
  getCurrentOperatingMode,
};

export function collectPostCompletionOutcomes(input: PostCompletionOutcomeInput): Outcomes {
  const {
    prNumber,
    branchName,
    repoDir,
    worktreePath,
    agentType,
    issueId,
    interventionSummary,
  } = input;
  const reviewFallback = defaultReviewOutcome(interventionSummary);

  return {
    success: false,
    ci: prNumber
      ? safeCollectOutcome('ci', { ran: false, passed: true, checks: [] }, () =>
          postCompletionHookDeps.collectCiOutcome(prNumber, repoDir))
      : undefined,
    tests: prNumber && branchName
      ? safeCollectOutcome('tests', { added: false }, () =>
          postCompletionHookDeps.collectTestsOutcome(prNumber, branchName, 'main', repoDir))
      : undefined,
    staticAnalysis: prNumber && branchName
      ? safeCollectOutcome('static analysis', {}, () =>
          postCompletionHookDeps.collectStaticAnalysisOutcome(prNumber, branchName, 'main', repoDir))
      : undefined,
    review: prNumber
      ? safeCollectOutcome('review', reviewFallback, () =>
          postCompletionHookDeps.collectReviewOutcome(
            prNumber,
            interventionSummary,
            repoDir,
            undefined,
            issueId,
            branchName,
          ))
      : reviewFallback,
    rework: branchName
      ? safeCollectOutcome('rework', { agentIterations: 0 }, () =>
          postCompletionHookDeps.collectReworkOutcome(worktreePath || repoDir, branchName, agentType, repoDir))
      : { agentIterations: 0 },
    delivery: prNumber
      ? safeCollectOutcome('delivery', { prCreated: false, merged: false }, () =>
          postCompletionHookDeps.collectDeliveryOutcome(prNumber, repoDir))
      : { prCreated: false, merged: false },
  };
}

interface PostCompletionEnrichmentInput {
  repoDir: string;
  issueId?: string;
  branchName?: string;
  worktreePath?: string;
  agentType?: string;
  challengePairId?: string;
  originalPrompt: string;
  prDiff: string;
  record: EvalRecord;
  difficultyData: DifficultyAnalysis | null;
  taskContextData: TaskContext | null;
  repoContextData: RepoContext | null;
  costOutcome: WorkflowCostOutcome | null;
  interventionRecords: InterventionRecord[];
  routingDecision?: RoutingDecision;
}

function resolveRouteArtifactDirs(
  repoDir: string,
  branchName: string | undefined,
  worktreePath: string | undefined,
  issueId: string | undefined,
): { featureDir?: string; archiveDir?: string } {
  const slugFromBranch = branchName?.replace(/^(task|bug)\//, '');
  const slug = slugFromBranch && slugFromBranch !== branchName
    ? slugFromBranch
    : worktreePath
      ? path.basename(worktreePath)
      : '';

  return {
    ...(slug && worktreePath ? { featureDir: join(worktreePath, 'features', slug) } : {}),
    ...(issueId ? { archiveDir: join(repoDir, '.wavemill', 'evals', 'artifacts', issueId) } : {}),
  };
}

function deriveChallengeRouteContext(
  repoDir: string,
  issueId: string | undefined,
  branchName: string | undefined,
  worktreePath: string | undefined,
): ChallengeRouteContext | null {
  const { featureDir, archiveDir } = resolveRouteArtifactDirs(repoDir, branchName, worktreePath, issueId);
  const { bootstrap, expanded, active } = readRouteLifecycleArtifacts(featureDir, archiveDir);
  if (!bootstrap && !expanded) {
    return null;
  }

  const decisionSource = deriveRouteDecisionSource({ bootstrap, expanded, active }, repoDir) ?? 'bootstrap';

  return {
    decisionSource,
    ...(bootstrap ? { bootstrapRoute: bootstrap } : {}),
    ...(expanded ? { expandedRoute: expanded } : {}),
    ...(decisionSource === 'preserved'
      ? { refreshRationale: 'expanded route matches bootstrap on coder class/depth' }
      : {}),
  };
}

function deriveRouteProvenance(
  repoDir: string,
  issueId: string | undefined,
  branchName: string | undefined,
  worktreePath: string | undefined,
): EvalRouteProvenance | null {
  const { featureDir, archiveDir } = resolveRouteArtifactDirs(repoDir, branchName, worktreePath, issueId);
  return buildRouteLifecycleProvenance(readRouteLifecycleArtifacts(featureDir, archiveDir), repoDir);
}

export function buildTaskDescriptorForPostCompletion(
  input: Omit<PostCompletionEnrichmentInput, 'agentType' | 'challengePairId'>,
) {
  attachStageOutcomes(
    input.record,
    input.record.metadata?.stageScores as Record<string, { score: number; rationale: string }> | undefined,
  );

  const slug = input.branchName?.replace(/^(task|bug)\//, '') || input.issueId?.toLowerCase() || '';
  const routingComplete = slug
    ? fetchRoutingCompleteRawWithArchive(input.repoDir, slug, input.issueId || '', input.worktreePath)
    : null;
  const workflowCost = input.costOutcome?.status === 'success'
    ? input.costOutcome.totalCostUsd
    : input.record.workflowCost;
  const workflowTokenUsage = input.costOutcome?.status === 'success'
    ? input.costOutcome.models
    : input.record.workflowTokenUsage;
  const maxCostUsd = resolvePostCompletionBudget(input);

  return buildTaskDescriptor({
    originalPrompt: input.originalPrompt,
    prDiff: input.prDiff,
    taskContext: input.taskContextData || undefined,
    repoContext: input.repoContextData || undefined,
    difficultySignals: input.difficultyData?.difficultySignals || undefined,
    routingDecision: input.routingDecision || undefined,
    routingComplete: routingComplete || undefined,
    stageOutcomes: input.record.stageOutcomes || undefined,
    workflowCost: workflowCost || undefined,
    workflowTokenUsage: workflowTokenUsage || undefined,
    score: input.record.score || undefined,
    timeSeconds: input.record.timeSeconds || undefined,
    interventionCount: input.record.interventionCount || undefined,
    interventions: input.interventionRecords || undefined,
    rubricEval: input.record.rubricEval || undefined,
    modelsAvailable: getConfiguredModelsForDescriptor(input.repoDir),
    objective: 'balanced',
    maxCostUsd,
  });
}

export function enrichPostCompletionRecord(
  record: EvalRecord,
  input: PostCompletionEnrichmentInput,
): void {
  let taskDescriptor = null;
  try {
    taskDescriptor = buildTaskDescriptorForPostCompletion(input);
  } catch (err) {
    const errorMsg = errorMessage(err);
    console.warn(`Post-completion eval: failed to build task descriptor — ${errorMsg}`);
  }

  enrichTrainingMetadata(record, {
    agentType: input.agentType,
    provider: getDeepSeekProviderMetadata(record.modelId, input.repoDir)?.provider,
    endpoint: getDeepSeekProviderMetadata(record.modelId, input.repoDir)?.endpoint,
    challengePairId: input.challengePairId,
    routeProvenance: deriveRouteProvenance(
      input.repoDir,
      input.issueId,
      input.branchName,
      input.worktreePath,
    ),
    challengeRouteContext: input.challengePairId
      ? deriveChallengeRouteContext(input.repoDir, input.issueId, input.branchName, input.worktreePath)
      : null,
    difficulty: input.difficultyData,
    taskContext: input.taskContextData,
    repoContext: input.repoContextData,
    workflowCost: input.costOutcome,
    taskDescriptor,
    constraints: (() => {
      const maxCostUsd = resolvePostCompletionBudget(input);
      return typeof maxCostUsd === 'number' ? { maxCostUsd } : undefined;
    })(),
  });
}

/**
 * Run optional post-eval context and subsystem updates.
 *
 * This is a best-effort phase that runs after the core eval record has been persisted.
 * Failures are logged as warnings but never fail the eval.
 */
async function runPostEvalOptionalUpdates(
  ctx: PostCompletionContext,
  prDiff: string,
  issueContext: string,
  repoDir: string
): Promise<void> {
  const settings = resolvePostEvalUpdateSettings(repoDir);

  if (!settings.shouldRun) {
    console.log(`Post-eval updates: skipped (reason=${settings.reason})`);
    return;
  }

  const startTime = Date.now();
  try {
    await postCompletionHookDeps.updateProjectContext(
      ctx,
      prDiff,
      issueContext,
      {
        timeoutMs: settings.timeoutMs,
        activityTimeoutMs: settings.activityTimeoutMs,
        maxRetries: settings.maxRetries,
      }
    );
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    const message = errorMessage(error);

    // Determine reason from error message
    let reason: PostEvalWarningRecord['reason'] = 'error';
    let timedOut = false;
    if (message.includes('timeout') || message.includes('timed out')) {
      reason = 'timeout';
      timedOut = true;
    } else if (message.includes('exit code') || message.includes('exited with')) {
      reason = 'non-zero-exit';
    }

    const warning: PostEvalWarningRecord = {
      timestamp: new Date().toISOString(),
      issueId: ctx.issueId,
      prUrl: ctx.prUrl,
      phase: 'post-eval-updates',
      reason,
      message,
      command: 'claude',
      model: 'claude-haiku-4-5-20251001',
      timedOut,
      durationMs,
      attempts: settings.maxRetries + 1,
    };

    console.warn(
      `[post-eval-warning] phase=${warning.phase} issue=${warning.issueId || 'unknown'} ` +
      `reason=${warning.reason} message=${warning.message.substring(0, 100)}`
    );

    writePostEvalWarning(warning, repoDir);
  }
}

/**
 * Run the post-completion eval hook.
 *
 * Callers are responsible for gating on autoEval before invoking this function
 * (e.g. the mill script checks AUTO_EVAL, the workflow command calls explicitly).
 *
 * - Gathers context (issue details, PR diff).
 * - Invokes the LLM judge via evaluateTask().
 * - Persists the result via appendEvalRecord() from eval-persistence.
 * - Never throws: all errors are caught and logged as warnings.
 * - Returns true only after the eval record has been persisted.
 */
export async function runPostCompletionEval(ctx: PostCompletionContext): Promise<boolean> {
  const repoDir = ctx.repoDir || process.cwd();
  const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';
  let persisted = false;

  // Always log that we entered this function (for debugging)
  console.log('Post-completion eval: DEBUG_COST=' + (debug ? 'enabled' : 'disabled'));

  // Log received context for diagnostics
  if (debug) {
    console.log('[DEBUG_COST] ========================================');
    console.log('[DEBUG_COST] runPostCompletionEval() called with context:');
    console.log(`[DEBUG_COST]   issueId: ${ctx.issueId || '(undefined)'}`);
    console.log(`[DEBUG_COST]   prNumber: ${ctx.prNumber || '(undefined)'}`);
    console.log(`[DEBUG_COST]   prUrl: ${ctx.prUrl || '(undefined)'}`);
    console.log(`[DEBUG_COST]   workflowType: ${ctx.workflowType}`);
    console.log(`[DEBUG_COST]   repoDir: ${repoDir}`);
    console.log(`[DEBUG_COST]   branchName: ${ctx.branchName || '(undefined)'}`);
    console.log(`[DEBUG_COST]   worktreePath: ${ctx.worktreePath || '(undefined)'}`);
    console.log(`[DEBUG_COST]   agentType: ${ctx.agentType || '(undefined)'}`);
    console.log('[DEBUG_COST] ========================================');
  }

  if (!ctx.issueId && !ctx.prNumber) {
    console.warn('Post-completion eval: skipped (no issue ID or PR number provided)');
    return false;
  }

  try {
    console.log('Post-completion eval: gathering context...');

    // 1. Gather eval context (issue + PR data)
    const evalContext = postCompletionHookDeps.gatherEvalContext({
      issueId: ctx.issueId,
      prNumber: ctx.prNumber,
      prUrl: ctx.prUrl,
      repoDir,
    });

    // 2. Gather stage artifacts for judge attribution
    let branchName = ctx.branchName || '';
    if (!branchName) {
      try {
        branchName = execShellCommand('git branch --show-current', {
          encoding: 'utf-8', cwd: repoDir,
        }).trim();
      } catch { /* best-effort */ }
    }

    const stageArtifacts = postCompletionHookDeps.gatherStageArtifacts(
      repoDir,
      ctx.issueId || '',
      branchName,
      ctx.worktreePath
    );

    // 3. Detect all interventions
    console.log('Post-completion eval: detecting interventions...');

    const interventionData = postCompletionHookDeps.detectAndFormatInterventions({
      prNumber: ctx.prNumber,
      branchName,
      baseBranch: 'main',
      repoDir,
      worktreePath: ctx.worktreePath,
      agentType: ctx.agentType,
    });

    console.log(`Post-completion eval: ${formatInterventionDisplay(interventionData.totalCount)}`);

    // 3. Run independent analyses in parallel (non-blocking, failures logged as warnings)
    const { difficultyData, repoContextData, taskContextData } = await postCompletionHookDeps.runEvalAnalysis({
      prDiff: evalContext.prDiff,
      prNumber: ctx.prNumber,
      repoDir,
      issueData: evalContext.issueData,
      logPrefix: 'Post-completion eval: ',
      formatters: {
        difficulty: formatDifficultyDisplay,
        repoContext: formatRepoContextDisplay,
        taskContext: formatTaskContextDisplay,
      },
    });

    const outcomes = collectPostCompletionOutcomes({
      prNumber: ctx.prNumber,
      branchName,
      repoDir,
      worktreePath: ctx.worktreePath,
      agentType: ctx.agentType,
      issueId: ctx.issueId,
      interventionSummary: interventionData.summary,
    });

    // 4. Run eval judge
    console.log('Post-completion eval: invoking LLM judge...');
    const record = await postCompletionHookDeps.evaluateTask(
      {
        taskPrompt: evalContext.taskPrompt,
        prReviewOutput: evalContext.prDiff,
        interventions: interventionData.meta,
        interventionRecords: interventionData.records,
        interventionText: interventionData.text,
        issueId: ctx.issueId || undefined,
        prUrl: evalContext.prUrl || undefined,
        metadata: { workflowType: ctx.workflowType, hookTriggered: true, interventionSummary: interventionData.summary },
        taskPacket: stageArtifacts.taskPacket,
        planContent: stageArtifacts.planContent,
        selfReviewSummary: stageArtifacts.selfReviewSummary,
        routingDecision: stageArtifacts.routingDecision,
      },
      outcomes,
    );

    const executionModel = ctx.solutionModel || stageArtifacts.executionModel;
    if (executionModel) {
      record.modelId = executionModel;
      record.modelVersion = executionModel;
    }
    if (record.outcomes) {
      record.outcomes.success = isEvalSuccess(record);
    }

    // 5. Compute workflow cost
    let costOutcome: ReturnType<typeof computeWorkflowCost> | null = null;
    if (ctx.worktreePath && branchName) {
      console.log('Post-completion eval: computing workflow cost...');

      if (debug) {
        console.log('[DEBUG_COST] Cost computation parameters:');
        console.log(`[DEBUG_COST]   worktreePath: ${ctx.worktreePath}`);
        console.log(`[DEBUG_COST]   branchName: ${branchName}`);
        console.log(`[DEBUG_COST]   agentType: ${ctx.agentType || 'claude'}`);
      }

      try {
        const wavemillConfigDir = resolve(__dirname, '../..');
        const pricingTable = loadPricingTable(wavemillConfigDir);

        if (debug) {
          console.log(`[DEBUG_COST]   Loaded pricing for ${Object.keys(pricingTable).length} model(s)`);
        }

        costOutcome = computeWorkflowCost({
          worktreePath: ctx.worktreePath,
          branchName,
          repoDir,
          pricingTable,
          agentType: ctx.agentType,
        });

        if (costOutcome.status === 'success') {
          console.log(
            `Post-completion eval: workflow cost $${costOutcome.totalCostUsd.toFixed(4)} ` +
            `(${costOutcome.turnCount} turns across ${costOutcome.sessionCount} session(s))`
          );
        } else {
          console.warn(
            `Post-completion eval: workflow cost computation failed (${costOutcome.status}) — ${costOutcome.reason}`
          );
          if (!debug) {
            console.log('Post-completion eval: run with DEBUG_COST=1 for detailed diagnostics');
          }
        }
      } catch (costErr: unknown) {
        const costMsg = errorMessage(costErr);
        console.warn(`Post-completion eval: workflow cost computation failed — ${costMsg}`);
      }
    } else {
      // Create skipped outcome with diagnostics
      const missingParams = [];
      if (!ctx.worktreePath) missingParams.push('worktreePath');
      if (!branchName) missingParams.push('branchName');

      costOutcome = {
        status: 'skipped',
        reason: `Required parameters missing: ${missingParams.join(', ')}`,
        diagnostics: {
          worktreePath: ctx.worktreePath,
          branchName,
          agentType: ctx.agentType || 'claude',
        },
      };

      if (debug) {
        console.log('[DEBUG_COST] Skipping cost computation - missing: ' + missingParams.join(', '));
      }
      console.log('Post-completion eval: skipping workflow cost (missing worktreePath or branchName)');
    }

    // 6. Enrich record with all metadata
    enrichPostCompletionRecord(record, {
      repoDir,
      issueId: ctx.issueId,
      branchName,
      worktreePath: ctx.worktreePath,
      agentType: ctx.agentType,
      challengePairId: ctx.challengePairId,
      originalPrompt: evalContext.taskPrompt,
      prDiff: evalContext.prDiff,
      record,
      difficultyData,
      taskContextData,
      repoContextData,
      costOutcome,
      interventionRecords: interventionData.records,
      routingDecision: stageArtifacts.routingDecision,
    });

    // 7. Persist
    const { dir: evalsDir } = resolveEvalsDir(undefined, repoDir);
    postCompletionHookDeps.appendEvalRecord(record, { dir: evalsDir });
    persisted = true;

    // 8. Print summary (immediately after persistence, before optional work)
    printEvalSummary(record);

    // 9. Run optional post-eval updates (best-effort, bounded)
    await runPostEvalOptionalUpdates(ctx, evalContext.prDiff, evalContext.taskPrompt, repoDir);

    return true;
  } catch (error: unknown) {
    const message = errorMessage(error);
    console.warn(`Post-completion eval: failed (workflow unaffected) — ${message}`);
    return persisted;
  }
}

export interface PostEvalUpdateOptions {
  timeoutMs?: number;
  activityTimeoutMs?: number;
  maxRetries?: number;
}

/**
 * Update project context after PR merge.
 *
 * Analyzes the PR diff and generates a summary to append to project-context.md.
 * Non-blocking: failures log warnings but don't fail the workflow.
 */
async function updateProjectContext(
  ctx: PostCompletionContext,
  prDiff: string,
  issueContext: string,
  options?: PostEvalUpdateOptions
): Promise<void> {
  const repoDir = ctx.repoDir || process.cwd();
  const contextPath = join(repoDir, '.wavemill', 'project-context.md');

  // Skip if project-context.md doesn't exist (not initialized)
  if (!existsSync(contextPath)) {
    console.log('Project context: skipped (not initialized — run init-project-context.ts)');
    return;
  }

  try {
    console.log('Project context: generating update...');

    // Generate summary using Claude CLI
    const summary = await generateContextUpdate({
      issueId: ctx.issueId || 'Unknown',
      prUrl: ctx.prUrl || '',
      prDiff,
      issueContext,
    }, options);

    // Append to project-context.md
    appendContextUpdate(contextPath, summary);

    console.log('Project context: updated successfully');

    // Update subsystem specs (cold memory)
    await updateSubsystemSpecs(ctx, prDiff, issueContext, repoDir, options);

    const lintResults = await lintSubsystemSpecs(repoDir, {
      rules: ['orphaned-spec', 'missing-spec'],
    });
    if (lintResults.length > 0) {
      console.log('\nSpec lint results:');
      console.log(formatLintResults(lintResults));
    }

  } catch (error: unknown) {
    const message = errorMessage(error);
    console.warn(`Project context: update failed — ${message}`);
  }
}

/**
 * Update subsystem specs after PR merge.
 *
 * Detects affected subsystems and updates their specifications.
 * Non-blocking: failures log warnings but don't fail the workflow.
 */
async function updateSubsystemSpecs(
  ctx: PostCompletionContext,
  prDiff: string,
  issueContext: string,
  repoDir: string,
  options?: PostEvalUpdateOptions
): Promise<void> {
  const contextDir = join(repoDir, '.wavemill', 'context');

  // Skip if context directory doesn't exist
  if (!existsSync(contextDir)) {
    console.log('Subsystem update: skipped (no subsystem specs found)');
    return;
  }

  try {
    // Detect subsystems
    console.log('Subsystem update: detecting subsystems...');
    const subsystems = detectSubsystems(repoDir, {
      minFiles: 3,
      useGitAnalysis: false, // Skip git analysis for speed
      maxSubsystems: 20,
    });

    if (subsystems.length === 0) {
      console.log('Subsystem update: no subsystems detected');
      return;
    }

    // Extract issue title from context
    const titleMatch = issueContext.match(/^#\s*[A-Z]+-\d+:\s*(.+)$/m);
    const issueTitle = titleMatch ? titleMatch[1] : 'Unknown';

    // Detect affected subsystems before updating
    const affectedSubsystems = detectAffectedSubsystems(prDiff, subsystems, repoDir);

    // Knowledge gap detection: warn if PR has significant changes but no subsystems matched
    if (affectedSubsystems.length === 0) {
      const prSize = prDiff.split('\n').length;
      if (prSize > 100) {
        console.log('');
        console.log('⚠️  KNOWLEDGE GAP: No subsystem specs matched this PR');
        console.log(`   PR has ${prSize} lines of changes, but no subsystem docs were updated`);
        console.log('   This may indicate:');
        console.log('   - New subsystem(s) introduced in this PR');
        console.log('   - Subsystem specs are incomplete or missing');
        console.log('');
        console.log('   Recommendation: Run the following to create/update subsystem docs:');
        console.log('     wavemill context init --force');
        console.log('');
        console.log('   This enables "persistent downstream acceleration" for future tasks');
        console.log('   (per Codified Context paper, Case Study 3)');
        console.log('');
      }
    }

    // Update affected subsystems
    await updateAffectedSubsystems(subsystems, {
      issueId: ctx.issueId || 'Unknown',
      issueTitle,
      prUrl: ctx.prUrl || '',
      prDiff,
      issueDescription: issueContext,
      repoDir,
    }, options);

  } catch (error: unknown) {
    const message = errorMessage(error);
    console.warn(`Subsystem update: failed — ${message}`);
  }
}

/**
 * Generate a context update summary from PR diff using Claude CLI.
 */
async function generateContextUpdate(opts: {
  issueId: string;
  prUrl: string;
  prDiff: string;
  issueContext: string;
}, updateOptions?: PostEvalUpdateOptions): Promise<string> {
  const promptPath = resolve(__dirname, '../../tools/prompts/context-update-template.md');
  const promptTemplate = readFileSync(promptPath, 'utf-8');

  // Extract issue title from context
  const titleMatch = opts.issueContext.match(/^#\s*[A-Z]+-\d+:\s*(.+)$/m);
  const issueTitle = titleMatch ? titleMatch[1] : 'Unknown';

  // Fill in template placeholders
  const timestamp = new Date().toISOString();
  const prompt = promptTemplate
    .replace('{TIMESTAMP}', timestamp)
    .replace('{ISSUE_ID}', opts.issueId)
    .replace('{ISSUE_TITLE}', issueTitle)
    .replace('{PR_URL}', opts.prUrl)
    .replace('{ISSUE_DESCRIPTION}', opts.issueContext)
    .replace('{PR_DIFF}', opts.prDiff.substring(0, 50000)); // Limit diff size

  const claudeCmd = process.env.CLAUDE_CMD || 'claude';
  const timeoutMs = updateOptions?.timeoutMs ?? 300_000;
  const activityTimeoutMs = updateOptions?.activityTimeoutMs ?? 60_000;
  const maxRetries = updateOptions?.maxRetries ?? 1;

  const result = await callClaude(prompt, {
    mode: 'stream',
    cliCmd: claudeCmd,
    model: 'claude-haiku-4-5-20251001',
    taskType: 'classify',
    timeout: timeoutMs,
    activityTimeout: activityTimeoutMs,
    retry: maxRetries > 0,
    maxRetries,
    cliFlags: [
      '--tools', '',
      '--append-system-prompt',
      'You have NO tools available. Output ONLY the markdown summary in the exact format specified. No conversational text, no preamble, no XML tags. Start directly with the heading.',
    ],
  });

  return result.text;
}

/**
 * Append a context update to project-context.md.
 */
function appendContextUpdate(contextPath: string, summary: string): void {
  const update = `\n\n${summary}\n\n---`;
  appendFileSync(contextPath, update, 'utf-8');
}
