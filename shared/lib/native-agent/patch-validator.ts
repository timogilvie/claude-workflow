import path from 'node:path';
import {
  CONTRACT_VERSION,
  MAX_FUZZY_EDIT_DISTANCE,
  NativePatchModes,
  PatchErrorCode,
  type NativePatchContext,
  type NativePatchFuzzy,
  type PatchValidationError,
  type PatchValidationResult,
} from './patch-contract.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalize candidate patch paths to a comparable POSIX form for validation
 * and future patch application.
 */
export function normalizePath(rawPath: string): string {
  const normalizedSeparators = rawPath.replace(/\\/g, '/');
  const driveQualified = /^[A-Za-z]:($|\/)/.test(normalizedSeparators)
    ? `/${normalizedSeparators}`
    : normalizedSeparators;
  return path.posix.normalize(driveQualified);
}

function pushError(
  errors: PatchValidationError[],
  operationIndex: number | null,
  code: PatchValidationError['code'],
  message: string,
): void {
  errors.push({ operationIndex, code, message });
}

function validateContext(
  context: unknown,
  operationIndex: number,
  errors: PatchValidationError[],
): void {
  if (context === undefined) {
    return;
  }
  if (!isRecord(context)) {
    pushError(
      errors,
      operationIndex,
      PatchErrorCode.CONTEXT_INVALID,
      `operations[${operationIndex}].context must be an object when provided`,
    );
    return;
  }

  for (const side of ['before', 'after'] as const) {
    const value = (context as NativePatchContext)[side];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      pushError(
        errors,
        operationIndex,
        PatchErrorCode.CONTEXT_INVALID,
        `operations[${operationIndex}].context.${side} must be a string[] when provided`,
      );
    }
  }
}

function validateOccurrenceField(
  operation: Record<string, unknown>,
  field: 'expectedOccurrences' | 'occurrenceIndex',
  operationIndex: number,
  errors: PatchValidationError[],
): void {
  const value = operation[field];
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    pushError(
      errors,
      operationIndex,
      PatchErrorCode.OCCURRENCE_INVALID,
      `operations[${operationIndex}].${field} must be a non-negative integer when provided`,
    );
  }
}

function validateFuzzy(
  fuzzy: unknown,
  operationIndex: number,
  errors: PatchValidationError[],
): void {
  if (fuzzy === undefined) {
    return;
  }
  if (!isRecord(fuzzy)) {
    pushError(
      errors,
      operationIndex,
      PatchErrorCode.FUZZY_INVALID,
      `operations[${operationIndex}].fuzzy must be an object when provided`,
    );
    return;
  }

  const whitespace = (fuzzy as NativePatchFuzzy).whitespace;
  if (whitespace !== undefined && typeof whitespace !== 'boolean') {
    pushError(
      errors,
      operationIndex,
      PatchErrorCode.FUZZY_INVALID,
      `operations[${operationIndex}].fuzzy.whitespace must be boolean when provided`,
    );
  }

  const maxEditDistance = (fuzzy as NativePatchFuzzy).maxEditDistance;
  if (
    maxEditDistance !== undefined
    && (!Number.isInteger(maxEditDistance)
      || maxEditDistance < 0
      || maxEditDistance > MAX_FUZZY_EDIT_DISTANCE)
  ) {
    pushError(
      errors,
      operationIndex,
      PatchErrorCode.FUZZY_OUT_OF_RANGE,
      `operations[${operationIndex}].fuzzy.maxEditDistance must be an integer between 0 and ${MAX_FUZZY_EDIT_DISTANCE}`,
    );
  }
}

function validateOperation(
  operation: unknown,
  operationIndex: number,
  errors: PatchValidationError[],
): void {
  const record = isRecord(operation) ? operation : {};
  const rawPath = record.path;
  const pathText = typeof rawPath === 'string' ? rawPath : '';

  if (pathText.trim() === '') {
    pushError(
      errors,
      operationIndex,
      PatchErrorCode.PATH_EMPTY,
      `operations[${operationIndex}].path must be a non-empty string`,
    );
  } else {
    const normalizedPath = normalizePath(pathText);
    if (path.posix.isAbsolute(normalizedPath)) {
      pushError(
        errors,
        operationIndex,
        PatchErrorCode.PATH_ABSOLUTE,
        `operations[${operationIndex}].path must be relative: ${normalizedPath}`,
      );
    } else if (
      normalizedPath === '..'
      || normalizedPath.startsWith('../')
      || normalizedPath.split('/').includes('..')
    ) {
      pushError(
        errors,
        operationIndex,
        PatchErrorCode.PATH_TRAVERSAL,
        `operations[${operationIndex}].path must not traverse outside the worktree: ${normalizedPath}`,
      );
    }
  }

  const mode = record.mode;
  if (mode !== NativePatchModes[0] && mode !== NativePatchModes[1]) {
    pushError(
      errors,
      operationIndex,
      PatchErrorCode.UNKNOWN_MODE,
      `operations[${operationIndex}].mode must be one of ${NativePatchModes.join(', ')}`,
    );
  } else if (mode === 'edit') {
    if (typeof record.oldString !== 'string' || record.oldString.length === 0) {
      pushError(
        errors,
        operationIndex,
        PatchErrorCode.OLD_STRING_MISSING,
        `operations[${operationIndex}].oldString must be a non-empty string for edit mode`,
      );
    }
    if (typeof record.newString !== 'string') {
      pushError(
        errors,
        operationIndex,
        PatchErrorCode.NEW_STRING_MISSING,
        `operations[${operationIndex}].newString must be a string for edit mode`,
      );
    }
  } else {
    if (typeof record.diff !== 'string' || record.diff.length === 0) {
      pushError(
        errors,
        operationIndex,
        PatchErrorCode.DIFF_MISSING,
        `operations[${operationIndex}].diff must be a non-empty string for edit-diff mode`,
      );
    }
  }

  validateContext(record.context, operationIndex, errors);
  validateOccurrenceField(record, 'expectedOccurrences', operationIndex, errors);
  validateOccurrenceField(record, 'occurrenceIndex', operationIndex, errors);
  validateFuzzy(record.fuzzy, operationIndex, errors);
}

export function validateNativePatch(patch: unknown): PatchValidationResult {
  const errors: PatchValidationError[] = [];
  const record = isRecord(patch) ? patch : {};

  if (record.version !== CONTRACT_VERSION) {
    pushError(
      errors,
      null,
      PatchErrorCode.UNKNOWN_VERSION,
      `patch.version must be "${CONTRACT_VERSION}"`,
    );
  }

  const operations = record.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    pushError(
      errors,
      null,
      PatchErrorCode.EMPTY_OPERATIONS,
      'patch.operations must contain at least one operation',
    );
  } else {
    for (const [index, operation] of operations.entries()) {
      validateOperation(operation, index, errors);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, rejection: { errors } };
}
