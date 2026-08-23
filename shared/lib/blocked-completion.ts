import path from 'node:path';

import {
  readSeamArtifact,
  SEAM_VALIDATION_ERROR_CODES,
  validateSeamArtifactValue,
  type SeamValidationError,
} from './seam-artifacts.ts';

export const BLOCKED_COMPLETION_SCHEMA_VERSION = '1.0';
export const BLOCKED_COMPLETION_FILENAME = '.coding-blocked-completion.json';
export const BLOCKED_COMPLETION_STAGE = 'coding';

export const BLOCKING_REASONS = [
  'repo_verification_blocked',
  'environment_blocked',
  'baseline_tests_failing',
  'model_at_capacity',
] as const;

export const RECOMMENDED_ACTIONS = [
  'advance_to_review',
  'relaunch_coding',
] as const;

export type BlockedCompletionBlockingReason = (typeof BLOCKING_REASONS)[number];
export type BlockedCompletionRecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

export interface BlockedCompletion {
  stage: typeof BLOCKED_COMPLETION_STAGE;
  implementationComplete: boolean;
  committed: boolean;
  commit?: string;
  passingChecks: string[];
  blockingChecks: string[];
  blockingReason: BlockedCompletionBlockingReason;
  evidence: string;
  recommendedAction: BlockedCompletionRecommendedAction;
  createdAt?: string;
  [key: string]: unknown;
}

export const BLOCKED_COMPLETION_REQUIRED_FIELDS = [
  'stage',
  'implementationComplete',
  'committed',
  'passingChecks',
  'blockingChecks',
  'blockingReason',
  'evidence',
  'recommendedAction',
] as const;

export const BLOCKED_COMPLETION_VALIDATION_ERROR_CODES = SEAM_VALIDATION_ERROR_CODES;

export type BlockedCompletionValidationErrorCode =
  (typeof BLOCKED_COMPLETION_VALIDATION_ERROR_CODES)[number];

export type BlockedCompletionValidationError = SeamValidationError;

export type BlockedCompletionValidationResult =
  | { ok: true; value: BlockedCompletion }
  | { ok: false; errors: SeamValidationError[] };

export function hasVerificationEvidence(value: BlockedCompletion): boolean {
  return value.implementationComplete === true || value.passingChecks.length > 0;
}

export function coerceUnverifiedCompletionClaim(
  value: BlockedCompletion,
): { value: BlockedCompletion; coerced: boolean } {
  if (hasVerificationEvidence(value)) {
    return { value, coerced: false };
  }

  return {
    value: {
      ...value,
      implementationComplete: false,
    },
    coerced: true,
  };
}

/** Returns the absolute path to the blocked-completion artifact for a feature directory. */
export function getBlockedCompletionPath(featureDir: string): string {
  return path.join(featureDir, BLOCKED_COMPLETION_FILENAME);
}

/** Validates a parsed JSON value against the shared blocked-completion seam schema. */
export function validateBlockedCompletion(
  value: unknown,
): BlockedCompletionValidationResult {
  const result = validateSeamArtifactValue<BlockedCompletion>('blocked-completion', value, {
    coerceUnverifiedClaim: false,
  });
  if (result.ok) {
    return { ok: true, value: result.value };
  }
  return { ok: false, errors: result.errors };
}

/**
 * Reads and validates a blocked-completion artifact from disk.
 * Propagates filesystem errors and returns unified seam validation errors for
 * malformed content.
 */
export async function readBlockedCompletion(
  filePath: string,
): Promise<BlockedCompletionValidationResult> {
  const featureDir = path.dirname(filePath);
  const result = await readSeamArtifact<BlockedCompletion>('blocked-completion', featureDir);
  if (result.ok) {
    return { ok: true, value: result.value };
  }
  return { ok: false, errors: result.errors };
}
