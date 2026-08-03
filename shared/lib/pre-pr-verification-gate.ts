/**
 * Pre-PR verification gate enforcement.
 *
 * Inserted between coding-complete and PR creation to enforce verification
 * requirements based on configuration and artifact state.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PrePrVerificationConfigSchema } from './config.ts';
import {
  readAndValidateArtifact,
  getRemediationGuidance,
} from './pre-pr-verification.ts';
import type { PrePrVerificationArtifact } from './pre-pr-verification-types.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface GateCheckResult {
  passed: boolean;
  reason?: string;
  artifact?: PrePrVerificationArtifact;
  recommendation?: string;
  requiresRemediation?: boolean;
  remediationPrompt?: string;
}

// ────────────────────────────────────────────────────────────────
// Core Gate Functions
// ────────────────────────────────────────────────────────────────

/**
 * Check if the pre-PR verification gate should allow PR creation.
 *
 * Gate checks (in order):
 * 1. Is verification configured and required?
 * 2. Does artifact exist for current HEAD/base?
 * 3. Is artifact recent (< staleTtlSeconds)?
 * 4. Did all commands pass?
 *
 * On failure, returns actionable recommendation for agent.
 *
 * @param stateDir Working directory (contains .wavemill/pre-pr-verification/)
 * @param config Pre-PR verification config
 * @param currentHeadSha Current HEAD SHA
 * @param currentBaseSha Current base SHA
 * @returns Gate result with pass/fail and recommendations
 */
export function checkPrePrVerificationGate(
  stateDir: string,
  config: PrePrVerificationConfigSchema | undefined,
  currentHeadSha?: string,
  currentBaseSha?: string,
): GateCheckResult {
  // Check 1: Is verification configured?
  if (!config || !config.enabled) {
    return { passed: true }; // Gate disabled, pass through
  }

  // Check 2: Is verification required?
  const isRequired = config.required ?? false;
  const compatMode = config.compatibility?.mode ?? 'allow';

  if (!isRequired) {
    // Optional: pass, but could log warning
    return { passed: true };
  }

  // Check 3: Locate artifact
  const artifactPath = join(stateDir, '.wavemill/pre-pr-verification/artifact.json');

  const { artifact, isValid, shasMismatch } = readAndValidateArtifact(
    artifactPath,
    currentHeadSha,
    currentBaseSha,
  );

  // Check 4: Artifact exists and is valid?
  if (!artifact) {
    return {
      passed: false,
      reason: 'No verification artifact found',
      recommendation:
        'Run: npx tsx tools/run-pre-pr-verification.ts\n' +
        'This executes the configured CI checks locally before PR creation.',
      requiresRemediation: false,
    };
  }

  // Check 5: SHA mismatch?
  if (shasMismatch) {
    return {
      passed: false,
      artifact,
      reason: `Artifact SHAs do not match current HEAD/base (artifact is stale)`,
      recommendation:
        'Rebase to latest base and re-run verification:\n' +
        '  git fetch && git rebase origin/base\n' +
        '  npx tsx tools/run-pre-pr-verification.ts --force',
    };
  }

  // Check 6: Is artifact stale (beyond TTL)?
  const staleTtl = (config.staleTtlSeconds ?? 3600) * 1000;
  const artifactAge = Date.now() - new Date(artifact.timestamp).getTime();

  if (artifactAge > staleTtl) {
    return {
      passed: false,
      artifact,
      reason: `Verification artifact is stale (${Math.round(artifactAge / 1000)}s old)`,
      recommendation:
        `Artifact is older than ${config.staleTtlSeconds}s. Re-run verification:\n` +
        '  npx tsx tools/run-pre-pr-verification.ts --force',
    };
  }

  // Check 7: Operator override present? (takes precedence over pass/fail)
  if (artifact.overriddenBy) {
    return {
      passed: true,
      artifact,
      reason: `Verification passed (overridden by ${artifact.overriddenBy.operator})`,
      recommendation: 'Override recorded in artifact metadata.',
    };
  }

  // Check 8: Did verification pass?
  if (artifact.overallStatus !== 'pass') {
    const remediationGuidance = getRemediationGuidance({
      status: artifact.overallStatus,
      commands: artifact.commands,
    });

    return {
      passed: false,
      artifact,
      reason: `Verification failed: ${artifact.overallStatus}`,
      requiresRemediation: true,
      remediationPrompt:
        `The following verification command failed:\n\n` +
        `${remediationGuidance}\n\n` +
        `Fix the issue and re-run:\n  npx tsx tools/run-pre-pr-verification.ts --force`,
    };
  }

  // All checks passed!
  return {
    passed: true,
    artifact,
    reason: 'Verification passed',
  };
}

/**
 * Determine compatibility mode behavior.
 *
 * Mode      | Unconfigured   | Configured
 * ----------|----------------|----------
 * allow     | pass silently   | use normal gate
 * warn      | pass + warn     | use normal gate
 * block     | fail            | use normal gate
 *
 * @param config Config (may be undefined for unconfigured repos)
 * @param isConfigured Whether repo has a recipe configured
 * @returns Effective behavior
 */
export function getCompatibilityBehavior(
  config: PrePrVerificationConfigSchema | undefined,
  isConfigured: boolean,
): 'allow' | 'warn' | 'block' {
  if (isConfigured) {
    return 'allow'; // Use normal gate, not compat mode
  }

  const mode = config?.compatibility?.mode ?? 'allow';
  return mode;
}

/**
 * Format gate failure for agent feedback.
 *
 * @param result Gate check result
 * @returns Human-readable message
 */
export function formatGateFailure(result: GateCheckResult): string {
  if (result.passed) {
    return 'Gate check passed.';
  }

  let message = `Pre-PR verification gate failed: ${result.reason || 'unknown'}\n\n`;

  if (result.requiresRemediation && result.remediationPrompt) {
    message += `${result.remediationPrompt}\n`;
  } else if (result.recommendation) {
    message += `Recommended action:\n${result.recommendation}\n`;
  }

  return message;
}

/**
 * Determine if the gate failure is remediable by the agent.
 *
 * Remediable failures:
 * - Command exited with non-zero code (can fix and re-run)
 * - Artifact missing/stale (can re-run)
 *
 * Non-remediable failures:
 * - GitHub metadata unavailable (needs human investigation)
 * - Permissions issue (needs auth fix)
 *
 * @param result Gate check result
 * @returns true if agent can attempt remediation
 */
export function isRemediable(result: GateCheckResult): boolean {
  if (result.passed) {
    return false;
  }

  // Artifact missing or stale → re-run can fix
  if (!result.artifact) {
    return true;
  }

  // Command failure → agent can fix code and re-run
  if (result.artifact.overallStatus === 'fail') {
    return true;
  }

  // Timeout → re-run can fix
  if (result.artifact.overallStatus === 'timeout') {
    return true;
  }

  return false;
}
