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
import { runEvalAnalysis } from './eval-analysis.ts';
import { callClaude } from './llm-cli.ts';
import { detectSubsystems } from './subsystem-detector.ts';
import { formatLintResults, lintSubsystemSpecs } from './context-linter.ts';
import { updateAffectedSubsystems } from './subsystem-updater.ts';
import { detectAffectedSubsystems } from './subsystem-mapper.ts';
import { gatherEvalContext, gatherStageArtifacts } from './eval-context-gatherer.ts';
import { fetchRoutingCompleteRawWithArchive } from './eval-context-gatherer.ts';
import { attachStageOutcomes, enrichEvalRecord } from './eval-record-builder.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import { getMaxCostUsd } from './config.ts';
import { readBothRouteArtifacts } from './route-artifact.ts';
import { printEvalSummary, formatDifficultyDisplay, formatTaskContextDisplay, formatRepoContextDisplay, formatInterventionDisplay } from './eval-summary-printer.ts';
import { errorMessage } from './error-utils.ts';
import type { EvalRecord, InterventionRecord, RoutingDecision, TaskContext, RepoContext } from './eval-schema.ts';
import type { DifficultyAnalysis } from './difficulty-analyzer.ts';
import { routeChangedMaterially, type ChallengeRouteContext } from './challenge-mode.ts';
import type { WorkflowCostOutcome } from './workflow-cost.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

function deriveChallengeRouteContext(
  branchName: string | undefined,
  worktreePath: string | undefined,
): ChallengeRouteContext | null {
  if (!worktreePath) {
    return null;
  }

  const slugFromBranch = branchName?.replace(/^(task|bug)\//, '');
  const slug = slugFromBranch && slugFromBranch !== branchName
    ? slugFromBranch
    : path.basename(worktreePath);
  if (!slug) {
    return null;
  }

  const featureDir = join(worktreePath, 'features', slug);
  const { bootstrap, expanded } = readBothRouteArtifacts(featureDir);
  if (!bootstrap && !expanded) {
    return null;
  }

  const decisionSource = !expanded
    ? 'bootstrap'
    : !bootstrap
      ? 'expanded'
      : routeChangedMaterially(bootstrap, expanded).changed
        ? 'expanded'
        : 'preserved';

  return {
    decisionSource,
    ...(bootstrap ? { bootstrapRoute: bootstrap } : {}),
    ...(expanded ? { expandedRoute: expanded } : {}),
    ...(decisionSource === 'preserved'
      ? { refreshRationale: 'expanded route matches bootstrap on coder class/depth' }
      : {}),
  };
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
  const maxCostUsd = routingComplete?.maxCostUsd
    ?? input.record.constraints?.maxCostUsd
    ?? getMaxCostUsd(input.repoDir);

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
    modelsAvailable: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
    objective: 'balanced',
    maxCostUsd: typeof maxCostUsd === 'number' ? maxCostUsd : undefined,
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

  enrichEvalRecord(record, {
    agentType: input.agentType,
    challengePairId: input.challengePairId,
    challengeRouteContext: input.challengePairId
      ? deriveChallengeRouteContext(input.branchName, input.worktreePath)
      : null,
    difficulty: input.difficultyData,
    taskContext: input.taskContextData,
    repoContext: input.repoContextData,
    workflowCost: input.costOutcome,
    taskDescriptor,
    constraints: typeof input.record.constraints?.maxCostUsd === 'number'
      ? input.record.constraints
      : (() => {
          const slug = input.branchName?.replace(/^(task|bug)\//, '') || input.issueId?.toLowerCase() || '';
          const routingComplete = slug
            ? fetchRoutingCompleteRawWithArchive(input.repoDir, slug, input.issueId || '', input.worktreePath)
            : null;
          const maxCostUsd = routingComplete?.maxCostUsd ?? getMaxCostUsd(input.repoDir);
          return typeof maxCostUsd === 'number' ? { maxCostUsd } : undefined;
        })(),
  });
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
    const evalContext = gatherEvalContext({
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

    const stageArtifacts = gatherStageArtifacts(
      repoDir,
      ctx.issueId || '',
      branchName,
      ctx.worktreePath
    );

    // 3. Detect all interventions
    console.log('Post-completion eval: detecting interventions...');

    const interventionData = detectAndFormatInterventions({
      prNumber: ctx.prNumber,
      branchName,
      baseBranch: 'main',
      repoDir,
      worktreePath: ctx.worktreePath,
      agentType: ctx.agentType,
    });

    console.log(`Post-completion eval: ${formatInterventionDisplay(interventionData.totalCount)}`);

    // 3. Run independent analyses in parallel (non-blocking, failures logged as warnings)
    const { difficultyData, repoContextData, taskContextData } = await runEvalAnalysis({
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

    // 4. Run eval judge
    console.log('Post-completion eval: invoking LLM judge...');
    const record = await evaluateTask({
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
    });

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

    if (ctx.solutionModel) {
      record.modelId = ctx.solutionModel;
      record.modelVersion = ctx.solutionModel;
    }

    // 7. Persist
    const { dir: evalsDir } = resolveEvalsDir(undefined, repoDir);
    appendEvalRecord(record, { dir: evalsDir });
    persisted = true;

    // 8. Update project context
    await updateProjectContext(ctx, evalContext.prDiff, evalContext.taskPrompt);

    // 9. Print summary
    printEvalSummary(record);
    return true;
  } catch (error: unknown) {
    const message = errorMessage(error);
    console.warn(`Post-completion eval: failed (workflow unaffected) — ${message}`);
    return persisted;
  }
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
  issueContext: string
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
    });

    // Append to project-context.md
    appendContextUpdate(contextPath, summary);

    console.log('Project context: updated successfully');

    // Update subsystem specs (cold memory)
    await updateSubsystemSpecs(ctx, prDiff, issueContext, repoDir);

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
  repoDir: string
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
    });

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
}): Promise<string> {
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
  const result = await callClaude(prompt, {
    mode: 'stream',
    cliCmd: claudeCmd,
    model: 'claude-haiku-4-5-20251001',
    taskType: 'classify',
    timeout: 300_000,
    activityTimeout: 60_000,
    retry: true,
    maxRetries: 1,
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
