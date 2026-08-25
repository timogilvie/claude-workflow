/**
 * Pre-PR verification engine.
 *
 * Executes verification recipe commands, captures bounded logs, and writes
 * atomic artifacts that can be used to validate PR readiness.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync as childExecSync } from 'node:child_process';
import { writeArtifactAtomicSync } from './artifact-utils.ts';
import {
  formatReviewScopeGuardResult,
  validateReviewScope,
} from './review-scope-guard.ts';
import type {
  PrePrVerificationRecipe,
  PrePrVerificationResult,
  CommandResult,
  PrePrVerificationArtifact,
  OperatorOverride,
} from './pre-pr-verification-types.ts';

// ────────────────────────────────────────────────────────────────
// Core Functions
// ────────────────────────────────────────────────────────────────

export interface BaseResolutionResult {
  baseSha: string;
  fetchedAt: number;
  fetchDiagnostics: {
    fetchedRef: string;
    upstreamBranch: string;
  };
}

export interface BaseFetchError {
  kind: 'fetch-failed' | 'resolve-failed' | 'branch-unavailable';
  message: string;
  diagnostics: string;
}

function commandErrorOutput(err: unknown): string {
  const execErr = err as {
    message?: string;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };
  const stdout =
    typeof execErr.stdout === 'string'
      ? execErr.stdout
      : (execErr.stdout?.toString?.() ?? '');
  const stderr =
    typeof execErr.stderr === 'string'
      ? execErr.stderr
      : (execErr.stderr?.toString?.() ?? '');
  return [stderr.trim(), stdout.trim(), execErr.message ?? '']
    .filter(Boolean)
    .join('\n');
}

function classifyFetchError(baseBranch: string, output: string): BaseFetchError {
  const lower = output.toLowerCase();
  if (
    lower.includes("couldn't find remote ref") ||
    lower.includes('could not find remote ref') ||
    lower.includes('remote ref does not exist') ||
    lower.includes('repository not found')
  ) {
    return {
      kind: 'branch-unavailable',
      message: `Base branch '${baseBranch}' is unavailable on origin.`,
      diagnostics:
        `Base branch '${baseBranch}' not found on remote origin. ` +
        'Verify the configured integration branch in .wavemill-config.json, then retry verification.',
    };
  }

  if (
    lower.includes('permission denied') ||
    lower.includes('authentication failed') ||
    lower.includes('could not read from remote repository') ||
    lower.includes('403') ||
    lower.includes('401')
  ) {
    return {
      kind: 'fetch-failed',
      message: `Unable to authenticate while fetching base branch '${baseBranch}'.`,
      diagnostics:
        `Permission denied while fetching base branch '${baseBranch}' from origin. ` +
        'Check git credentials and repository access, then retry verification.',
    };
  }

  if (
    lower.includes('could not resolve host') ||
    lower.includes('failed to connect') ||
    lower.includes('network is unreachable') ||
    lower.includes('operation timed out') ||
    lower.includes('unable to access')
  ) {
    return {
      kind: 'fetch-failed',
      message: `Unable to reach origin while fetching base branch '${baseBranch}'.`,
      diagnostics:
        `Unable to reach origin while fetching base branch '${baseBranch}'. ` +
        'Check network connectivity and retry verification.',
    };
  }

  return {
    kind: 'fetch-failed',
    message: `Failed to fetch base branch '${baseBranch}' from origin.`,
    diagnostics:
      `Failed to fetch base branch '${baseBranch}' from origin. ` +
      `Git reported: ${output || 'no diagnostic output'}`,
  };
}

/**
 * Fetch and resolve the configured base branch against remote state.
 *
 * Freshness depends on remote state being known. Callers must treat any error
 * result as blocking for required pre-PR verification; falling back to a local
 * cached base would allow stale artifacts to pass.
 */
