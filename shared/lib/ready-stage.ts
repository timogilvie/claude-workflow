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

import { execShellCommand, escapeShellArg } from './shell-utils.ts';
import { extractReleaseReadiness, type ReleaseReadiness } from './task-packet-utils.ts';
import { getReadyConfig } from './config.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Status of an individual ready check.
 *
 * - `pass`: Check succeeded
 * - `fail`: Check failed (blocks merge)
 * - `warn`: Check has concerns but doesn't block
 * - `skip`: Check was skipped (not applicable or disabled)
 * - `pending`: Check is still running and should be retried later
 */
export type ReadyCheckStatus = 'pass' | 'fail' | 'warn' | 'skip' | 'pending';

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

  /** Branch name for the PR */
  branch?: string;

  /**
   * Overall verdict for the PR.
   *
   * - `pass`: All required checks passed, safe to merge
   * - `fail`: One or more required checks failed, blocked
   * - `warn`: All required checks passed but warnings present
   * - `pending`: Blocking checks are still running, retry later
   */
  verdict: 'pass' | 'fail' | 'warn' | 'pending';

  /** Individual check results */
  checks: ReadyCheck[];

  /** ISO 8601 timestamp when checks were run */
  timestamp: string;

  /** Human-readable summary of the overall result */
  summary: string;

  /** GitHub mergeability state, reported separately from readiness verdict */
  mergeConflict?: MergeConflictResult;
}

/**
 * Configuration for the ready stage.
 *
 * This is loaded from `.wavemill-config.json` under the `ready` key.
 */
