/**
 * Post-completion hook for wavemill workflows.
 *
 * Automatically triggers eval after a workflow finishes (PR created).
 * Non-blocking: eval failures log a warning but never fail the workflow.
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { evaluateTask } from './eval.js';
import { appendEvalRecord } from './eval-persistence.ts';
import {
  detectAllInterventions,
  toInterventionMeta,
  toInterventionRecords,
  formatForJudge,
  loadPenalties,
} from './intervention-detector.ts';
import { computeWorkflowCost, loadPricingTable } from './workflow-cost.ts';
import { analyzePrDifficulty } from './difficulty-analyzer.ts';
import { analyzeTaskContext } from './task-context-analyzer.ts';
import { analyzeRepoContext } from './repo-context-analyzer.ts';

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
}

/**
 * Resolve the evalsDir from config, falling back to the default.
 */
function resolveEvalsDir(repoDir: string): string | undefined {
  const configPath = join(repoDir, '.wavemill-config.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.eval?.evalsDir) return resolve(repoDir, config.eval.evalsDir);
  } catch { /* fall through */ }
  return undefined;
}

/**
 * Fetch issue description from Linear via the get-issue-json tool.
 */
function fetchIssuePrompt(issueId: string, repoDir: string): string {
  const toolPath = resolve(__dirname, '../../tools/get-issue-json.ts');
  try {
    const raw = execSync(
      `npx tsx "${toolPath}" "${issueId}" 2>/dev/null | sed '/^\\[dotenv/d'`,
      { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
    ).trim();
    const issue = JSON.parse(raw);
    return `# ${issue.identifier}: ${issue.title}\n\n${issue.description || ''}`;
  } catch {
    return `Issue: ${issueId} (details unavailable)`;
  }
}

/**
 * Fetch PR diff and URL from GitHub.
 */
function fetchPrContext(prNumber: string, repoDir: string): { diff: string; url: string } {
  let url = '';
  let diff = '';

  try {
    url = execSync(`gh pr view ${prNumber} --json url --jq .url 2>/dev/null`, {
      encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash',
    }).trim();
  } catch { /* best-effort */ }

  try {
    diff = execSync(`gh pr diff ${prNumber}`, {
      encoding: 'utf-8', cwd: repoDir, maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    diff = '(PR diff unavailable)';
  }

  return { diff, url };
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
 */
export async function runPostCompletionEval(ctx: PostCompletionContext): Promise<void> {
  const repoDir = ctx.repoDir || process.cwd();

  if (!ctx.issueId && !ctx.prNumber) {
    console.warn('Post-completion eval: skipped (no issue ID or PR number provided)');
    return;
  }

  try {
    console.log('Post-completion eval: gathering context...');

    // 2. Gather context
    const taskPrompt = ctx.issueId
      ? fetchIssuePrompt(ctx.issueId, repoDir)
      : '(No issue context available)';

    let prReviewOutput = '';
    let prUrl = ctx.prUrl || '';
    if (ctx.prNumber) {
      const prCtx = fetchPrContext(ctx.prNumber, repoDir);
      prReviewOutput = prCtx.diff;
      if (!prUrl) prUrl = prCtx.url;
    }

    // 3. Detect intervention events
    console.log('Post-completion eval: detecting interventions...');
    let branchName = ctx.branchName || '';
    if (!branchName) {
      try {
        branchName = execSync('git branch --show-current', {
          encoding: 'utf-8', cwd: repoDir,
        }).trim();
      } catch { /* best-effort */ }
    }

    const interventionSummary = detectAllInterventions({
      prNumber: ctx.prNumber,
      branchName,
      baseBranch: 'main',
      repoDir,
      worktreePath: ctx.worktreePath,
      agentType: ctx.agentType,
    });
    const interventionMeta = toInterventionMeta(interventionSummary);
    const interventionRecords = toInterventionRecords(interventionSummary);
    const penalties = loadPenalties(repoDir);
    const interventionText = formatForJudge(interventionSummary, penalties);

    const totalInterventions = interventionSummary.interventions.reduce((sum, e) => sum + e.count, 0);
    console.log(`Post-completion eval: ${totalInterventions} intervention(s) detected`);

    // 4. Compute difficulty metrics from PR diff (HOK-777)
    let difficultyData: ReturnType<typeof analyzePrDifficulty> = null;
    if (ctx.prNumber && prReviewOutput) {
      try {
        console.log('Post-completion eval: analyzing PR difficulty...');
        difficultyData = analyzePrDifficulty({
          prDiff: prReviewOutput,
          prNumber: ctx.prNumber,
          repoDir,
        });
        if (difficultyData) {
          console.log(
            `Post-completion eval: difficulty ${difficultyData.difficultyBand} ` +
            `(${difficultyData.difficultySignals.locTouched} LOC, ` +
            `${difficultyData.difficultySignals.filesTouched} files, ` +
            `stratum: ${difficultyData.stratum})`
          );
        }
      } catch (diffErr: unknown) {
        const diffMsg = diffErr instanceof Error ? diffErr.message : String(diffErr);
        console.warn(`Post-completion eval: difficulty analysis failed — ${diffMsg}`);
        // Non-blocking: continue without difficulty data
      }
    }

    // 4a. Analyze task context (HOK-774)
    let taskContextData: ReturnType<typeof analyzeTaskContext> | null = null;
    if (ctx.issueId || prReviewOutput) {
      try {
        console.log('Post-completion eval: analyzing task context...');
        // Fetch issue data for task context
        let issueData;
        if (ctx.issueId) {
          try {
            const toolPath = resolve(__dirname, '../../tools/get-issue-json.ts');
            const raw = execSync(
              `npx tsx "${toolPath}" "${ctx.issueId}" 2>/dev/null | sed '/^\\[dotenv/d'`,
              { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
            ).trim();
            issueData = JSON.parse(raw);
          } catch {
            // Issue fetch failed - continue with partial data
          }
        }

        taskContextData = analyzeTaskContext({
          issue: issueData,
          prDiff: prReviewOutput,
          locTouched: difficultyData?.difficultySignals.locTouched,
          filesTouched: difficultyData?.difficultySignals.filesTouched,
        });

        if (taskContextData) {
          console.log(
            `Post-completion eval: task context ${taskContextData.taskType} / ` +
            `${taskContextData.changeKind} / complexity ${taskContextData.complexity}`
          );
        }
      } catch (taskErr: unknown) {
        const taskMsg = taskErr instanceof Error ? taskErr.message : String(taskErr);
        console.warn(`Post-completion eval: task context analysis failed — ${taskMsg}`);
        // Non-blocking: continue without task context
      }
    }

    // 4b. Analyze repo context (HOK-774)
    let repoContextData: ReturnType<typeof analyzeRepoContext> | null = null;
    try {
      console.log('Post-completion eval: analyzing repo context...');
      repoContextData = analyzeRepoContext(repoDir);
      if (repoContextData) {
        console.log(
          `Post-completion eval: repo context ${repoContextData.primaryLanguage} / ` +
          `${repoContextData.repoVisibility} / ` +
          `${repoContextData.repoSize?.fileCount || 0} files`
        );
      }
    } catch (repoErr: unknown) {
      const repoMsg = repoErr instanceof Error ? repoErr.message : String(repoErr);
      console.warn(`Post-completion eval: repo context analysis failed — ${repoMsg}`);
      // Non-blocking: continue without repo context
    }

    // 5. Run eval
    console.log('Post-completion eval: invoking LLM judge...');
    const record = await evaluateTask({
      taskPrompt,
      prReviewOutput,
      interventions: interventionMeta,
      interventionRecords,
      interventionText,
      issueId: ctx.issueId || undefined,
      prUrl: prUrl || undefined,
      metadata: { workflowType: ctx.workflowType, hookTriggered: true, interventionSummary },
    });

    // Set agentType unconditionally so eval records always reflect which agent ran
    record.agentType = ctx.agentType || 'claude';

    // 6. Attach difficulty data to record (HOK-777)
    if (difficultyData) {
      record.difficultyBand = difficultyData.difficultyBand;
      record.difficultySignals = difficultyData.difficultySignals;
      record.stratum = difficultyData.stratum;
    }

    // 6a. Attach task context to record (HOK-774)
    if (taskContextData) {
      record.taskContext = taskContextData;
    }

    // 6b. Attach repo context to record (HOK-774)
    if (repoContextData) {
      record.repoContext = repoContextData;
    }

    // 7. Compute workflow cost from agent session data
    //    Pricing lives in the wavemill repo config, not the target repo,
    //    so resolve it from this script's location.
    if (ctx.worktreePath && branchName) {
      console.log('Post-completion eval: computing workflow cost...');
      try {
        const wavemillConfigDir = resolve(__dirname, '../..');
        const pricingTable = loadPricingTable(wavemillConfigDir);
        const costResult = computeWorkflowCost({
          worktreePath: ctx.worktreePath,
          branchName,
          repoDir,
          pricingTable,
          agentType: ctx.agentType,
        });
        if (costResult) {
          record.workflowCost = costResult.totalCostUsd;
          record.workflowTokenUsage = costResult.models;
          console.log(
            `Post-completion eval: workflow cost $${costResult.totalCostUsd.toFixed(4)} ` +
            `(${costResult.turnCount} turns across ${costResult.sessionCount} session(s))`
          );
        } else {
          console.log('Post-completion eval: no session data found for workflow cost');
        }
      } catch (costErr: unknown) {
        const costMsg = costErr instanceof Error ? costErr.message : String(costErr);
        console.warn(`Post-completion eval: workflow cost computation failed — ${costMsg}`);
      }
    }

    // 8. Persist via eval-persistence
    const evalsDir = resolveEvalsDir(repoDir);
    appendEvalRecord(record, evalsDir ? { dir: evalsDir } : undefined);

    // 9. Print summary
    const scoreDisplay = (record.score as number).toFixed(2);
    const costSuffix = record.workflowCost !== undefined
      ? `, workflow cost: $${record.workflowCost.toFixed(4)}`
      : '';
    console.log(`Post-completion eval: ${record.scoreBand} (${scoreDisplay}${costSuffix}) — saved to eval store`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Post-completion eval: failed (workflow unaffected) — ${message}`);
  }
}
