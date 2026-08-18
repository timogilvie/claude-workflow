import {
  buildSeamArtifactRetryGuidance,
  parseLenientObject,
  validateSeamArtifactContent,
  type ParseLenientObjectResult,
  type SeamValidationError,
} from '../seam-artifacts.ts';
import {
  type BlockedCompletion,
} from '../blocked-completion.ts';
import {
  type CodingComplete,
} from './coding-artifacts.ts';

export type CompletionArtifact = 'coding-complete' | 'blocked-completion';

export interface RetryGuidanceError {
  code: string;
  message: string;
  path?: string;
  field?: string;
}

export type { ParseLenientObjectResult };
export { parseLenientObject };

export type NormalizeCodingCompleteResult =
  | {
    ok: true;
    value: CodingComplete;
    canonicalContent: string;
    warnings: string[];
    changed: boolean;
  }
  | { ok: false; errors: SeamValidationError[] };

export type NormalizeBlockedCompletionResult =
  | {
    ok: true;
    value: BlockedCompletion;
    canonicalContent: string;
    warnings: string[];
    changed: boolean;
    coercedUnverifiedClaim: boolean;
  }
  | { ok: false; errors: SeamValidationError[] };

export function normalizeCodingCompleteContent(raw: string): NormalizeCodingCompleteResult {
  const result = validateSeamArtifactContent<CodingComplete>('coding-complete', raw);
  if (!result.ok) return { ok: false, errors: result.errors };
  return {
    ok: true,
    value: result.value,
    canonicalContent: result.canonicalContent,
    warnings: result.warnings,
    changed: result.changed,
  };
}

export function normalizeBlockedCompletionContent(raw: string): NormalizeBlockedCompletionResult {
  const withoutCoercion = validateSeamArtifactContent<BlockedCompletion>('blocked-completion', raw);
  const withCoercion = validateSeamArtifactContent<BlockedCompletion>('blocked-completion', raw, {
    coerceUnverifiedClaim: true,
  });

  if (!withCoercion.ok) return { ok: false, errors: withCoercion.errors };
  const coercedUnverifiedClaim = !withoutCoercion.ok
    && withoutCoercion.errors.some((error) => error.code === 'NO_VERIFICATION_EVIDENCE');

  return {
    ok: true,
    value: withCoercion.value,
    canonicalContent: withCoercion.canonicalContent,
    warnings: withCoercion.warnings,
    changed: withCoercion.changed,
    coercedUnverifiedClaim,
  };
}

export function buildCompletionArtifactRetryGuidance(
  artifact: CompletionArtifact,
  errors: readonly RetryGuidanceError[],
): string {
  const seamErrors: SeamValidationError[] = errors.map((error) => ({
    code: isSeamErrorCode(error.code) ? error.code : 'INVALID_VALUE',
    path: error.path ?? error.field ?? '$',
    message: error.message,
  }));
  return buildSeamArtifactRetryGuidance(artifact, seamErrors);
}

export function noVerificationEvidenceError(): SeamValidationError {
  return {
    code: 'NO_VERIFICATION_EVIDENCE',
    path: '$.passingChecks',
    message: 'Blocked completion cannot claim implementationComplete=true with no passingChecks evidence.',
  };
}

export function hasBlockedCompletionVerificationEvidence(value: BlockedCompletion): boolean {
  return value.implementationComplete !== true || value.passingChecks.length > 0;
}

function isSeamErrorCode(code: string): code is SeamValidationError['code'] {
  return [
    'MALFORMED_JSON',
    'MISSING_REQUIRED_FIELD',
    'INVALID_FIELD_TYPE',
    'INVALID_ENUM_VALUE',
    'INVALID_STAGE',
    'INVALID_VALUE',
    'NO_VERIFICATION_EVIDENCE',
    'ARTIFACT_NOT_FOUND',
  ].includes(code);
}
