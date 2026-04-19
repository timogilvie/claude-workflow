/**
 * Patch Size Validator - Enforce patch size caps for weak models
 *
 * When a weaker model is used for coding and no stronger reviewer is available,
 * enforce a patch size cap to reduce risk. The cap is calculated based on the
 * quality gap between the coder model and the threshold.
 *
 * @module patch-size-validator
 */

import { execSync } from 'node:child_process';
import { errorMessage } from './error-utils.ts';

export interface PatchSizeResult {
  /** Total lines changed (additions + deletions) */
  totalLines: number;
  /** Maximum allowed lines */
  cap: number;
  /** Whether the patch exceeds the cap */
  exceedsCap: boolean;
  /** Breakdown by file */
  fileBreakdown: Array<{
    file: string;
    additions: number;
    deletions: number;
    totalLines: number;
  }>;
  /** Reason for the cap */
  reason?: string;
}

/**
 * Validate patch size against a cap.
 *
 * Compares the current branch against the base branch and counts total lines changed.
 * Returns detailed breakdown by file and whether the cap is exceeded.
 *
 * @param branch - Current branch name
 * @param baseBranch - Base branch to compare against (e.g., 'main', 'origin/main')
 * @param cap - Maximum allowed lines
 * @param repoDir - Repository directory
 * @returns Patch size result with file breakdown
 */
export function validatePatchSize(
  branch: string,
  baseBranch: string,
  cap: number,
  repoDir: string,
): PatchSizeResult {
  try {
    // Get diff statistics using git diff --numstat
    // Format: <added> <deleted> <filename>
    const diffOutput = execSync(`git diff ${baseBranch}...${branch} --numstat`, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const fileBreakdown: PatchSizeResult['fileBreakdown'] = [];
    let totalLines = 0;

    const lines = diffOutput.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) {
        continue; // Skip malformed lines
      }

      const [addedStr, deletedStr, file] = parts;

      // Binary files show '-' for added/deleted
      if (addedStr === '-' || deletedStr === '-') {
        // Binary files don't count toward line limit
        continue;
      }

      const additions = parseInt(addedStr, 10);
      const deletions = parseInt(deletedStr, 10);
      const fileTotalLines = additions + deletions;

      fileBreakdown.push({
        file,
        additions,
        deletions,
        totalLines: fileTotalLines,
      });

      totalLines += fileTotalLines;
    }

    // Sort by total lines descending
    fileBreakdown.sort((a, b) => b.totalLines - a.totalLines);

    const exceedsCap = totalLines > cap;

    return {
      totalLines,
      cap,
      exceedsCap,
      fileBreakdown,
    };
  } catch (err) {
    throw new Error(`Failed to validate patch size: ${errorMessage(err)}`);
  }
}

/**
 * Get the base branch for the current branch.
 *
 * Tries to detect the upstream/base branch by:
 * 1. Checking git upstream configuration
 * 2. Falling back to 'main' or 'origin/main'
 *
 * @param repoDir - Repository directory
 * @returns Base branch name (e.g., 'origin/main')
 */
export function getBaseBranch(repoDir: string): string {
  try {
    // Try to get the upstream branch
    const upstream = execSync('git rev-parse --abbrev-ref @{upstream}', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    return upstream;
  } catch {
    // No upstream configured - try 'origin/main' or 'main'
    try {
      execSync('git rev-parse --verify origin/main', {
        cwd: repoDir,
        stdio: 'pipe',
      });
      return 'origin/main';
    } catch {
      // Fall back to just 'main'
      return 'main';
    }
  }
}

/**
 * Get the current branch name.
 *
 * @param repoDir - Repository directory
 * @returns Current branch name
 */
export function getCurrentBranch(repoDir: string): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    return branch;
  } catch (err) {
    throw new Error(`Failed to get current branch: ${errorMessage(err)}`);
  }
}

/**
 * Format patch size result for display.
 *
 * @param result - Patch size result
 * @returns Formatted string for console output
 */
export function formatPatchSizeResult(result: PatchSizeResult): string {
  const lines: string[] = [];

  lines.push(`Patch Size: ${result.totalLines} lines (cap: ${result.cap})`);
  lines.push('');

  if (result.exceedsCap) {
    lines.push('⚠️  EXCEEDS CAP');
    if (result.reason) {
      lines.push(`Reason: ${result.reason}`);
    }
    lines.push('');
  }

  lines.push('Top Files by Change Size:');
  const topFiles = result.fileBreakdown.slice(0, 10);
  for (const file of topFiles) {
    lines.push(
      `  ${file.file}: +${file.additions}/-${file.deletions} (${file.totalLines} total)`,
    );
  }

  if (result.fileBreakdown.length > 10) {
    lines.push(`  ... and ${result.fileBreakdown.length - 10} more files`);
  }

  if (result.exceedsCap) {
    lines.push('');
    lines.push('Suggestion: Split this work into smaller PRs to stay under the cap.');
  }

  return lines.join('\n');
}