export function fetchAndResolveBase(
  stateDir: string,
  baseBranch: string,
): BaseResolutionResult | BaseFetchError {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', baseBranch], {
      cwd: stateDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (err) {
    return classifyFetchError(baseBranch, commandErrorOutput(err));
  }

  try {
    const baseSha = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
      cwd: stateDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();

    if (!baseSha) {
      return {
        kind: 'resolve-failed',
        message: `Unable to resolve fetched base branch '${baseBranch}'.`,
        diagnostics:
          `Unable to resolve fetched base branch '${baseBranch}' after a successful fetch. ` +
          'Retry verification after refreshing the repository.',
      };
    }

    execFileSync('git', ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], {
      cwd: stateDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    return {
      baseSha,
      fetchedAt: Date.now(),
      fetchDiagnostics: {
        fetchedRef: `origin/${baseBranch}`,
        upstreamBranch: baseBranch,
      },
    };
  } catch (err) {
    const output = commandErrorOutput(err);
    return {
      kind: 'resolve-failed',
      message: `Unable to prove HEAD includes fetched base branch '${baseBranch}'.`,
      diagnostics:
        `HEAD is not a descendant of base branch '${baseBranch}', or the histories are unrelated. ` +
        'Rebase onto the refreshed base and rerun verification. ' +
        `Git reported: ${output || 'no diagnostic output'}`,
    };
  }
}

/**
 * Run the verification recipe: execute all commands in sequence.
 *
 * Behavior:
 * - Executes commands sequentially (one at a time)
 * - Enforces per-command timeout
 * - Captures stdout/stderr to bounded logs
 * - On deterministic failure (exit code != 0): stops and returns fail status
 * - On timeout: marks as timeout failure
 * - Continues to capture logs even on failure
 *
 * @param recipe Recipe with ordered commands
 * @param options Runtime options (cwd, logDir)
 * @returns Execution result with per-command status
 */
export function runVerificationRecipe(
  recipe: PrePrVerificationRecipe,
  options: {
    cwd?: string;
    logDir?: string;
    headSha?: string;
    baseSha?: string;
  } = {},
): PrePrVerificationResult {
  const cwd = options.cwd || process.cwd();
  const logDir = options.logDir || join(cwd, '.wavemill/pre-pr-verification');
  const commands: CommandResult[] = [];
  let overallStatus: 'pass' | 'fail' | 'timeout' | 'error' = 'pass';

  // Ensure log directory exists
  mkdirSync(logDir, { recursive: true });

  const timeoutSeconds = recipe.timeoutSeconds ?? 300;
  const runStart = Date.now();

  // Cap on-disk log size (~64KB per command) so we never balloon .wavemill.
  const MAX_LOG_BYTES = 64 * 1024;

  for (let index = 0; index < recipe.commands.length; index++) {
    const command = recipe.commands[index];
    const logFile = join(logDir, `cmd-${index}.log`);
    const startTime = Date.now();

    let status: CommandResult['status'] = 'pass';
    let exitCode: number | undefined;
    let stdout = '';
    let stderr = '';
    let failureReason: string | undefined;

    try {
      // Execute command with timeout (in milliseconds). Capture stdout and
      // stderr separately so failure diagnostics survive.
      const timeoutMs = timeoutSeconds * 1000;
      try {
        const buf = childExecSync(command, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf-8',
          timeout: timeoutMs,
          shell: '/bin/sh',
        });
        stdout = typeof buf === 'string' ? buf : String(buf);
        exitCode = 0;
      } catch (err) {
        const execErr = err as any;
        stdout = typeof execErr.stdout === 'string' ? execErr.stdout : (execErr.stdout?.toString?.() ?? '');
        stderr = typeof execErr.stderr === 'string' ? execErr.stderr : (execErr.stderr?.toString?.() ?? '');
        if (execErr.killed || execErr.signal === 'SIGTERM') {
          status = 'timeout';
          failureReason = `Command timed out after ${timeoutSeconds}s`;
        } else {
          status = 'fail';
          exitCode = typeof execErr.status === 'number' ? execErr.status : 1;
          failureReason = `Command exited with code ${exitCode}`;
        }
      }
    } catch (err) {
      status = 'error';
      failureReason = `Unexpected error: ${(err as Error).message}`;
    }

    const durationMs = Date.now() - startTime;

    // Write bounded log capture: command header + stdout + stderr, truncated
    // to MAX_LOG_BYTES with a marker if we dropped content.
    let logCapture =
      `Command: ${command}\nExit Code: ${exitCode ?? 'N/A'}\n\n` +
      `--- STDOUT ---\n${stdout}\n--- STDERR ---\n${stderr}\n`;
    if (Buffer.byteLength(logCapture, 'utf-8') > MAX_LOG_BYTES) {
      const truncated = Buffer.from(logCapture, 'utf-8').subarray(0, MAX_LOG_BYTES).toString('utf-8');
      logCapture = truncated + '\n[... log truncated to 64KB ...]\n';
    }
    writeFileSync(logFile, logCapture, 'utf-8');

    const result: CommandResult = {
      index,
      command,
      status,
      exitCode,
      durationMs,
      logPath: logFile,
    };

    if (failureReason) {
      result.failureReason = failureReason;
    }

    commands.push(result);

    // Update overall status
    if (status !== 'pass') {
      overallStatus = status;
      // Don't continue on failure (fail-closed)
      break;
    }
  }

  return {
    status: overallStatus,
    commands,
    startTime: runStart,
    endTime: Date.now(),
  };
}

