/**
 * Shared eval analysis orchestration.
 *
 * Runs difficulty, repo-context, and task-context analyses with consistent
 * error handling. Used by both eval-orchestrator and post-completion-hook.
 *
 * @module eval-analysis
 */

import { errorMessage } from './error-utils.ts';
import { analyzePrDifficulty } from './difficulty-analyzer.ts';
import { analyzeTaskContext } from './task-context-analyzer.ts';
import { analyzeRepoContext } from './repo-context-analyzer.ts';

export interface EvalAnalysisParams {
  prDiff?: string;
  prNumber?: string;
  repoDir: string;
  issueData?: any;
  /** Prefix for log lines (e.g. "Post-completion eval: "). Default: "\n" */
  logPrefix?: string;
  /** Format functions for display output. When omitted, uses inline formatting. */
  formatters?: {
    difficulty?: (band: string, loc: number, files: number, stratum: string, uncertain: boolean) => string;
    repoContext?: (lang: string, visibility: string, fileCount: number) => string;
    taskContext?: (taskType: string, changeKind: string, complexity: string) => string;
  };
}

export interface EvalAnalysisResult {
  difficultyData: ReturnType<typeof analyzePrDifficulty> | null;
  repoContextData: ReturnType<typeof analyzeRepoContext> | null;
  taskContextData: ReturnType<typeof analyzeTaskContext> | null;
}

/**
 * Run the shared eval analysis pipeline:
 * 1. Difficulty + repo context in parallel
 * 2. Task context sequentially (depends on difficulty results)
 *
 * Each analyzer is wrapped in try/catch — failures log warnings and return null.
 */
export async function runEvalAnalysis(params: EvalAnalysisParams): Promise<EvalAnalysisResult> {
  const { prDiff, prNumber, repoDir, issueData, logPrefix = '\n', formatters } = params;

  const runDifficultyAnalysis = async (): Promise<ReturnType<typeof analyzePrDifficulty>> => {
    if (!(prNumber && prDiff)) {
      return null;
    }

    try {
      console.log(`${logPrefix}Analyzing PR difficulty...`);
      const difficultyData = analyzePrDifficulty({ prDiff, prNumber, repoDir });
      if (difficultyData) {
        const msg = formatters?.difficulty
          ? formatters.difficulty(
              difficultyData.difficultyBand,
              difficultyData.difficultySignals.locTouched,
              difficultyData.difficultySignals.filesTouched,
              difficultyData.stratum,
              difficultyData.difficultySignals.diffUncertain,
            )
          : `Difficulty: ${difficultyData.difficultyBand} ` +
            `(${difficultyData.difficultySignals.locTouched} LOC, ` +
            `${difficultyData.difficultySignals.filesTouched} files, ` +
            `stratum: ${difficultyData.stratum})`;
        console.log(`  ${msg}`);
      }
      return difficultyData;
    } catch (diffErr: unknown) {
      const errorMsg = errorMessage(diffErr);
      console.warn(`  Warning: difficulty analysis failed — ${errorMsg}`);
      return null;
    }
  };

  const runRepoContextAnalysis = async (): Promise<ReturnType<typeof analyzeRepoContext> | null> => {
    try {
      console.log(`${logPrefix}Analyzing repo context...`);
      const repoContextData = analyzeRepoContext(repoDir);
      if (repoContextData) {
        const msg = formatters?.repoContext
          ? formatters.repoContext(
              repoContextData.primaryLanguage,
              repoContextData.repoVisibility,
              repoContextData.repoSize?.fileCount || 0,
            )
          : `Repo context: ${repoContextData.primaryLanguage} / ` +
            `${repoContextData.repoVisibility} / ` +
            `${repoContextData.repoSize?.fileCount || 0} files`;
        console.log(`  ${msg}`);
      }
      return repoContextData;
    } catch (repoErr: unknown) {
      const errorMsg = errorMessage(repoErr);
      console.warn(`  Warning: repo context analysis failed — ${errorMsg}`);
      return null;
    }
  };

  const [difficultyData, repoContextData] = await Promise.all([
    runDifficultyAnalysis(),
    runRepoContextAnalysis(),
  ]);

  let taskContextData: ReturnType<typeof analyzeTaskContext> | null = null;
  if (issueData || prDiff) {
    try {
      console.log(`${logPrefix}Analyzing task context...`);
      taskContextData = analyzeTaskContext({
        issue: issueData,
        prDiff,
        locTouched: difficultyData?.difficultySignals.locTouched,
        filesTouched: difficultyData?.difficultySignals.filesTouched,
      });

      if (taskContextData) {
        const msg = formatters?.taskContext
          ? formatters.taskContext(
              taskContextData.taskType,
              taskContextData.changeKind,
              taskContextData.complexity,
            )
          : `Task context: ${taskContextData.taskType} / ` +
            `${taskContextData.changeKind} / complexity ${taskContextData.complexity}`;
        console.log(`  ${msg}`);
      }
    } catch (taskErr: unknown) {
      const errorMsg = errorMessage(taskErr);
      console.warn(`  Warning: task context analysis failed — ${errorMsg}`);
    }
  }

  return { difficultyData, repoContextData, taskContextData };
}
