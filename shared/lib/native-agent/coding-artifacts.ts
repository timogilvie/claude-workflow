/**
 * Validation schema for coding completion markers and `.coding-result.json`
 * artifact summaries used by native-agent tooling.
 *
 * @module coding-artifacts
 */

export const CODING_ARTIFACTS_VERSION = '1';

export const CodingCompleteConfidence = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const;

export type CodingCompleteConfidence =
  (typeof CodingCompleteConfidence)[keyof typeof CodingCompleteConfidence];

export interface CodingArtifacts {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commitCount: number;
}

export interface CodingResult {
  version: string;
  confidence: CodingCompleteConfidence;
  artifacts: CodingArtifacts;
}

export const CodingArtifactsErrorCode = {
  NEGATIVE: 'ARTIFACTS_NEGATIVE',
  NON_INTEGER: 'ARTIFACTS_NON_INTEGER',
  UNKNOWN_CONFIDENCE: 'ARTIFACTS_UNKNOWN_CONFIDENCE',
  UNKNOWN_VERSION: 'ARTIFACTS_UNKNOWN_VERSION',
  FIELD_MISSING: 'ARTIFACTS_FIELD_MISSING',
} as const;

export type CodingArtifactsErrorCode =
  (typeof CodingArtifactsErrorCode)[keyof typeof CodingArtifactsErrorCode];

export interface CodingArtifactsValidationError {
  field: string | null;
  code: CodingArtifactsErrorCode;
  message: string;
}

export interface CodingArtifactsRejection {
  errors: CodingArtifactsValidationError[];
}

export type CodingArtifactsValidationResult =
  | { ok: true }
  | { ok: false; rejection: CodingArtifactsRejection };

const CODING_ARTIFACT_FIELDS = [
  'filesChanged',
  'linesAdded',
  'linesRemoved',
  'commitCount',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pushError(
  errors: CodingArtifactsValidationError[],
  field: string | null,
  code: CodingArtifactsValidationError['code'],
  message: string,
): void {
  errors.push({ field, code, message });
}

function validateArtifactsObject(
  input: unknown,
  fieldPrefix: string,
  errors: CodingArtifactsValidationError[],
): void {
  const record = isRecord(input) ? input : null;

  for (const field of CODING_ARTIFACT_FIELDS) {
    const fullField = fieldPrefix ? `${fieldPrefix}.${field}` : field;
    const value = record?.[field];
    if (value === undefined) {
      pushError(
        errors,
        fullField,
        CodingArtifactsErrorCode.FIELD_MISSING,
        `${fullField} is required`,
      );
      continue;
    }
    if (!Number.isInteger(value)) {
      pushError(
        errors,
        fullField,
        CodingArtifactsErrorCode.NON_INTEGER,
        `${fullField} must be an integer`,
      );
      continue;
    }
    if ((value as number) < 0) {
      pushError(
        errors,
        fullField,
        CodingArtifactsErrorCode.NEGATIVE,
        `${fullField} must be greater than or equal to 0`,
      );
    }
  }
}

export function validateCodingArtifacts(input: unknown): CodingArtifactsValidationResult {
  const errors: CodingArtifactsValidationError[] = [];
  validateArtifactsObject(input, '', errors);
  return errors.length === 0 ? { ok: true } : { ok: false, rejection: { errors } };
}

export function validateCodingResult(input: unknown): CodingArtifactsValidationResult {
  const errors: CodingArtifactsValidationError[] = [];
  const record = isRecord(input) ? input : {};

  if (record.version !== CODING_ARTIFACTS_VERSION) {
    pushError(
      errors,
      'version',
      CodingArtifactsErrorCode.UNKNOWN_VERSION,
      `version must be "${CODING_ARTIFACTS_VERSION}"`,
    );
  }

  const confidence = record.confidence;
  if (confidence === undefined) {
    pushError(
      errors,
      'confidence',
      CodingArtifactsErrorCode.FIELD_MISSING,
      'confidence is required',
    );
  } else if (!Object.values(CodingCompleteConfidence).includes(confidence as CodingCompleteConfidence)) {
    pushError(
      errors,
      'confidence',
      CodingArtifactsErrorCode.UNKNOWN_CONFIDENCE,
      `confidence must be one of ${Object.values(CodingCompleteConfidence).join(', ')}`,
    );
  }

  if (record.artifacts === undefined) {
    pushError(
      errors,
      'artifacts',
      CodingArtifactsErrorCode.FIELD_MISSING,
      'artifacts is required',
    );
  } else {
    validateArtifactsObject(record.artifacts, 'artifacts', errors);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, rejection: { errors } };
}