export interface PrePrSafetyGuardResult {
  passed: boolean;
  reason?: string;
  /** Set when the scope check was bypassed rather than evaluated. */
  skipped?: boolean;
  /**
   * Why the scope check was bypassed:
   * - 'feature-dir-unresolved': no explicit featureDir was supplied and none
   *   could be derived from the branch name, so nothing about the task's
   *   scope is knowable.
   * - 'no-scope-authority': a feature directory resolved, but it yields
   *   neither a declared scope (Files to Modify / Scope In) nor a persisted
   *   review baseline, so there is nothing to enforce against.
   */
  skipCause?: 'feature-dir-unresolved' | 'no-scope-authority';
}

/**
 * Run the review scope guard as a pre-PR safety check.
 *
 * Findings from `validateReviewScope` fall into three classes (see
 * `ReviewScopeGuardFinding.kind`), and this wrapper maps them onto a
 * pass/fail/skip contract:
 *
 * - Any `violation` (out-of-scope path, deletion budget, cross-PR revert) or
 *   `error` (git/contract collection failed) blocks. Cross-PR revert and
 *   deletion-budget findings derive from baseRef, not the feature directory,
 *   so they block even when scope itself is unknowable — those are the
 *   findings that protect merged work.
 * - When only `missing-authority` findings remain, nothing was actually
 *   violated; the guard's behavior depends on how much authority it had:
 *   - No feature directory at all → fail **open** with
 *     `skipCause: 'feature-dir-unresolved'` (a missing input is not evidence
 *     of a violation).
 *   - Feature directory resolved but no declared scope AND no baseline →
 *     fail open with `skipCause: 'no-scope-authority'`.
 *   - Feature directory resolved and at least one authority present → the
 *     scope check ran against the available authority and found nothing, so
 *     this is a real **pass** (a task with a declared scope but no baseline
 *     file must not block on the absent baseline).
 *
 * `skipped` is set when the guard failed open, so callers can log a bypassed
 * check instead of mistaking it for a pass. Strictness on skip is the
 * caller's decision: `checkPrePrVerificationGate` treats
 * 'feature-dir-unresolved' as a configuration error.
 */
export function runPrePrSafetyGuard(options: {
  stateDir: string;
  baseSha: string;
  headSha?: string;
  featureDir?: string;
}): PrePrSafetyGuardResult {
  const result = validateReviewScope({
    repoDir: options.stateDir,
    featureDir: options.featureDir,
    baseRef: options.baseSha,
    headRef: options.headSha ?? 'HEAD',
    includeWorkingTree: false,
    writeBaseline: false,
  });

  if (result.ok) {
    return { passed: true };
  }

  const hasDeclaredScope = result.declaredScope.length > 0;
  const hasBaseline = result.baselineSource !== 'unresolved';
  const hasScopeAuthority = hasDeclaredScope || hasBaseline;

  // Fail closed on anything that is not a consequence of missing scope
  // authority: concrete violations, infrastructure errors, and (defensively)
  // findings predating the `kind` discriminant. One exception: with no scope
  // authority at all, every changed path is flagged as a review-scope
  // "violation" because it was compared against an empty allow-list — those
  // are artifacts of the missing authority, not evidence. Deletion-budget and
  // cross-PR-revert violations derive from baseRef, so they stay enforceable
  // regardless.
  const enforceableBlockers = result.findings.filter((finding) => {
    if (finding.severity !== 'blocker') return false;
    if (finding.kind === 'missing-authority') return false;
    if (!hasScopeAuthority && finding.kind === 'violation' && finding.category === 'review-scope') {
      return false;
    }
    return true;
  });
  if (enforceableBlockers.length > 0 || result.crossPrReverts.length > 0) {
    return {
      passed: false,
      reason: formatReviewScopeGuardResult(result),
    };
  }

  // Only missing-authority blockers (and, absent any authority, the per-path
  // findings they induce) remain: nothing was provably violated, but some
  // scope input could not be resolved.
  if (result.featureDir === null) {
    return {
      passed: true,
      skipped: true,
      skipCause: 'feature-dir-unresolved',
      reason:
        'Review scope guard skipped: no task feature directory could be resolved, ' +
        'so in-scope files could not be determined. Cross-PR revert and deletion ' +
        'checks still ran and found nothing.',
    };
  }

  if (!hasScopeAuthority) {
    return {
      passed: true,
      skipped: true,
      skipCause: 'no-scope-authority',
      reason:
        `Review scope guard skipped: feature directory ${result.featureDir} resolved, ` +
        'but the task declares no Files to Modify / Scope In entries and no review ' +
        'baseline artifact exists, so there is no scope authority to enforce. ' +
        'Cross-PR revert and deletion checks still ran and found nothing.',
    };
  }

  // At least one scope authority was available and the changed files all
  // passed against it; the other, absent authority is not a failure.
  return { passed: true };
}

