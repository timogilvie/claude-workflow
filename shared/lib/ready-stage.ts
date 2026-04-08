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

  /** Branch name for the PR */
  branch?: string;

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
    const prJson = execShellCommand(
      `gh pr view ${escapeShellArg(String(prNumber))} --json number,headRefName,baseRefName,url,files`,
      { encoding: 'utf-8', cwd: repoDir }
    );
    const prData = JSON.parse(prJson.toString());

    // Fetch PR diff
    const diff = execShellCommand(
      `gh pr diff ${escapeShellArg(String(prNumber))}`,
      { encoding: 'utf-8', cwd: repoDir }
    ).toString();

    // Extract changed files from JSON
    const changedFiles: string[] = prData.files?.map((f: any) => f.path) || [];

    // Fetch CI status
    let ciStatus = 'unknown';
    try {
      const checksJson = execShellCommand(
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
function checkCIStatus(prNumber: number, repoDir: string): ReadyCheck {
  try {
    const checksJson = execShellCommand(
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

    // Check if all checks are SUCCESS
    const failedChecks = checks.filter((check: any) => check.state !== 'SUCCESS');

    if (failedChecks.length > 0) {
      return {
        name: 'ci-status',
        status: 'fail',
        message: `${failedChecks.length} CI check(s) failing`,
        details: {
          failedChecks: failedChecks.map((c: any) => ({ name: c.name, state: c.state })),
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

// ────────────────────────────────────────────────────────────────
// Verdict Computation
// ────────────────────────────────────────────────────────────────

/**
 * Compute overall verdict from check results.
 *
 * Conservative approach:
 * - Any 'fail' → verdict is 'fail'
 * - No fails but any 'warn' → verdict is 'warn'
 * - Otherwise → verdict is 'pass'
 *
 * @param checks - Array of check results
 * @returns Overall verdict
 * @internal Exported for testing purposes
 */
export function computeVerdict(checks: ReadyCheck[]): 'pass' | 'fail' | 'warn' {
  // Empty checks array means nothing failed
  if (checks.length === 0) {
    return 'pass';
  }

  // Any failure blocks merge
  const hasFail = checks.some(check => check.status === 'fail');
  if (hasFail) {
    return 'fail';
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

  // Check if ready stage is enabled
  if (!config.enabled) {
    return {
      prNumber,
      branch: undefined,
      verdict: 'warn',
      checks: [{
        name: 'ready-stage',
        status: 'warn',
        message: 'Ready stage not enabled in config',
        details: {},
      }],
      timestamp: new Date().toISOString(),
      summary: 'Ready stage not enabled - set ready.enabled=true in .wavemill-config.json',
    };
  }

  // 1. Gather context
  const prContext = await gatherPRContext(prNumber, repoDir);
  const taskPacket = await findTaskPacket(repoDir, prNumber);
  const deployConfig = loadDeployConfig(repoDir);

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
  };
}
