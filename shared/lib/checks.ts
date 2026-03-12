/**
 * Build check utilities for validating code before creating PRs.
 *
 * @module checks
 */

import { execShellCommand } from './shell-utils.ts';

/**
 * Configuration for build checks.
 */
export interface BuildCheckConfig {
  checks?: {
    /** Build command to execute (e.g., 'npm run build', 'tsc --noEmit') */
    build?: string;
    /** Whether to require build check before PR creation (default: true) */
    requireBuildBeforePR?: boolean;
  };
}

/**
 * Result of a build check operation.
 */
export interface BuildCheckResult {
  /** Whether the build check passed */
  success: boolean;
  /** Whether the check was skipped */
  skipped: boolean;
  /** Reason for skip or failure */
  reason?: string;
}

/**
 * Runs the build check command from config.
 *
 * @param config - Configuration object with checks section
 * @returns Result object with success status and optional error
 * @throws {Error} If build fails and requireBuildBeforePR is true
 *
 * @example
 * ```typescript
 * const config = {
 *   checks: {
 *     build: 'npm run build',
 *     requireBuildBeforePR: true
 *   }
 * };
 * const result = runBuildCheck(config);
 * if (!result.success) {
 *   console.error('Build failed!');
 * }
 * ```
 */
export const runBuildCheck = (config: BuildCheckConfig): BuildCheckResult => {
  // Check if build check is required (defaults to true)
  const requireBuild = config?.checks?.requireBuildBeforePR !== false;

  if (!requireBuild) {
    return { success: true, skipped: true, reason: 'requireBuildBeforePR is disabled' };
  }

  const buildCommand = config?.checks?.build;

  // If no build command configured, warn but don't block (backwards compatibility)
  if (!buildCommand) {
    console.warn('⚠️  No build command configured in checks.build. Skipping build check.');
    return { success: true, skipped: true, reason: 'No build command configured' };
  }

  try {
    console.log(`Running build check: ${buildCommand}`);
    execShellCommand(buildCommand, {
      stdio: 'inherit',
      encoding: 'utf-8'
    });
    console.log('✓ Build check passed');
    return { success: true, skipped: false };
  } catch (error) {
    const err = error as Error & { status?: number };
    const errorMessage = `Build check failed. Cannot create PR until build passes.

Command: ${buildCommand}
Exit code: ${err.status || 'unknown'}

To bypass this check, set "requireBuildBeforePR": false in your config.

Error output:
${err.message}`;

    throw new Error(errorMessage);
  }
};