export interface ReadyStageConfig {
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
 * PR context gathered from GitHub CLI.
 */
interface PRContext {
  prNumber: number;
  diff: string;
  changedFiles: string[];
  branch: string;
  baseBranch: string;
  url: string;
  ciStatus: string;
}

/**
 * Task packet context.
 */
interface TaskPacketContext {
  fullPath: string;
  content: string;
  releaseReadiness: ReleaseReadiness | null;
}

/**
 * Plan file context.
 */
interface PlanContext {
  path: string;
  content: string;
}

/**
 * Merge conflict state for an open PR.
 *
 * This is reported separately from the overall ready verdict because merge
 * conflicts have a distinct remediation path in the monitor.
 */
export interface MergeConflictResult {
  status: 'CLEAN' | 'CONFLICTED' | 'UNKNOWN' | 'ERROR';
  message: string;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  attempts: number;
  error?: string;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export const readyStageDeps = {
  execShellCommand,
  sleep,
};

// ────────────────────────────────────────────────────────────────
// Context Gathering Functions
// ────────────────────────────────────────────────────────────────

/**
 * Gather PR context from GitHub CLI.
 *
 * Fetches PR metadata, diff, and changed files list.
 *
 * @param prNumber - PR number to check
 * @param repoDir - Repository directory
 * @returns PR context including diff and changed files
 * @throws Error if gh CLI fails or PR not found
 */
async function gatherPRContext(prNumber: number, repoDir: string): Promise<PRContext> {
  try {
    // Fetch PR metadata
    const prJson = readyStageDeps.execShellCommand(
      `gh pr view ${escapeShellArg(String(prNumber))} --json number,headRefName,baseRefName,url,files`,
      { encoding: 'utf-8', cwd: repoDir }
    );
    const prData = JSON.parse(prJson.toString());

    // Fetch PR diff
    const diff = readyStageDeps.execShellCommand(
      `gh pr diff ${escapeShellArg(String(prNumber))}`,
      { encoding: 'utf-8', cwd: repoDir }
    ).toString();

    // Extract changed files from JSON
    const changedFiles: string[] = prData.files?.map((f: any) => f.path) || [];

    // Fetch CI status
    let ciStatus = 'unknown';
    try {
      const checksJson = readyStageDeps.execShellCommand(
        `gh pr checks ${escapeShellArg(String(prNumber))} --json state`,
        { encoding: 'utf-8', cwd: repoDir }
      );
      const checks = JSON.parse(checksJson.toString());
      ciStatus = checks.length > 0 ? 'configured' : 'none';
    } catch (error) {
      // CI status check is best-effort
      ciStatus = 'unknown';
    }

    return {
      prNumber,
      diff,
      changedFiles,
      branch: prData.headRefName,
      baseBranch: prData.baseRefName,
      url: prData.url,
      ciStatus,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('could not resolve to a PullRequest')) {
        throw new Error(`PR #${prNumber} not found. Make sure the PR exists and you have access.`);
      }
      if (error.message.includes('gh: command not found')) {
        throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com/');
      }
      throw new Error(`Failed to fetch PR #${prNumber}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Find and load task packet from feature directory.
 *
 * Searches for task packet in features/ directory matching branch name or PR number.
 *
 * @param repoDir - Repository directory
 * @param prNumber - Optional PR number to help locate feature directory
 * @returns Task packet context or null if not found
 */
async function findTaskPacket(repoDir: string, prNumber?: number): Promise<TaskPacketContext | null> {
  try {
    // Look for features/ directory
    const featuresDir = path.join(repoDir, 'features');
    try {
      await fs.access(featuresDir);
    } catch {
      // No features directory
      return null;
    }

    // List all feature directories
    const entries = await fs.readdir(featuresDir, { withFileTypes: true });
    const featureDirs = entries.filter(e => e.isDirectory());

    // Try to find task-packet.md in any feature directory
    for (const dir of featureDirs) {
      const taskPacketPath = path.join(featuresDir, dir.name, 'task-packet.md');
      try {
        const content = await fs.readFile(taskPacketPath, 'utf-8');
        const releaseReadiness = extractReleaseReadiness(content);
        return {
          fullPath: taskPacketPath,
          content,
          releaseReadiness,
        };
      } catch {
        // This directory doesn't have a task packet, continue
        continue;
      }
    }

    // No task packet found
    return null;
  } catch (error) {
    // Graceful degradation - missing task packet is not an error
    return null;
  }
}

/**
 * Find and load plan file from feature directory.
 *
 * @param featureDir - Feature directory path
 * @returns Plan context or null if not found
 */
async function findPlan(featureDir: string): Promise<PlanContext | null> {
  try {
    const planPath = path.join(featureDir, 'plan.md');
    const content = await fs.readFile(planPath, 'utf-8');
    return {
      path: planPath,
      content,
    };
  } catch {
    // Missing plan is not an error
    return null;
  }
}

/**
 * Load deployment configuration.
 *
 * Currently returns empty object - extensibility for HOK-1177.
 *
 * @param repoDir - Repository directory
 * @returns Deployment config
 */
function loadDeployConfig(repoDir: string): Record<string, unknown> {
  // TODO: HOK-1177 will add deploy configuration loading
  return {};
}

// ────────────────────────────────────────────────────────────────
// Check Functions
// ────────────────────────────────────────────────────────────────

/**
 * Check for schema changes without corresponding migrations.
 *
 * Detects schema file changes and verifies matching migration files exist.
 * This is a hard-fail condition - schema changes require migrations.
 *
 * @param changedFiles - List of changed file paths
 * @param repoDir - Repository directory (unused for now)
 * @returns Check result
 * @internal Exported for testing purposes
 */
export function checkSchemaMigrations(changedFiles: string[], repoDir: string): ReadyCheck {
  // Define schema file patterns
  const schemaPatterns = [
    /\.prisma$/,
    /schema\.sql$/,
    /models\.py$/,  // Django models
  ];

  // Define migration file patterns
  const migrationPatterns = [
    /migrations\//,
    /alembic\/versions\//,
  ];

  // Check if any schema files changed
  const schemaFilesChanged = changedFiles.filter(file =>
    schemaPatterns.some(pattern => pattern.test(file))
  );

  if (schemaFilesChanged.length === 0) {
    return {
      name: 'schema-migrations',
      status: 'skip',
      message: 'No schema changes detected',
      details: {},
    };
  }

  // Check if any migration files changed
  const migrationFilesChanged = changedFiles.filter(file =>
    migrationPatterns.some(pattern => pattern.test(file))
  );

  if (migrationFilesChanged.length === 0) {
    return {
      name: 'schema-migrations',
      status: 'fail',
      message: 'Schema files changed without migration files',
      details: {
        schemaFiles: schemaFilesChanged,
        migrationFiles: [],
      },
    };
  }

  // Both schema and migration files changed - pass
  return {
    name: 'schema-migrations',
    status: 'pass',
    message: 'Schema changes have corresponding migrations',
    details: {
      schemaFiles: schemaFilesChanged,
      migrationFiles: migrationFilesChanged,
    },
  };
}

/**
 * Check if changed files map to known deploy targets.
 *
 * v1 implementation: always skip (not configured).
 * Future versions will validate against deploy config.
 *
 * @param changedFiles - List of changed file paths
 * @param deployConfig - Deployment configuration
 * @returns Check result
 * @internal Exported for testing purposes
 */
export function checkDeployPaths(changedFiles: string[], deployConfig: Record<string, unknown>): ReadyCheck {
  return {
    name: 'deploy-paths',
    status: 'skip',
    message: 'Deploy path validation not configured',
    details: {},
  };
}

/**
 * Check if release requirements from task packet are met.
 *
 * Verifies that the PR implementation matches the expectations
 * declared in the task packet's release readiness metadata.
 *
 * @param taskPacket - Task packet context (may be null)
 * @param prContext - PR context with changed files
 * @returns Check result
 */
function checkReleaseRequirements(
  taskPacket: TaskPacketContext | null,
  prContext: PRContext
): ReadyCheck {
  if (!taskPacket) {
    return {
      name: 'release-requirements',
      status: 'warn',
      message: 'No task packet found - skipping release requirements check',
      details: {},
    };
  }

  if (!taskPacket.releaseReadiness) {
    return {
      name: 'release-requirements',
      status: 'pass',
      message: 'No release expectations defined in task packet',
      details: {},
    };
  }

  const { releaseReadiness } = taskPacket;
  const { changedFiles } = prContext;

  // Define schema and migration file patterns (same as checkSchemaMigrations)
  const schemaPatterns = [
    /\.prisma$/,
    /schema\.sql$/,
    /models\.py$/,
  ];
  const migrationPatterns = [
    /migrations\//,
    /alembic\/versions\//,
  ];

  const schemaFilesChanged = changedFiles.filter(file =>
    schemaPatterns.some(pattern => pattern.test(file))
  );
  const migrationFilesChanged = changedFiles.filter(file =>
    migrationPatterns.some(pattern => pattern.test(file))
  );

  // Check database change risk
  if (releaseReadiness.databaseChangeRisk === 'required') {
    // Migration files MUST be present
    if (migrationFilesChanged.length === 0) {
      return {
        name: 'release-requirements',
        status: 'fail',
        message: 'Task packet declares database changes required, but no migration files found',
        details: {
          databaseChangeRisk: 'required',
          migrationFilesFound: [],
          schemaFilesFound: schemaFilesChanged,
        },
      };
    }
  } else if (releaseReadiness.databaseChangeRisk === 'possible') {
    // If schema files changed, warn if no migration
    if (schemaFilesChanged.length > 0 && migrationFilesChanged.length === 0) {
      return {
        name: 'release-requirements',
        status: 'warn',
        message: 'Schema files changed but no migration files (task packet marked as "possible")',
        details: {
          databaseChangeRisk: 'possible',
          schemaFilesFound: schemaFilesChanged,
        },
      };
    }
  } else if (releaseReadiness.databaseChangeRisk === 'none') {
    // Warn if schema files found unexpectedly
    if (schemaFilesChanged.length > 0) {
      return {
        name: 'release-requirements',
        status: 'warn',
        message: 'Schema files changed but task packet declares no database changes expected',
        details: {
          databaseChangeRisk: 'none',
          schemaFilesFound: schemaFilesChanged,
        },
      };
    }
  }

  // Build details object
  const details: Record<string, unknown> = {
    databaseChangeRisk: releaseReadiness.databaseChangeRisk,
  };

  if (releaseReadiness.envChanges.length > 0) {
    details.envChanges = releaseReadiness.envChanges;
  }
  if (releaseReadiness.configChanges.length > 0) {
    details.configChanges = releaseReadiness.configChanges;
  }
  if (releaseReadiness.manualSteps.length > 0) {
    details.manualSteps = releaseReadiness.manualSteps;
  }

  return {
    name: 'release-requirements',
    status: 'pass',
    message: 'Release requirements met',
    details,
  };
}

/**
 * Check CI status for the PR.
 *
 * Verifies that all CI checks are passing.
 * This is a hard-fail condition - failing CI blocks merge.
 *
 * @param prNumber - PR number to check
 * @param repoDir - Repository directory
 * @returns Check result
 */
export function checkCIStatus(prNumber: number, repoDir: string): ReadyCheck {
  try {
    const checksJson = readyStageDeps.execShellCommand(
      `gh pr checks ${escapeShellArg(String(prNumber))} --json state,name`,
      { encoding: 'utf-8', cwd: repoDir }
    );
    const checks = JSON.parse(checksJson.toString());

    if (checks.length === 0) {
      return {
        name: 'ci-status',
        status: 'skip',
        message: 'No CI checks configured',
        details: {},
      };
    }

    const passedStates = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
    const pendingStates = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'REQUESTED', 'WAITING', 'STARTUP_FAILURE']);
    const failedChecks = checks.filter((check: any) => !passedStates.has(check.state));
    const blockingFailures = failedChecks.filter((check: any) => !pendingStates.has(check.state));
    const pendingChecks = failedChecks.filter((check: any) => pendingStates.has(check.state));

    if (blockingFailures.length > 0) {
      return {
        name: 'ci-status',
        status: 'fail',
        message: `${blockingFailures.length} CI check(s) failing`,
        details: {
          failedChecks: blockingFailures.map((c: any) => ({ name: c.name, state: c.state })),
          pendingChecks: pendingChecks.map((c: any) => ({ name: c.name, state: c.state })),
          totalChecks: checks.length,
        },
      };
    }

    if (pendingChecks.length > 0) {
      return {
        name: 'ci-status',
        status: 'pending',
        message: `${pendingChecks.length} CI check(s) still running`,
        details: {
          pendingChecks: pendingChecks.map((c: any) => ({ name: c.name, state: c.state })),
          totalChecks: checks.length,
        },
      };
    }

    return {
      name: 'ci-status',
      status: 'pass',
      message: 'All CI checks passing',
      details: {
        totalChecks: checks.length,
      },
    };
  } catch (error) {
    // If gh pr checks fails, return warn instead of fail
    return {
      name: 'ci-status',
      status: 'warn',
      message: 'Unable to fetch CI status',
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Check GitHub mergeability state for an open PR.
 *
 * GitHub computes mergeability lazily and may initially report `UNKNOWN`.
 * Retry a few times before giving up so the monitor can distinguish transient
 * API latency from an actual conflicted PR.
 */
export async function checkMergeConflicts(
  prNumber: number,
  repoDir: string
): Promise<MergeConflictResult> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const mergeabilityJson = readyStageDeps.execShellCommand(
        `gh pr view ${escapeShellArg(String(prNumber))} --json mergeable,mergeStateStatus`,
        { encoding: 'utf-8', cwd: repoDir }
      );
      const mergeability = JSON.parse(mergeabilityJson.toString()) as {
        mergeable?: string | null;
        mergeStateStatus?: string | null;
      };

      const mergeable = mergeability.mergeable ?? null;
      const mergeStateStatus = mergeability.mergeStateStatus ?? null;

      if (mergeable === 'MERGEABLE' || mergeStateStatus === 'CLEAN' || mergeStateStatus === 'HAS_HOOKS') {
        return {
          status: 'CLEAN',
          message: 'No merge conflicts detected',
          mergeable,
          mergeStateStatus,
          attempts: attempt,
        };
      }

      if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') {
        return {
          status: 'CONFLICTED',
          message: 'PR has merge conflicts with base branch',
          mergeable,
          mergeStateStatus,
          attempts: attempt,
        };
      }

      if (mergeable === 'UNKNOWN' || mergeStateStatus === 'UNKNOWN' || (!mergeable && !mergeStateStatus)) {
        if (attempt < maxAttempts) {
          await readyStageDeps.sleep(5000);
          continue;
        }

        return {
          status: 'UNKNOWN',
          message: 'GitHub is still computing mergeability',
          mergeable,
          mergeStateStatus,
          attempts: attempt,
        };
      }

      return {
        status: 'ERROR',
        message: `Unexpected mergeability state: ${mergeable ?? 'null'} / ${mergeStateStatus ?? 'null'}`,
        mergeable,
        mergeStateStatus,
        attempts: attempt,
      };
    } catch (error) {
      return {
        status: 'ERROR',
        message: 'Unable to fetch mergeability from GitHub',
        attempts: attempt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    status: 'UNKNOWN',
    message: 'GitHub is still computing mergeability',
    attempts: maxAttempts,
  };
}

// ────────────────────────────────────────────────────────────────
// Verdict Computation
// ────────────────────────────────────────────────────────────────

/**
 * Compute overall verdict from check results.
 *
 * Conservative approach:
 * - Any 'fail' → verdict is 'fail'
 * - No fails but any 'pending' → verdict is 'pending'
 * - No fails but any 'warn' → verdict is 'warn'
 * - Otherwise → verdict is 'pass'
 *
 * @param checks - Array of check results
 * @returns Overall verdict
 * @internal Exported for testing purposes
 */
export function computeVerdict(checks: ReadyCheck[]): 'pass' | 'fail' | 'warn' | 'pending' {
  // Empty checks array means nothing failed
  if (checks.length === 0) {
    return 'pass';
  }

  // Any failure blocks merge
  const hasFail = checks.some(check => check.status === 'fail');
  if (hasFail) {
    return 'fail';
  }

  const hasPending = checks.some(check => check.status === 'pending');
  if (hasPending) {
    return 'pending';
  }

  // No failures, but warnings present
  const hasWarn = checks.some(check => check.status === 'warn');
  if (hasWarn) {
    return 'warn';
  }

  // All checks passed or skipped
  return 'pass';
}

// ────────────────────────────────────────────────────────────────
// Main Orchestrator
// ────────────────────────────────────────────────────────────────

/**
 * Run the ready stage for a PR.
 *
 * Gathers context, runs all configured checks, and produces a merge-readiness verdict.
 *
 * @param options - Options for running the ready stage
 * @param options.prNumber - PR number to check
 * @param options.repoDir - Repository directory
 * @returns Result of all ready checks
 * @throws Error if gh CLI not available or PR not found
 */
export async function runReadyStage(options: {
  prNumber: number;
  repoDir: string;
}): Promise<ReadyResult> {
  const { prNumber, repoDir } = options;

  // Load ready config
  const config = getReadyConfig(repoDir);

  // 1. Gather context
  const prContext = await gatherPRContext(prNumber, repoDir);
  const taskPacket = await findTaskPacket(repoDir, prNumber);
  const deployConfig = loadDeployConfig(repoDir);
  const mergeConflict = await checkMergeConflicts(prNumber, repoDir);

  // 2. Run all checks
  const allChecks: ReadyCheck[] = [
    checkSchemaMigrations(prContext.changedFiles, repoDir),
    checkDeployPaths(prContext.changedFiles, deployConfig),
    checkReleaseRequirements(taskPacket, prContext),
    checkCIStatus(prNumber, repoDir),
  ];

  // 3. Filter checks based on config
  let checks = allChecks;
  if (config.checks && config.checks.length > 0) {
    // Only include checks specified in config
    checks = allChecks.filter(check => config.checks!.includes(check.name));
  }

  // 4. Compute verdict
  const verdict = computeVerdict(checks);

  // 5. Generate summary
  let summary: string;
  if (verdict === 'pass') {
    summary = 'All checks passed - safe to merge';
  } else if (verdict === 'pending') {
    summary = 'CI checks still in progress - will retry';
  } else if (verdict === 'warn') {
    summary = 'Checks passed with warnings - review before merge';
  } else {
    summary = 'One or more checks failed - not safe to merge';
  }

  // 6. Return result
  return {
    prNumber,
    branch: prContext.branch,
    verdict,
    checks,
    timestamp: new Date().toISOString(),
    summary,
    mergeConflict,
  };
}

// ────────────────────────────────────────────────────────────────
// Legacy Marker Compatibility
// ────────────────────────────────────────────────────────────────

/**
 * Known legacy workflow marker files and their phase semantics.
 */
const LEGACY_MARKERS = [
  { file: '.plan-approved', name: 'legacy-plan-approved', phase: 'planning' as const },
  { file: '.coding-complete', name: 'legacy-coding-complete', phase: 'coding' as const },
  { file: '.workflow-aborted', name: 'legacy-workflow-aborted', phase: 'aborted' as const },
] as const;

/**
 * Result of checking legacy marker files in a feature directory.
 */
export interface LegacyMarkerResult {
  /** Which markers were found */
  markers: { file: string; present: boolean }[];
  /** ReadyCheck entries for each detected marker */
  checks: ReadyCheck[];
}

/**
 * Check for legacy workflow marker files in a feature directory.
 *
 * Detects `.plan-approved`, `.coding-complete`, and `.workflow-aborted` files
 * and maps them to structured `ReadyCheck` entries that the controller readiness
 * engine can incorporate alongside new-style checks.
 *
 * @deprecated Phase resolution now reads stage result files exclusively.
 * Keep this helper only for explicit migration and compatibility callers.
 *
 * @param featureDir - Absolute path to the feature directory
 * @returns Marker presence and corresponding ReadyCheck entries
 */
export async function checkLegacyMarkers(featureDir: string): Promise<LegacyMarkerResult> {
  const markers: { file: string; present: boolean }[] = [];
  const checks: ReadyCheck[] = [];

  for (const marker of LEGACY_MARKERS) {
    const markerPath = path.join(featureDir, marker.file);
    let present = false;
    try {
      await fs.access(markerPath);
      present = true;
    } catch {
      // Marker not present — not an error
    }

    markers.push({ file: marker.file, present });

    if (present) {
      checks.push({
        name: marker.name,
        status: marker.name === 'legacy-workflow-aborted' ? 'fail' : 'pass',
        message: `Legacy marker ${marker.file} detected`,
        details: { phase: marker.phase },
      });
    }
  }

  return { markers, checks };
}

// ────────────────────────────────────────────────────────────────
// Stage Result Files (HOK-1177, extended by HOK-1192)
//
// Types and I/O helpers live in stage-result.ts. This module
// re-exports them for backward compatibility.
// ────────────────────────────────────────────────────────────────

export type { StageStatus, StageName, StageResult, StageResultMap } from './stage-result.ts';
export type {
  StageArtifacts,
  PlanningArtifacts,
  CodingArtifacts,
  ReviewArtifacts,
  ReadyArtifacts,
} from './stage-result.ts';

export {
  readStageResult,
  readAllStageResults,
  writeStageResult,
  updateStageResult,
  getResultFilePath,
  isValidStage,
  isValidStatus,
} from './stage-result.ts';

// Re-export readAllStageResults under the legacy name for existing callers.
// Also bind locally as readStageResults so controllerCheckReadiness can call it.
import { readAllStageResults } from './stage-result.ts';
const readStageResults = readAllStageResults;
export { readStageResults };

// ────────────────────────────────────────────────────────────────
// Controller-Owned Readiness Check
// ────────────────────────────────────────────────────────────────

/**
 * Result of a controller-owned readiness check on a feature directory.
 *
 * Unlike `ReadyResult` which is PR-oriented, this evaluates a feature
 * directory's phase state without requiring GitHub CLI or a PR number.
 */
export interface ControllerReadinessResult {
  /** Absolute path to the feature directory that was checked */
  featureDir: string;

  /** Whether the feature directory is ready to proceed to the next phase */
  ready: boolean;

  /** Detected workflow phase based on markers and artifacts */
  phase: 'planning' | 'coding' | 'review' | 'ready' | 'aborted' | 'unknown';

  /** Individual check results */
  checks: ReadyCheck[];

  /** ISO 8601 timestamp when checks were run */
  timestamp: string;

  /** Human-readable summary */
  summary: string;
}

/**
 * Run a controller-owned readiness check on a feature directory.
 *
 * This is the "pre-PR" readiness function that evaluates a feature directory's
 * phase state without requiring a PR number or GitHub CLI access. The controller
 * (shell orchestrator) uses this to determine phase transitions.
 *
 * Checks performed:
 * - Stage result files (`.planning-result.json`, etc.) — authoritative source
 * - Task packet presence
 * - Plan file presence
 *
 * @param featureDir - Absolute path to the feature directory
 * @returns Controller readiness result with phase detection and check details
 */
export async function controllerCheckReadiness(
  featureDir: string,
): Promise<ControllerReadinessResult> {
  const checks: ReadyCheck[] = [];

  // 1. Verify feature directory exists
  try {
    await fs.access(featureDir);
  } catch {
    return {
      featureDir,
      ready: false,
      phase: 'unknown',
      checks: [{
        name: 'feature-dir',
        status: 'fail',
        message: `Feature directory does not exist: ${featureDir}`,
      }],
      timestamp: new Date().toISOString(),
      summary: 'Feature directory not found',
    };
  }

  // 2. Read structured stage result files (HOK-1177)
  const stageResults = await readStageResults(featureDir);
  const hasStageResults = Object.keys(stageResults).length > 0;

  for (const [stage, result] of Object.entries(stageResults)) {
    checks.push({
      name: `stage-${stage}`,
      status: result.status === 'aborted' || result.status === 'failed' ? 'fail'
            : result.status === 'completed' ? 'pass'
            : 'warn',
      message: result.status === 'awaiting_user'
        ? `Stage ${stage}: awaiting_user — plan ready for approval`
        : `Stage ${stage}: ${result.status}`,
      details: { stage, status: result.status, agent: result.agent, model: result.model },
    });
  }

  // 3. Check for task packet
  const taskPacketPath = path.join(featureDir, 'task-packet.md');
  try {
    await fs.access(taskPacketPath);
    checks.push({
      name: 'task-packet',
      status: 'pass',
      message: 'Task packet found',
    });
  } catch {
    checks.push({
      name: 'task-packet',
      status: 'warn',
      message: 'No task packet found in feature directory',
    });
  }

  // 4. Check for plan
  const planPath = path.join(featureDir, 'plan.md');
  try {
    await fs.access(planPath);
    checks.push({
      name: 'plan',
      status: 'pass',
      message: 'Implementation plan found',
    });
  } catch {
    checks.push({
      name: 'plan',
      status: 'warn',
      message: 'No implementation plan found in feature directory',
    });
  }

  // 5. Determine phase from stage results only
  let phase: ControllerReadinessResult['phase'] = 'unknown';

  if (hasStageResults) {
    // Check for abort in any stage
    const abortedStage = Object.values(stageResults).find(r => r.status === 'aborted');
    if (abortedStage) {
      phase = 'aborted';
    } else if (stageResults.ready?.status === 'completed') {
      const verdict = stageResults.ready.artifacts?.type === 'ready'
        ? stageResults.ready.artifacts.verdict
        : undefined;
      phase = 'ready';
      checks.push({
        name: 'ready-outcome',
        status: verdict === 'fail' ? 'fail' : verdict === 'warn' || verdict === 'pending' ? 'warn' : 'pass',
        message: verdict === 'fail'
          ? 'Ready stage failed - merge is blocked'
          : verdict === 'warn'
            ? 'Ready stage passed with warnings - merge may require manual follow-up'
            : verdict === 'pending'
              ? 'Ready stage is still waiting on CI checks'
            : 'Ready stage passed - merge is allowed',
        details: { verdict },
      });
    } else if (stageResults.ready?.status === 'running') {
      phase = 'ready';
      checks.push({
        name: 'ready-outcome',
        status: 'warn',
        message: 'Ready remediation in progress',
      });
    } else if (stageResults.ready?.status === 'failed') {
      phase = 'ready';
      checks.push({
        name: 'ready-outcome',
        status: 'fail',
        message: 'Ready stage needs attention',
      });
    } else if (stageResults.ready) {
      phase = 'ready';
    } else if (stageResults.review?.status === 'completed') {
      phase = 'ready';
    } else if (stageResults.review?.status === 'running') {
      phase = 'review';
    } else if (stageResults.coding?.status === 'completed') {
      phase = 'review';
    } else if (stageResults.coding?.status === 'running') {
      phase = 'coding';
    } else if (stageResults.planning?.status === 'completed') {
      phase = 'coding';
    } else if (stageResults.planning?.status === 'awaiting_user') {
      phase = 'planning';
    } else if (stageResults.planning?.status === 'running') {
      phase = 'planning';
    }
  }

  // 6. Determine readiness — ready if no failures
  const hasFail = checks.some(c => c.status === 'fail');
  const ready = !hasFail;

  // 7. Build summary
  let summary: string;
  if (phase === 'aborted') {
    summary = 'Workflow was aborted';
  } else if (phase === 'unknown') {
    summary = 'No stage results detected - feature directory may be in initial state';
  } else if (stageResults.ready?.status === 'running') {
    summary = 'Feature is in ready phase (remediation in progress)';
  } else if (stageResults.ready?.status === 'failed') {
    summary = 'Feature is in ready phase (needs attention)';
  } else {
    const statusSuffix = ready ? '' : ' (blocked by failing checks)';
    summary = `Feature is in ${phase} phase${statusSuffix} (from stage results)`;
  }

  return {
    featureDir,
    ready,
    phase,
    checks,
    timestamp: new Date().toISOString(),
    summary,
  };
}
