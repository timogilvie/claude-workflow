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
import { checkClaudeAvailability } from './llm-cli.ts';
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
    await reporter?.emit({
      event: 'preflight_start',
      message: 'Checking Claude CLI availability',
    });

    const healthCheck = await checkClaudeAvailability({ verbose: options.verbose });
    if (!healthCheck.available) {
      const errorLines = [
        'Claude CLI is not available or not working properly.',
        '',
        `Error: ${healthCheck.error}`,
        '',
        'Diagnostics:',
        `  - Command: ${healthCheck.command}`,
        `  - In PATH: ${healthCheck.diagnostics?.inPath ? 'Yes' : 'No'}`,
        `  - Executable: ${healthCheck.diagnostics?.executable ? 'Yes' : 'No'}`,
        `  - Auth working: ${healthCheck.diagnostics?.authWorking ? 'Yes' : 'No'}`,
      ];

      if (healthCheck.version) {
        errorLines.push(`  - Version: ${healthCheck.version}`);
      }

      errorLines.push(
        '',
        'Troubleshooting:',
        '  1. Install Claude CLI: npm install -g @anthropic-ai/claude-cli',
        '  2. Authenticate: claude login',
        '  3. Test: echo "hello" | claude -p --model claude-haiku-4-5-20251001',
        '  4. Check PATH: which claude',
        '',
        'To skip this check (not recommended): SKIP_PREFLIGHT_CHECK=1'
      );

      await reporter?.emit({
        event: 'error',
        level: 'error',
        message: 'Claude CLI preflight failed',
        details: { command: healthCheck.command },
      });

      throw new Error(errorLines.join('\n'));
    }

    await reporter?.emit({
      event: 'preflight_ok',
      message: 'Claude CLI is available',
      details: {
        command: healthCheck.command,
        version: healthCheck.version,
      },
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
