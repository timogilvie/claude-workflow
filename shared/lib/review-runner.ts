/**
 * Review runner - Wrapper for review engine for local changes.
 *
 * Provides backward-compatible interface for reviewing local changes.
 * Delegates all review logic to shared/lib/review-engine.ts
 *
 * @module review-runner
 */

import { resolve } from 'node:path';
import {
  assertReviewableDiff,
  gatherReviewContext,
  getCurrentBranch,
  getGitDiff,
} from './review-context-gatherer.ts';
import { runReview, type ReviewResult, type ReviewFinding, type ReviewerPersona } from './review-engine.ts';
import { ensureClaudeAvailable } from './llm-cli.ts';
import type { ReviewProgressReporter } from './review-progress.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface ReviewOptions {
  /** Branch to diff against (default: "main") */
  targetBranch?: string;
  /** Repository directory (default: cwd) */
  repoDir?: string;
  /** Skip UI verification even if design context exists */
  skipUi?: boolean;
  /** Run only UI verification (skip code review) */
  uiOnly?: boolean;
  /** Print verbose output */
  verbose?: boolean;
  /** List of reviewer personas to run */
  reviewers?: ReviewerPersona[];
  /** Progress reporter for stderr milestones */
  reporter?: ReviewProgressReporter;
}

// Re-export types from review-engine for backward compatibility
export type { ReviewFinding, ReviewResult, ReviewerPersona } from './review-engine.ts';


// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

/**
 * Run a code review on the current branch.
 *
 * This is a backward-compatible wrapper that gathers local change context
 * and delegates to the shared review engine.
 *
 * @param options - Review configuration options
 * @returns ReviewResult with verdict and findings
 */
export async function reviewChanges(
  options: ReviewOptions = {}
): Promise<ReviewResult> {
  const targetBranch = options.targetBranch || 'main';
  const repoDir = options.repoDir ? resolve(options.repoDir) : process.cwd();
  const reporter = options.reporter;

  await reporter?.emit({
    event: 'preflight_start',
    message: `Checking git diff against ${targetBranch}`,
  });

  const branch = getCurrentBranch(repoDir);
  const diff = getGitDiff(targetBranch, repoDir);
  assertReviewableDiff(diff, branch, targetBranch);

  await reporter?.emit({
    event: 'preflight_ok',
    message: `Found committed changes against ${targetBranch}`,
    details: { branch },
  });

  if (!process.env.SKIP_PREFLIGHT_CHECK) {
    await ensureClaudeAvailable({
      verbose: options.verbose,
      reporter,
    });
  }

  await reporter?.emit({
    event: 'context_loading',
    message: 'Loading review context',
  });

  // Gather review context (skip design standards if explicitly requested)
  const context = gatherReviewContext(targetBranch, repoDir, {
    designStandards: !options.skipUi,
  });

  await reporter?.emit({
    event: 'context_loaded',
    message: `Loaded review context for ${context.metadata.files.length} changed files`,
    details: {
      hasUiChanges: context.metadata.hasUiChanges,
      fileCount: context.metadata.files.length,
    },
  });

  // Delegate to review engine
  return runReview(context, repoDir, {
    skipUi: options.skipUi,
    verbose: options.verbose,
    reviewers: options.reviewers,
    reporter,
    skipClaudePreflight: true,
  });
}
