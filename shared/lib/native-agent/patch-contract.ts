import path from 'node:path';

export const NATIVE_PATCH_VERSION = 1 as const;

export type NativePatchValidationErrorCode =
  | 'invalid_type'
  | 'invalid_version'
  | 'non_atomic_patch'
  | 'empty_operations'
  | 'invalid_operation'
  | 'unsupported_operation'
  | 'invalid_path'
  | 'invalid_text'
  | 'invalid_context'
  | 'invalid_expected_occurrences'
  | 'identical_old_new'
  | 'invalid_fuzzy_match';

export interface NativePatchValidationError {
  code: NativePatchValidationErrorCode;
  path: string;
  message: string;
  operationIndex?: number;
}

export interface NativePatchContextAnchors {
  anchorBefore?: string;
  anchorAfter?: string;
  expectedOccurrences?: number;
}

export interface NativePatchFuzzyMatch {
  minSimilarity?: number;
  maxMatchCandidates?: number;
  maxContextLines?: number;
  ignoreWhitespace?: boolean;
  requireAnchorOverlap?: boolean;
}

export interface NativePatchEditOperation extends NativePatchContextAnchors {
  op: 'edit';
  path: string;
  oldText: string;
  newText: string;
}

export interface NativePatchEditDiffOperation extends NativePatchContextAnchors {
  op: 'edit-diff';
  path: string;
  diff: string;
}

export type NativePatchOperation = NativePatchEditOperation | NativePatchEditDiffOperation;

export interface NativePatch {
  version: typeof NATIVE_PATCH_VERSION;
  atomic: true;
  operations: NativePatchOperation[];
  fuzzyMatch?: NativePatchFuzzyMatch;
}

export const NATIVE_PATCH_EXAMPLE: NativePatch = {
  version: NATIVE_PATCH_VERSION,
  atomic: true,
  operations: [
    {
      op: 'edit',
      path: 'src/example.ts',
      oldText: 'export const value = "before";\n',
      newText: 'export const value = "after";\n',
    },
  ],
};

export const NATIVE_PATCH_CONTRACT_SUMMARY = [
  'NativePatch envelope: version must be 1, atomic must be true, and operations must be a non-empty array.',
  'Operation variants:',
  '- edit: requires path, oldText, and newText.',
  '- edit-diff: requires path and diff.',
  'Paths are repo-relative POSIX paths. Operations may include anchorBefore, anchorAfter, and expectedOccurrences.',
  'Optional fuzzyMatch supports minSimilarity, maxMatchCandidates, maxContextLines, ignoreWhitespace, and requireAnchorOverlap.',
].join('\n');

