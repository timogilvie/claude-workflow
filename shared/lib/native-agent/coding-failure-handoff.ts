import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const CODING_FAILURE_HANDOFF_SCHEMA_VERSION = '1.0';
export const CODING_FAILURE_HANDOFF_FILENAME = '.coding-failure-handoff.json';
export const CODING_FAILURE_HANDOFF_STAGE = 'coding';
export const CODING_FAILURE_HANDOFF_REASON = 'no_completion_artifact';

export interface CodingFailureToolError {
  tool: string;
  error: string;
  message: string;
  retryHint?: string;
  diagnostics?: unknown;
}

export interface CodingFailureHandoff {
  stage: typeof CODING_FAILURE_HANDOFF_STAGE;
  reason: typeof CODING_FAILURE_HANDOFF_REASON;
  stopReason: string;
  mutationFailures: number;
  lastToolError: CodingFailureToolError | null;
  recoveryAttempted: boolean;
  suggestedAction: string;
  createdAt: string;
  schemaVersion: typeof CODING_FAILURE_HANDOFF_SCHEMA_VERSION;
}

export type CodingFailureHandoffValidationResult =
  | { ok: true; value: CodingFailureHandoff }
  | { ok: false; code: 'MALFORMED_JSON' | 'MISSING_REQUIRED_FIELD' | 'INVALID_FIELD_TYPE' | 'INVALID_ENUM_VALUE'; field?: string; message: string };

const REQUIRED_FIELDS = [
  'stage',
  'reason',
  'stopReason',
  'mutationFailures',
  'lastToolError',
  'recoveryAttempted',
  'suggestedAction',
  'createdAt',
  'schemaVersion',
] as const;

export function getCodingFailureHandoffPath(featureDir: string): string {
  return path.join(featureDir, CODING_FAILURE_HANDOFF_FILENAME);
}

export function writeCodingFailureHandoff(
  featureDir: string,
  handoff: CodingFailureHandoff,
): void {
  const filePath = getCodingFailureHandoffPath(featureDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

export function validateCodingFailureHandoff(
  value: unknown,
): CodingFailureHandoffValidationResult {
  if (!isRecord(value)) {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff must be a JSON object.', 'artifact');
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === undefined) {
      return error('MISSING_REQUIRED_FIELD', `Coding failure handoff is missing required field "${field}".`, field);
    }
  }

  if (value.stage !== CODING_FAILURE_HANDOFF_STAGE) {
    return error('INVALID_ENUM_VALUE', `Coding failure handoff stage must be "${CODING_FAILURE_HANDOFF_STAGE}".`, 'stage');
  }
  if (value.reason !== CODING_FAILURE_HANDOFF_REASON) {
    return error('INVALID_ENUM_VALUE', `Coding failure handoff reason must be "${CODING_FAILURE_HANDOFF_REASON}".`, 'reason');
  }
  if (value.schemaVersion !== CODING_FAILURE_HANDOFF_SCHEMA_VERSION) {
    return error('INVALID_ENUM_VALUE', `Coding failure handoff schemaVersion must be "${CODING_FAILURE_HANDOFF_SCHEMA_VERSION}".`, 'schemaVersion');
  }
  if (typeof value.stopReason !== 'string') {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff stopReason must be a string.', 'stopReason');
  }
  if (typeof value.mutationFailures !== 'number' || !Number.isInteger(value.mutationFailures) || value.mutationFailures < 0) {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff mutationFailures must be a non-negative integer.', 'mutationFailures');
  }
  if (typeof value.recoveryAttempted !== 'boolean') {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff recoveryAttempted must be a boolean.', 'recoveryAttempted');
  }
  if (typeof value.suggestedAction !== 'string') {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff suggestedAction must be a string.', 'suggestedAction');
  }
  if (typeof value.createdAt !== 'string') {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff createdAt must be a string.', 'createdAt');
  }
  if (value.lastToolError !== null) {
    const toolError = validateToolError(value.lastToolError);
    if (!toolError.ok) {
      return toolError;
    }
  }

  return { ok: true, value: value as CodingFailureHandoff };
}

export async function readCodingFailureHandoff(
  filePath: string,
): Promise<CodingFailureHandoffValidationResult> {
  const content = await readFile(filePath, 'utf-8');
  try {
    return validateCodingFailureHandoff(JSON.parse(content));
  } catch {
    return error('MALFORMED_JSON', `Coding failure handoff at ${filePath} contains malformed JSON.`);
  }
}

function validateToolError(value: unknown): CodingFailureHandoffValidationResult {
  if (!isRecord(value)) {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff lastToolError must be null or an object.', 'lastToolError');
  }
  for (const field of ['tool', 'error', 'message'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      return error('INVALID_FIELD_TYPE', `Coding failure handoff lastToolError.${field} must be a non-empty string.`, `lastToolError.${field}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'retryHint') && value.retryHint !== undefined && typeof value.retryHint !== 'string') {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff lastToolError.retryHint must be a string when present.', 'lastToolError.retryHint');
  }
  return { ok: true, value: undefined as unknown as CodingFailureHandoff };
}

function error(
  code: Exclude<CodingFailureHandoffValidationResult, { ok: true }>['code'],
  message: string,
  field?: string,
): Exclude<CodingFailureHandoffValidationResult, { ok: true }> {
  return field === undefined ? { ok: false, code, message } : { ok: false, code, message, field };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
