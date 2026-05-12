import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const BLOCKED_COMPLETION_SCHEMA_VERSION = '1.0';
export const BLOCKED_COMPLETION_FILENAME = '.coding-blocked-completion.json';
export const BLOCKED_COMPLETION_STAGE = 'coding';

export const BLOCKING_REASONS = [
  'repo_verification_blocked',
  'environment_blocked',
  'baseline_tests_failing',
] as const;

export const RECOMMENDED_ACTIONS = [
  'advance_to_review',
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

type BlockedCompletionRequiredField = (typeof BLOCKED_COMPLETION_REQUIRED_FIELDS)[number];

export const BLOCKED_COMPLETION_VALIDATION_ERROR_CODES = [
  'MALFORMED_JSON',
  'MISSING_REQUIRED_FIELD',
  'INVALID_FIELD_TYPE',
  'INVALID_ENUM_VALUE',
  'INVALID_STAGE',
] as const;

export type BlockedCompletionValidationErrorCode =
  (typeof BLOCKED_COMPLETION_VALIDATION_ERROR_CODES)[number];

export interface BlockedCompletionValidationSuccess {
  ok: true;
  value: BlockedCompletion;
}

export interface BlockedCompletionValidationError {
  ok: false;
  code: BlockedCompletionValidationErrorCode;
  field?: string;
  message: string;
}

export type BlockedCompletionValidationResult =
  | BlockedCompletionValidationSuccess
  | BlockedCompletionValidationError;

function validationError(
  code: BlockedCompletionValidationErrorCode,
  message: string,
  field?: string,
): BlockedCompletionValidationError {
  if (field === undefined) {
    return { ok: false, code, message };
  }

  return { ok: false, code, field, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasField(
  value: Record<string, unknown>,
  field: BlockedCompletionRequiredField,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, field) && value[field] !== undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEnumValue<T extends readonly string[]>(
  enumValues: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && enumValues.includes(value as T[number]);
}

export function getBlockedCompletionPath(featureDir: string): string {
  return path.join(featureDir, BLOCKED_COMPLETION_FILENAME);
}

export function validateBlockedCompletion(
  value: unknown,
): BlockedCompletionValidationResult {
  if (!isRecord(value)) {
    return validationError(
      'INVALID_FIELD_TYPE',
      'Blocked completion artifact must be a JSON object.',
      'artifact',
    );
  }

  for (const field of BLOCKED_COMPLETION_REQUIRED_FIELDS) {
    if (!hasField(value, field)) {
      return validationError(
        'MISSING_REQUIRED_FIELD',
        `Blocked completion artifact is missing required field "${field}".`,
        field,
      );
    }
  }

  if (value.stage !== BLOCKED_COMPLETION_STAGE) {
    return validationError(
      'INVALID_STAGE',
      `Blocked completion stage must be "${BLOCKED_COMPLETION_STAGE}".`,
      'stage',
    );
  }

  if (typeof value.implementationComplete !== 'boolean') {
    return validationError(
      'INVALID_FIELD_TYPE',
      'Blocked completion field "implementationComplete" must be a boolean.',
      'implementationComplete',
    );
  }

  if (typeof value.committed !== 'boolean') {
    return validationError(
      'INVALID_FIELD_TYPE',
      'Blocked completion field "committed" must be a boolean.',
      'committed',
    );
  }

  if (!isStringArray(value.passingChecks)) {
    return validationError(
      'INVALID_FIELD_TYPE',
      'Blocked completion field "passingChecks" must be an array of strings.',
      'passingChecks',
    );
  }

  if (!isStringArray(value.blockingChecks)) {
    return validationError(
      'INVALID_FIELD_TYPE',
      'Blocked completion field "blockingChecks" must be an array of strings.',
      'blockingChecks',
    );
  }

  if (!isEnumValue(BLOCKING_REASONS, value.blockingReason)) {
    return validationError(
      'INVALID_ENUM_VALUE',
      'Blocked completion field "blockingReason" must be a recognized value.',
      'blockingReason',
    );
  }

  if (typeof value.evidence !== 'string') {
    return validationError(
      'INVALID_FIELD_TYPE',
      'Blocked completion field "evidence" must be a string.',
      'evidence',
    );
  }

  if (!isEnumValue(RECOMMENDED_ACTIONS, value.recommendedAction)) {
    return validationError(
      'INVALID_ENUM_VALUE',
      'Blocked completion field "recommendedAction" must be a recognized value.',
      'recommendedAction',
    );
  }

  if (Object.prototype.hasOwnProperty.call(value, 'commit') && value.commit !== undefined
    && typeof value.commit !== 'string') {
    return validationError(
      'INVALID_FIELD_TYPE',
      'Blocked completion field "commit" must be a string when present.',
      'commit',
    );
  }

  if (Object.prototype.hasOwnProperty.call(value, 'createdAt') && value.createdAt !== undefined
    && typeof value.createdAt !== 'string') {
    return validationError(
      'INVALID_FIELD_TYPE',
      'Blocked completion field "createdAt" must be a string when present.',
      'createdAt',
    );
  }

  return {
    ok: true,
    value: value as BlockedCompletion,
  };
}

export async function readBlockedCompletion(
  filePath: string,
): Promise<BlockedCompletionValidationResult> {
  const content = await readFile(filePath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return validationError(
      'MALFORMED_JSON',
      `Blocked completion artifact at ${filePath} contains malformed JSON.`,
    );
  }

  return validateBlockedCompletion(parsed);
}