export const NATIVE_PATCH_PARAMETERS_SCHEMA = {
  type: 'object',
  description: 'NativePatch payload. Required envelope: version: 1, atomic: true, operations: non-empty array. Use op "edit" with path/oldText/newText or op "edit-diff" with path/diff.',
  properties: {
    version: {
      type: 'number',
      enum: [NATIVE_PATCH_VERSION],
      description: 'Required NativePatch contract version. Must be 1.',
    },
    atomic: {
      type: 'boolean',
      enum: [true],
      description: 'Required. Must be true; all operations apply atomically or none are applied.',
    },
    operations: {
      type: 'array',
      minItems: 1,
      description: 'Required non-empty array of edit operations. For op "edit", include path, oldText, newText. For op "edit-diff", include path and diff.',
      items: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['edit', 'edit-diff'],
            description: 'Operation variant. "edit" requires oldText/newText; "edit-diff" requires diff.',
          },
          path: {
            type: 'string',
            description: 'Repo-relative POSIX path without traversal, for example "src/app.ts".',
          },
          oldText: {
            type: 'string',
            description: 'Required for op "edit": exact existing text to replace. Must be non-empty.',
          },
          newText: {
            type: 'string',
            description: 'Required for op "edit": replacement text. May be empty to delete oldText.',
          },
          diff: {
            type: 'string',
            description: 'Required for op "edit-diff": unified diff hunk text for this path.',
          },
          anchorBefore: {
            type: 'string',
            description: 'Optional non-empty context that should appear before the edit.',
          },
          anchorAfter: {
            type: 'string',
            description: 'Optional non-empty context that should appear after the edit.',
          },
          expectedOccurrences: {
            type: 'number',
            description: 'Optional positive integer for the expected count of oldText matches.',
          },
        },
        additionalProperties: true,
      },
    },
    fuzzyMatch: {
      type: 'object',
      description: 'Optional fuzzy matching settings used when exact oldText matching needs controlled recovery.',
      properties: {
        minSimilarity: {
          type: 'number',
          description: 'Optional number between 0 and 1.',
        },
        maxMatchCandidates: {
          type: 'number',
          description: 'Optional positive integer.',
        },
        maxContextLines: {
          type: 'number',
          description: 'Optional integer greater than or equal to 0.',
        },
        ignoreWhitespace: {
          type: 'boolean',
          description: 'Optional boolean.',
        },
        requireAnchorOverlap: {
          type: 'boolean',
          description: 'Optional boolean.',
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: true,
} as const;

export function buildNativePatchGuidance(): string {
  return [
    NATIVE_PATCH_CONTRACT_SUMMARY,
    '',
    'Valid NativePatch example:',
    '```json',
    JSON.stringify(NATIVE_PATCH_EXAMPLE, null, 2),
    '```',
  ].join('\n');
}

export type NativePatchRuntimeRejectionCode =
  | 'path_denied'
  | 'old_text_not_found'
  | 'ambiguous_anchor'
  | 'anchor_mismatch'
  | 'phase_denied'
  | 'fuzzy_below_threshold';

export interface NativePatchRuntimeRejectionContext {
  path: string;
  excerpt: string;
  startLine?: number;
  endLine?: number;
}

export interface NativePatchRuntimeRejection {
  operationIndex: number;
  code: NativePatchRuntimeRejectionCode;
  message: string;
  requestedContext: {
    oldText?: string;
    diff?: string;
    anchorBefore?: string;
    anchorAfter?: string;
    normalizedOldText?: string;
  };
  liveContext?: NativePatchRuntimeRejectionContext;
  hint: string;
}

export interface NativePatchRejectedResult {
  ok: false;
  atomic: true;
  appliedOperations: 0;
  rejection: NativePatchRuntimeRejection;
}

export type ValidateNativePatchResult =
  | { ok: true; value: NativePatch }
  | { ok: false; errors: NativePatchValidationError[] };

/**
 * Normalize a candidate patch path into a repo-relative POSIX path.
 *
 * Inputs must already be strings. This helper rejects absolute, traversal,
 * Windows-style, and empty paths so validation can fail before any file I/O.
 */
export function normalizePatchPath(input: string): string | null {
  if (input.length === 0 || input.includes('\0') || input.includes('\\')) {
    return null;
  }

  if (path.posix.isAbsolute(input)) {
    return null;
  }

  const segments = input.split('/');
  if (segments.some((segment) => segment === '..')) {
    return null;
  }

  const normalized = path.posix.normalize(input);
  if (normalized === '.' || normalized.length === 0 || normalized.startsWith('../')) {
    return null;
  }

  return normalized.replace(/^(?:\.\/)+/, '');
}

export function validateNativePatch(input: unknown): ValidateNativePatchResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [
        {
          code: 'invalid_type',
          path: '$',
          message: 'NativePatch must be an object.',
        },
      ],
    };
  }

  const errors: NativePatchValidationError[] = [];

  if (input.version !== NATIVE_PATCH_VERSION) {
    errors.push({
      code: 'invalid_version',
      path: '$.version',
      message: `NativePatch version must be ${NATIVE_PATCH_VERSION}.`,
    });
  }

  if (input.atomic !== true) {
    errors.push({
      code: 'non_atomic_patch',
      path: '$.atomic',
      message: 'NativePatch.atomic must be true.',
    });
  }

  const normalizedFuzzyMatch = validateFuzzyMatch(input.fuzzyMatch, errors);
  const normalizedOperations = validateOperations(input.operations, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: normalizedOperations,
      ...(normalizedFuzzyMatch ? { fuzzyMatch: normalizedFuzzyMatch } : {}),
    },
  };
}

