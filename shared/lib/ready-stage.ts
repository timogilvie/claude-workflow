/**
 * Ready Stage - Merge Readiness Validation
 *
 * PHASE BOUNDARY:
 * - Review phase: Judges code quality and correctness (does the code do what it should?)
 * - Ready phase: Judges merge-readiness (is it safe to merge RIGHT NOW?)
 *
 * The ready stage runs AFTER PR creation and checks:
 * - CI status (all checks passing?)
 * - PR approvals (required reviewers approved?)
 * - Merge conflicts (clean merge possible?)
 * - Branch freshness (up-to-date with base?)
 *
 * This module provides the contract only. Actual check implementations
 * are in separate HOK-1138 sub-issues.
 */

/**
 * Status of an individual ready check.
 *
 * - `pass`: Check succeeded
 * - `fail`: Check failed (blocks merge)
 * - `warn`: Check has concerns but doesn't block
 * - `skip`: Check was skipped (not applicable or disabled)
 */
export type ReadyCheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

/**
 * Result of an individual ready check.
 *
 * Each check validates one aspect of merge-readiness (CI, approvals, conflicts, etc).
 */
export interface ReadyCheck {
  /** Unique name identifying this check (e.g., "ci-status", "approvals") */
  name: string;

  /** Status of the check */
  status: ReadyCheckStatus;

  /** Human-readable message describing the result */
  message: string;

  /** Optional structured data providing additional context */
  details?: Record<string, unknown>;
}

/**
 * Overall result of the ready stage.
 *
 * Aggregates individual check results into a final merge-readiness verdict.
 */
export interface ReadyResult {
  /** PR number that was checked */
  prNumber: number;

  /**
   * Overall verdict for the PR.
   *
   * - `pass`: All required checks passed, safe to merge
   * - `fail`: One or more required checks failed, blocked
   * - `warn`: All required checks passed but warnings present
   */
  verdict: 'pass' | 'fail' | 'warn';

  /** Individual check results */
  checks: ReadyCheck[];

  /** ISO 8601 timestamp when checks were run */
  timestamp: string;

  /** Human-readable summary of the overall result */
  summary: string;
}

/**
 * Configuration for the ready stage.
 *
 * This is loaded from `.wavemill-config.json` under the `ready` key.
 */
export interface ReadyStageConfig {
  /**
   * Enable the ready stage.
   *
   * Must be explicitly set to `true`. Default is `false`.
   */
  enabled?: boolean;

  /**
   * List of check names to run.
   *
   * Empty array means run all available checks.
   * Use to disable specific checks.
   */
  checks?: string[];

  /**
   * Subset of checks that must pass for merge approval.
   *
   * Other checks can warn but won't fail the verdict.
   */
  requiredChecks?: string[];
}

/**
 * Run the ready stage for a PR.
 *
 * This is a stub implementation. HOK-1176 will add the actual check logic.
 *
 * @param options - Options for running the ready stage
 * @param options.prNumber - PR number to check
 * @param options.repoDir - Repository directory
 * @returns Result of all ready checks
 */
export async function runReadyStage(options: {
  prNumber: number;
  repoDir: string;
}): Promise<ReadyResult> {
  // TODO: HOK-1176 will implement actual checks
  // For now, return a passing result with empty checks
  return {
    prNumber: options.prNumber,
    verdict: 'pass',
    checks: [],
    timestamp: new Date().toISOString(),
    summary: 'Ready stage stub - no checks implemented yet',
  };
}
