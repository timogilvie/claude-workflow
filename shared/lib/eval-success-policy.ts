import { getEvalConfig } from './config.ts';

export const DEFAULT_SUCCESS_THRESHOLD = 0.8;
export const SUCCESS_POLICY_VERSION = '1';

interface EvalSuccessRecord {
  score?: number | null;
  outcomes?: {
    success?: boolean | null;
  } | null;
}

export function getSuccessThreshold(repoDir?: string): number {
  const configuredThreshold = getEvalConfig(repoDir).successThreshold;
  return isFiniteThreshold(configuredThreshold)
    ? configuredThreshold
    : DEFAULT_SUCCESS_THRESHOLD;
}

/**
 * Determines whether an eval record represents a successful outcome.
 *
 * Precedence:
 * 1. Explicit outcomes.success booleans override everything else.
 * 2. Numeric score falls back to score >= threshold.
 * 3. Missing signals are treated as unsuccessful.
 */
export function isEvalSuccess(
  record: EvalSuccessRecord | null | undefined,
  options?: { threshold?: number; repoDir?: string },
): boolean {
  const explicitSuccess = record?.outcomes?.success;
  if (typeof explicitSuccess === 'boolean') {
    return explicitSuccess;
  }

  if (typeof record?.score === 'number' && Number.isFinite(record.score)) {
    const threshold = isFiniteThreshold(options?.threshold)
      ? options.threshold
      : getSuccessThreshold(options?.repoDir);
    return record.score >= threshold;
  }

  return false;
}

function isFiniteThreshold(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1;
}