function validateFuzzyMatch(
  input: unknown,
  errors: NativePatchValidationError[],
): NativePatchFuzzyMatch | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (!isRecord(input)) {
    errors.push({
      code: 'invalid_fuzzy_match',
      path: '$.fuzzyMatch',
      message: 'NativePatch.fuzzyMatch must be an object.',
    });
    return undefined;
  }

  const result: NativePatchFuzzyMatch = {};

  validateOptionalNumber(input.minSimilarity, '$.fuzzyMatch.minSimilarity', errors, {
    code: 'invalid_fuzzy_match',
    integer: false,
    min: 0,
    max: 1,
  }, (value) => {
    result.minSimilarity = value;
  });

  validateOptionalNumber(input.maxMatchCandidates, '$.fuzzyMatch.maxMatchCandidates', errors, {
    code: 'invalid_fuzzy_match',
    integer: true,
    min: 1,
  }, (value) => {
    result.maxMatchCandidates = value;
  });

  validateOptionalNumber(input.maxContextLines, '$.fuzzyMatch.maxContextLines', errors, {
    code: 'invalid_fuzzy_match',
    integer: true,
    min: 0,
  }, (value) => {
    result.maxContextLines = value;
  });

  validateOptionalBoolean(input.ignoreWhitespace, '$.fuzzyMatch.ignoreWhitespace', errors, (value) => {
    result.ignoreWhitespace = value;
  });
  validateOptionalBoolean(input.requireAnchorOverlap, '$.fuzzyMatch.requireAnchorOverlap', errors, (value) => {
    result.requireAnchorOverlap = value;
  });

  return result;
}

function validateOperations(
  input: unknown,
  errors: NativePatchValidationError[],
): NativePatchOperation[] {
  if (!Array.isArray(input)) {
    errors.push({
      code: 'invalid_type',
      path: '$.operations',
      message: 'NativePatch.operations must be an array.',
    });
    return [];
  }

  if (input.length === 0) {
    errors.push({
      code: 'empty_operations',
      path: '$.operations',
      message: 'NativePatch.operations must contain at least one operation.',
    });
    return [];
  }

  const operations: NativePatchOperation[] = [];

  for (const [index, operation] of input.entries()) {
    const validatedOperation = validateOperation(operation, index, errors);
    if (validatedOperation) {
      operations.push(validatedOperation);
    }
  }

  return operations;
}

function validateOperation(
  input: unknown,
  index: number,
  errors: NativePatchValidationError[],
): NativePatchOperation | null {
  const basePath = `$.operations[${index}]`;
  if (!isRecord(input)) {
    errors.push({
      code: 'invalid_operation',
      path: basePath,
      message: 'NativePatch operation must be an object.',
      operationIndex: index,
    });
    return null;
  }

  const normalizedPath = validateOperationPath(input.path, index, errors);
  const anchors = validateContextAnchors(input, index, errors);

  if (input.op === 'edit') {
    const oldText = validateRequiredNonEmptyString(input.oldText, `${basePath}.oldText`, index, errors, 'invalid_text');
    const newText = validateRequiredString(input.newText, `${basePath}.newText`, index, errors, 'invalid_text');
    if (oldText !== null && newText !== null && oldText === newText) {
      errors.push({
        code: 'identical_old_new',
        path: `${basePath}.newText`,
        message: `${basePath}.newText must differ from oldText.`,
        operationIndex: index,
      });
    }
    if (!normalizedPath || oldText === null || newText === null) {
      return null;
    }
    if (oldText === newText) {
      return null;
    }
    return { op: 'edit', path: normalizedPath, oldText, newText, ...anchors };
  }

  if (input.op === 'edit-diff') {
    const diff = validateRequiredNonEmptyString(input.diff, `${basePath}.diff`, index, errors, 'invalid_text');
    if (!normalizedPath || diff === null) {
      return null;
    }
    return { op: 'edit-diff', path: normalizedPath, diff, ...anchors };
  }

  errors.push({
    code: typeof input.op === 'string' ? 'unsupported_operation' : 'invalid_operation',
    path: `${basePath}.op`,
    message: 'NativePatch operation op must be "edit" or "edit-diff".',
    operationIndex: index,
  });
  return null;
}

