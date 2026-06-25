import { normalizePatchPath } from './patch-contract.ts';

export type CodingCompleteConfidence = 'high' | 'medium' | 'low';

export interface CodingComplete {
  confidence: CodingCompleteConfidence;
  fields?: Record<string, string>;
}

export interface CodingArtifacts {
  type: 'coding';
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commitCount: number;
  [futureField: string]: unknown;
}

const CODING_ARTIFACT_METRIC_FIELDS = [
  'filesChanged',
  'linesAdded',
  'linesRemoved',
  'commitCount',
] as const;

type CodingArtifactMetricField = (typeof CODING_ARTIFACT_METRIC_FIELDS)[number];

/**
 * Whole-file write allowlist inputs are kept separate from mutation policy so
 * later enforcement can distinguish generated output from Wavemill-owned files.
 */
export interface WholeFileWriteAllowlistInput {
  generatedPaths?: string[];
  wavemillOwnedPaths?: string[];
}

export interface NormalizedWholeFileWriteAllowlistInput {
  generatedPaths: string[];
  wavemillOwnedPaths: string[];
}

export interface CodingArtifactsValidationError {
  code:
    | 'invalid_type'
    | 'missing_field'
    | 'negative_value'
    | 'non_integer_value'
    | 'invalid_confidence'
    | 'missing_confidence'
    | 'invalid_allowlist';
  path: string;
  message: string;
}

export type ValidateCodingArtifactsResult =
  | { ok: true; value: CodingArtifacts }
  | { ok: false; errors: CodingArtifactsValidationError[] };

export type ParseCodingCompleteResult =
  | { ok: true; value: CodingComplete }
  | { ok: false; errors: CodingArtifactsValidationError[] };

export type ValidateWholeFileWriteAllowlistResult =
  | { ok: true; value: NormalizedWholeFileWriteAllowlistInput }
  | { ok: false; errors: CodingArtifactsValidationError[] };

export type CompletionGateViolationCode =
  | 'dirty_tree_uncommitted'
  | 'checks_not_satisfied';

export interface CompletionGatePolicy {
  requireCleanOrCommitted?: boolean;
  requireChecksPassed?: boolean;
}

export interface CompletionGateInput {
  dirtyEntries: readonly string[];
  allChangesCommitted: boolean;
  requiredChecksPassed: boolean;
  policy?: CompletionGatePolicy;
}

export type CompletionGateDecision =
  | { allowed: true }
  | { allowed: false; code: CompletionGateViolationCode; detail: string };

export interface AcceptCodingCompletionInput {
  marker: string;
  artifacts: unknown;
  gate?: CompletionGateInput;
}

export type CodingCompletionAcceptance =
  | { status: 'accepted'; complete: CodingComplete; artifacts: CodingArtifacts }
  | {
      status: 'blocked';
      code: CompletionGateViolationCode;
      detail: string;
    }
  | {
      status: 'invalid';
      errors: CodingArtifactsValidationError[];
    };

const CODING_COMPLETE_CONFIDENCE_VALUES: readonly CodingCompleteConfidence[] = ['high', 'medium', 'low'] as const;

export function isCodingCompleteConfidence(value: string): value is CodingCompleteConfidence {
  return (CODING_COMPLETE_CONFIDENCE_VALUES as readonly string[]).includes(value);
}

export function parseCodingComplete(input: string): ParseCodingCompleteResult {
  const errors: CodingArtifactsValidationError[] = [];
  const fields: Record<string, string> = {};

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0) {
      continue;
    }

    fields[key] = value;
  }

  const rawConfidence = fields.confidence;
  if (!rawConfidence) {
    errors.push({
      code: 'missing_confidence',
      path: '$.confidence',
      message: 'Coding completion marker must include confidence=<high|medium|low>.',
    });
    return { ok: false, errors };
  }
  if (!isCodingCompleteConfidence(rawConfidence)) {
    errors.push({
      code: 'invalid_confidence',
      path: '$.confidence',
      message: 'Coding completion confidence must be high, medium, or low.',
    });
    return { ok: false, errors };
  }

  delete fields.confidence;

  return {
    ok: true,
    value: {
      confidence: rawConfidence,
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
    },
  };
}

export function serializeCodingComplete(input: CodingComplete): string {
  const lines = [`confidence=${input.confidence}`];
  const fields = input.fields ?? {};
  for (const key of Object.keys(fields).sort()) {
    lines.push(`${key}=${fields[key]}`);
  }
  return `${lines.join('\n')}\n`;
}

