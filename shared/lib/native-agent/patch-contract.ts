/**
 * Native patch contract definitions for the Wavemill-owned envelope layered on
 * top of Pi string-replace patch operations.
 *
 * @module patch-contract
 */

export const CONTRACT_VERSION = '1';

export const NativePatchModes = ['edit', 'edit-diff'] as const;
export type NativePatchMode = (typeof NativePatchModes)[number];

export const MAX_FUZZY_EDIT_DISTANCE = 8;

export interface NativePatchContext {
  before?: string[];
  after?: string[];
}

export interface NativePatchFuzzy {
  whitespace?: boolean;
  maxEditDistance?: number;
}

export const DEFAULT_FUZZY: Readonly<Required<NativePatchFuzzy>> = {
  whitespace: false,
  maxEditDistance: 0,
};

export interface NativePatchOperation {
  /**
   * Relative file path. Validators normalize Windows separators and leading
   * `./`, then reject absolute and traversal paths before any file mutation.
   */
  path: string;
  mode: NativePatchMode;
  oldString?: string;
  newString?: string;
  diff?: string;
  expectedOccurrences?: number;
  occurrenceIndex?: number;
  context?: NativePatchContext;
  fuzzy?: NativePatchFuzzy;
}

export interface NativePatch {
  version: string;
  operations: NativePatchOperation[];
}

/**
 * Policy-only input for a later whole-file write allowlist gate. This contract
 * does not itself enforce whole-file writes.
 */
export interface WholeFileWriteAllowlistInput {
  generatedPathGlobs?: string[];
  wavemillOwnedPathMarkers?: string[];
}

export const PatchErrorCode = {
  UNKNOWN_VERSION: 'PATCH_UNKNOWN_VERSION',
  EMPTY_OPERATIONS: 'PATCH_EMPTY_OPERATIONS',
  PATH_EMPTY: 'PATCH_PATH_EMPTY',
  PATH_ABSOLUTE: 'PATCH_PATH_ABSOLUTE',
  PATH_TRAVERSAL: 'PATCH_PATH_TRAVERSAL',
  UNKNOWN_MODE: 'PATCH_UNKNOWN_MODE',
  OLD_STRING_MISSING: 'PATCH_OLD_STRING_MISSING',
  NEW_STRING_MISSING: 'PATCH_NEW_STRING_MISSING',
  DIFF_MISSING: 'PATCH_DIFF_MISSING',
  CONTEXT_INVALID: 'PATCH_CONTEXT_INVALID',
  OCCURRENCE_INVALID: 'PATCH_OCCURRENCE_INVALID',
  FUZZY_OUT_OF_RANGE: 'PATCH_FUZZY_OUT_OF_RANGE',
  FUZZY_INVALID: 'PATCH_FUZZY_INVALID',
} as const;

export type PatchErrorCode = (typeof PatchErrorCode)[keyof typeof PatchErrorCode];

export interface PatchValidationError {
  operationIndex: number | null;
  code: PatchErrorCode;
  message: string;
}

export interface PatchRejection {
  errors: PatchValidationError[];
}

export type PatchValidationResult = { ok: true } | { ok: false; rejection: PatchRejection };