/**
 * Write a verification artifact to disk atomically.
 *
 * Artifact includes:
 * - Execution result and per-command status
 * - Branch, HEAD SHA, base SHA (for validation)
 * - Timestamp and operator override (if any)
 * - Log file references (not full logs)
 *
 * @param result Execution result from runVerificationRecipe
 * @param artifactPath Target file path
 * @param options Context (branch, shas, override)
 */
export function writeVerificationArtifact(
  result: PrePrVerificationResult,
  artifactPath: string,
  options: {
    workingBranch?: string;
    headSha?: string;
    baseSha?: string;
    overriddenBy?: OperatorOverride | null;
  } = {},
): void {
  // Ensure directory exists
  mkdirSync(dirname(artifactPath), { recursive: true });

  const artifact: PrePrVerificationArtifact = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    workingBranch: options.workingBranch || 'unknown',
    headSha: options.headSha || 'unknown',
    baseSha: options.baseSha || 'unknown',
    overriddenBy: options.overriddenBy ?? null,
    commands: result.commands.map((cmd) => ({
      index: cmd.index,
      command: cmd.command,
      status: cmd.status,
      exitCode: cmd.exitCode,
      durationMs: cmd.durationMs,
      logPath: cmd.logPath,
      failureReason: cmd.failureReason,
    })),
    overallStatus: result.status,
    startTime: result.startTime,
    endTime: result.endTime,
  };

  // Write atomically
  writeArtifactAtomicSync(artifactPath, artifact);
}

/**
 * Read a verification artifact from disk and validate SHAs.
 *
 * @param artifactPath Path to artifact file
 * @param expectedHeadSha Expected HEAD SHA (for validation)
 * @param expectedBaseSha Expected base SHA (for validation)
 * @returns Artifact and match status
 */
export function readAndValidateArtifact(
  artifactPath: string,
  expectedHeadSha?: string,
  expectedBaseSha?: string,
): {
  artifact: PrePrVerificationArtifact | null;
  isValid: boolean;
  shasMismatch: boolean;
} {
  if (!existsSync(artifactPath)) {
    return { artifact: null, isValid: false, shasMismatch: false };
  }

  try {
    const content = readFileSync(artifactPath, 'utf-8');
    const artifact = JSON.parse(content) as PrePrVerificationArtifact;

    const shasMismatch = Boolean(
      (expectedHeadSha && artifact.headSha !== expectedHeadSha) ||
        (expectedBaseSha && artifact.baseSha !== expectedBaseSha),
    );

    return {
      artifact,
      isValid: !shasMismatch && artifact.overallStatus === 'pass',
      shasMismatch,
    };
  } catch (err) {
    return { artifact: null, isValid: false, shasMismatch: false };
  }
}

/**
 * Extract bounded log excerpt from a command result.
 * Returns first N lines + last N lines (default 50 each).
 *
 * @param logPath Path to full log file
 * @param captureLines Number of lines to capture from start/end
 * @returns Bounded log excerpt
 */
export function extractBoundedLogExcerpt(
  logPath: string,
  captureLines = 50,
): string {
  if (!existsSync(logPath)) {
    return '[Log file not found]';
  }

  try {
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');

    if (lines.length <= captureLines * 2) {
      return content; // Return all if smaller than bounds
    }

    const first = lines.slice(0, captureLines).join('\n');
    const last = lines.slice(-captureLines).join('\n');
    const truncated = `[... ${lines.length - captureLines * 2} lines omitted ...]\n`;

    return `${first}\n${truncated}${last}`;
  } catch {
    return '[Error reading log file]';
  }
}

/**
 * Get remediation guidance for a failed verification.
 *
 * @param result Verification result
 * @returns Human-readable guidance for the agent
 */
export function getRemediationGuidance(result: PrePrVerificationResult): string {
  if (result.status === 'pass') {
    return 'Verification passed.';
  }

  const failedCmd = result.commands.find((c) => c.status !== 'pass');
  if (!failedCmd) {
    return 'Verification failed for unknown reason.';
  }

  const logExcerpt = failedCmd.logPath
    ? extractBoundedLogExcerpt(failedCmd.logPath, 10)
    : 'No log available';

  return (
    `Command #${failedCmd.index} failed: ${failedCmd.command}\n` +
    `Reason: ${failedCmd.failureReason || 'Exit code ' + failedCmd.exitCode}\n\n` +
    `Last output:\n${logExcerpt}`
  );
}