export function validateCodingArtifacts(input: unknown): ValidateCodingArtifactsResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ code: 'invalid_type', path: '$', message: 'CodingArtifacts must be an object.' }],
    };
  }

  const errors: CodingArtifactsValidationError[] = [];
  if (input.type !== 'coding') {
    errors.push({
      code: 'invalid_type',
      path: '$.type',
      message: 'CodingArtifacts.type must be "coding".',
    });
  }

  for (const field of CODING_ARTIFACT_METRIC_FIELDS) {
    validateMetric(field, input[field], errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as CodingArtifacts };
}

export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateDecision {
  const requireCleanOrCommitted = input.policy?.requireCleanOrCommitted ?? false;
  const requireChecksPassed = input.policy?.requireChecksPassed ?? false;

  if (requireCleanOrCommitted) {
    const hasDirtyEntries = input.dirtyEntries.length > 0;
    if (hasDirtyEntries && !input.allChangesCommitted) {
      const detail = `dirty_tree_uncommitted: ${input.dirtyEntries.join(', ')}`;
      return { allowed: false, code: 'dirty_tree_uncommitted', detail };
    }
  }

  if (requireChecksPassed && !input.requiredChecksPassed) {
    return {
      allowed: false,
      code: 'checks_not_satisfied',
      detail: 'checks_not_satisfied: required checks have not been recorded as passed',
    };
  }

  return { allowed: true };
}

export function acceptCodingCompletion(input: AcceptCodingCompletionInput): CodingCompletionAcceptance {
  const errors: CodingArtifactsValidationError[] = [];

  const completeResult = parseCodingComplete(input.marker);
  if (!completeResult.ok) {
    errors.push(...completeResult.errors);
  }

  const artifactsResult = validateCodingArtifacts(input.artifacts);
  if (!artifactsResult.ok) {
    errors.push(...artifactsResult.errors);
  }

  if (!completeResult.ok || !artifactsResult.ok) {
    return { status: 'invalid', errors };
  }

  if (input.gate) {
    const decision = evaluateCompletionGate(input.gate);
    if (!decision.allowed) {
      return { status: 'blocked', code: decision.code, detail: decision.detail };
    }
  }

  return {
    status: 'accepted',
    complete: completeResult.value,
    artifacts: artifactsResult.value,
  };
}

export function validateWholeFileWriteAllowlistInput(
  input: unknown,
): ValidateWholeFileWriteAllowlistResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ code: 'invalid_allowlist', path: '$', message: 'Whole-file allowlist input must be an object.' }],
    };
  }

  const errors: CodingArtifactsValidationError[] = [];
  const generatedPaths = validateAllowlistPaths(input.generatedPaths, '$.generatedPaths', errors);
  const wavemillOwnedPaths = validateAllowlistPaths(input.wavemillOwnedPaths, '$.wavemillOwnedPaths', errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      generatedPaths,
      wavemillOwnedPaths,
    },
  };
}

function validateMetric(
  field: CodingArtifactMetricField,
  input: unknown,
  errors: CodingArtifactsValidationError[],
): void {
  const path = `$.${field}`;
  if (input === undefined) {
    errors.push({
      code: 'missing_field',
      path,
      message: `${path} is required.`,
    });
    return;
  }

  if (typeof input !== 'number' || !Number.isInteger(input)) {
    errors.push({
      code: 'non_integer_value',
      path,
      message: `${path} must be a finite integer.`,
    });
    return;
  }

  if (input < 0) {
    errors.push({
      code: 'negative_value',
      path,
      message: `${path} must be non-negative.`,
    });
  }
}

function validateAllowlistPaths(
  input: unknown,
  pathKey: string,
  errors: CodingArtifactsValidationError[],
): string[] {
  if (input === undefined) {
    return [];
  }

  if (!Array.isArray(input)) {
    errors.push({
      code: 'invalid_allowlist',
      path: pathKey,
      message: `${pathKey} must be an array of repo-relative POSIX paths when provided.`,
    });
    return [];
  }

  const normalizedPaths: string[] = [];
  for (const [index, value] of input.entries()) {
    if (typeof value !== 'string') {
      errors.push({
        code: 'invalid_allowlist',
        path: `${pathKey}[${index}]`,
        message: `${pathKey}[${index}] must be a string.`,
      });
      continue;
    }

    const normalized = normalizePatchPath(value);
    if (!normalized) {
      errors.push({
        code: 'invalid_allowlist',
        path: `${pathKey}[${index}]`,
        message: `${pathKey}[${index}] must be a repo-relative POSIX path without traversal.`,
      });
      continue;
    }

    normalizedPaths.push(normalized);
  }

  return normalizedPaths;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