function validateOperationPath(
  input: unknown,
  index: number,
  errors: NativePatchValidationError[],
): string | null {
  const pathKey = `$.operations[${index}].path`;
  if (typeof input !== 'string') {
    errors.push({
      code: 'invalid_path',
      path: pathKey,
      message: 'NativePatch operation path must be a string.',
      operationIndex: index,
    });
    return null;
  }

  const normalized = normalizePatchPath(input);
  if (!normalized) {
    errors.push({
      code: 'invalid_path',
      path: pathKey,
      message: 'NativePatch operation path must be a repo-relative POSIX path without traversal.',
      operationIndex: index,
    });
    return null;
  }

  return normalized;
}

function validateContextAnchors(
  input: NativePatchOperation | Record<string, unknown>,
  index: number,
  errors: NativePatchValidationError[],
): NativePatchContextAnchors {
  const anchors: NativePatchContextAnchors = {};
  const basePath = `$.operations[${index}]`;

  if ('anchorBefore' in input) {
    const value = validateOptionalNonEmptyString(
      input.anchorBefore,
      `${basePath}.anchorBefore`,
      index,
      errors,
      'invalid_context',
    );
    if (value !== undefined) {
      anchors.anchorBefore = value;
    }
  }

  if ('anchorAfter' in input) {
    const value = validateOptionalNonEmptyString(
      input.anchorAfter,
      `${basePath}.anchorAfter`,
      index,
      errors,
      'invalid_context',
    );
    if (value !== undefined) {
      anchors.anchorAfter = value;
    }
  }

  if ('expectedOccurrences' in input) {
    validateOptionalNumber(
      input.expectedOccurrences,
      `${basePath}.expectedOccurrences`,
      errors,
      { code: 'invalid_expected_occurrences', integer: true, min: 1 },
      (value) => {
        anchors.expectedOccurrences = value;
      },
      index,
    );
  }

  return anchors;
}

function validateRequiredString(
  input: unknown,
  pathKey: string,
  index: number,
  errors: NativePatchValidationError[],
  code: NativePatchValidationErrorCode,
): string | null {
  if (typeof input !== 'string') {
    errors.push({ code, path: pathKey, message: `${pathKey} must be a string.`, operationIndex: index });
    return null;
  }
  return input;
}

function validateRequiredNonEmptyString(
  input: unknown,
  pathKey: string,
  index: number,
  errors: NativePatchValidationError[],
  code: NativePatchValidationErrorCode,
): string | null {
  if (typeof input !== 'string' || input.length === 0) {
    errors.push({ code, path: pathKey, message: `${pathKey} must be a non-empty string.`, operationIndex: index });
    return null;
  }
  return input;
}

function validateOptionalNonEmptyString(
  input: unknown,
  pathKey: string,
  index: number,
  errors: NativePatchValidationError[],
  code: NativePatchValidationErrorCode,
): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== 'string' || input.length === 0) {
    errors.push({ code, path: pathKey, message: `${pathKey} must be a non-empty string when provided.`, operationIndex: index });
    return undefined;
  }

  return input;
}

function validateOptionalBoolean(
  input: unknown,
  pathKey: string,
  errors: NativePatchValidationError[],
  onValid: (value: boolean) => void,
): void {
  if (input === undefined) {
    return;
  }
  if (typeof input !== 'boolean') {
    errors.push({
      code: 'invalid_fuzzy_match',
      path: pathKey,
      message: `${pathKey} must be a boolean when provided.`,
    });
    return;
  }
  onValid(input);
}

function validateOptionalNumber(
  input: unknown,
  pathKey: string,
  errors: NativePatchValidationError[],
  options: {
    code: NativePatchValidationErrorCode;
    integer: boolean;
    min: number;
    max?: number;
  },
  onValid: (value: number) => void,
  operationIndex?: number,
): void {
  if (input === undefined) {
    return;
  }

  if (
    typeof input !== 'number'
    || Number.isNaN(input)
    || !Number.isFinite(input)
    || (options.integer && !Number.isInteger(input))
    || input < options.min
    || (options.max !== undefined && input > options.max)
  ) {
    const rangeMessage = options.max === undefined
      ? `>= ${options.min}`
      : `between ${options.min} and ${options.max}`;
    const error: NativePatchValidationError = {
      code: options.code,
      path: pathKey,
      message: `${pathKey} must be ${options.integer ? 'an integer' : 'a number'} ${rangeMessage} when provided.`,
    };
    if (operationIndex !== undefined) {
      error.operationIndex = operationIndex;
    }
    errors.push(error);
    return;
  }

  onValid(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
