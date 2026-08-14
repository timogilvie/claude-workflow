import {
  type BlockedCompletion,
  type BlockedCompletionValidationError,
  type BlockedCompletionValidationErrorCode,
  validateBlockedCompletion,
} from '../blocked-completion.ts';
import {
  type CodingArtifactsValidationError,
  type CodingComplete,
  isCodingCompleteConfidence,
  parseCodingComplete,
  serializeCodingComplete,
} from './coding-artifacts.ts';

export type StructuredArtifactFormat = 'json' | 'yaml';

export type NormalizeBlockedResult =
  | {
    ok: true;
    value: BlockedCompletion;
    canonicalJson: string;
    normalizedFrom?: 'yaml';
  }
  | {
    ok: false;
    code: BlockedCompletionValidationErrorCode;
    field?: string;
    message: string;
  };

export type NormalizeCodingCompleteResult =
  | {
    ok: true;
    value: CodingComplete;
    canonicalText: string;
    normalizedFrom?: StructuredArtifactFormat;
    droppedFields?: string[];
  }
  | {
    ok: false;
    errors: CodingArtifactsValidationError[];
  };

export interface VerificationEvidence {
  verificationCommandsSucceeded: number;
}

export interface VerificationEvidenceGuardResult {
  value: BlockedCompletion;
  coerced: boolean;
  reason?: 'empty_passing_checks' | 'no_successful_verification_commands';
}

export function parseStructuredArtifactLenient(
  content: string,
): { value: unknown; format: StructuredArtifactFormat } | null {
  try {
    return { value: JSON.parse(content), format: 'json' };
  } catch {
    const yaml = parseFlatYamlLike(content);
    return yaml === null ? null : { value: yaml, format: 'yaml' };
  }
}

export function normalizeBlockedCompletion(content: string): NormalizeBlockedResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
    const validation = validateBlockedCompletion(parsed);
    if (!validation.ok) {
      return fromBlockedValidationError(validation);
    }
    return {
      ok: true,
      value: validation.value,
      canonicalJson: `${JSON.stringify(validation.value, null, 2)}\n`,
    };
  } catch {
    const yaml = parseFlatYamlLike(content);
    if (yaml === null) {
      return {
        ok: false,
        code: 'MALFORMED_JSON',
        message: 'Blocked completion artifact must be valid JSON or a flat YAML object.',
      };
    }
    const validation = validateBlockedCompletion(yaml);
    if (!validation.ok) {
      return fromBlockedValidationError(validation);
    }
    return {
      ok: true,
      value: validation.value,
      canonicalJson: `${JSON.stringify(validation.value, null, 2)}\n`,
      normalizedFrom: 'yaml',
    };
  }
}

export function normalizeCodingComplete(content: string): NormalizeCodingCompleteResult {
  const strict = parseCodingComplete(content);
  if (strict.ok) {
    return {
      ok: true,
      value: strict.value,
      canonicalText: serializeCodingComplete(strict.value),
    };
  }

  const structured = parseStructuredArtifactLenient(content);
  if (!structured || !isPlainObject(structured.value)) {
    return { ok: false, errors: strict.errors };
  }

  const rawConfidence = structured.value.confidence;
  if (typeof rawConfidence !== 'string' || rawConfidence.trim() === '') {
    return {
      ok: false,
      errors: [{
        code: 'missing_confidence',
        path: '$.confidence',
        message: 'Coding completion marker must include confidence=<high|medium|low>.',
      }],
    };
  }
  if (!isCodingCompleteConfidence(rawConfidence)) {
    return {
      ok: false,
      errors: [{
        code: 'invalid_confidence',
        path: '$.confidence',
        message: 'Coding completion confidence must be high, medium, or low.',
      }],
    };
  }

  const fields: Record<string, string> = {};
  const droppedFields: string[] = [];
  for (const [key, value] of Object.entries(structured.value)) {
    if (key === 'confidence') {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      fields[key] = String(value);
    } else {
      droppedFields.push(key);
    }
  }

  const value: CodingComplete = {
    confidence: rawConfidence,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
  return {
    ok: true,
    value,
    canonicalText: serializeCodingComplete(value),
    normalizedFrom: structured.format,
    ...(droppedFields.length > 0 ? { droppedFields } : {}),
  };
}

export function applyVerificationEvidenceGuard(
  value: BlockedCompletion,
  evidence: VerificationEvidence,
): VerificationEvidenceGuardResult {
  if (!value.implementationComplete) {
    return { value, coerced: false };
  }

  const reason = value.passingChecks.length === 0
    ? 'empty_passing_checks'
    : evidence.verificationCommandsSucceeded === 0
      ? 'no_successful_verification_commands'
      : undefined;
  if (!reason) {
    return { value, coerced: false };
  }

  const note = reason === 'empty_passing_checks'
    ? 'implementationComplete downgraded because passingChecks was empty.'
    : 'implementationComplete downgraded because no verification command succeeded in the native session.';
  const existingEvidence = value.evidence.trim();
  return {
    value: {
      ...value,
      implementationComplete: false,
      evidence: existingEvidence ? `${existingEvidence}\n${note}` : note,
    },
    coerced: true,
    reason,
  };
}

export function parseFlatYamlLike(content: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let pendingSequenceKey: string | null = null;

  for (const rawLine of lines) {
    const withoutComments = stripYamlComment(rawLine);
    if (withoutComments.trim() === '' || withoutComments.trim() === '---') {
      continue;
    }

    const indent = withoutComments.match(/^\s*/)?.[0].length ?? 0;
    const line = withoutComments.trim();

    if (line.startsWith('- ')) {
      if (pendingSequenceKey === null || indent === 0) {
        return null;
      }
      const parsed = parseYamlScalar(line.slice(2).trim());
      if (parsed === undefined || Array.isArray(parsed) || isPlainObject(parsed)) {
        return null;
      }
      (result[pendingSequenceKey] as unknown[]).push(parsed);
      continue;
    }

    if (indent > 0) {
      return null;
    }
    pendingSequenceKey = null;

    const separator = line.indexOf(':');
    if (separator <= 0) {
      return null;
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) || Object.prototype.hasOwnProperty.call(result, key)) {
      return null;
    }

    if (rawValue === '') {
      result[key] = [];
      pendingSequenceKey = key;
      continue;
    }

    const parsed = parseYamlScalar(rawValue);
    if (parsed === undefined) {
      return null;
    }
    result[key] = parsed;
  }

  return Object.keys(result).length === 0 ? null : result;
}

function fromBlockedValidationError(
  error: BlockedCompletionValidationError,
): Extract<NormalizeBlockedResult, { ok: false }> {
  return {
    ok: false,
    code: error.code,
    ...(error.field !== undefined ? { field: error.field } : {}),
    message: error.message,
  };
}

function parseYamlScalar(input: string): unknown {
  if (input === 'true') return true;
  if (input === 'false') return false;
  if (/^-?\d+$/.test(input)) return Number(input);
  if (input.startsWith('[') && input.endsWith(']')) {
    return parseYamlFlowArray(input.slice(1, -1));
  }
  if (
    (input.startsWith('"') && input.endsWith('"'))
    || (input.startsWith("'") && input.endsWith("'"))
  ) {
    return unquoteYamlString(input);
  }
  if (/^[^\[\]{}:]+$/.test(input)) {
    return input.trim();
  }
  return undefined;
}

function parseYamlFlowArray(input: string): unknown[] | undefined {
  if (input.trim() === '') {
    return [];
  }
  const items: unknown[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      current += char;
      if (char === quote && input[index - 1] !== '\\') {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      const parsed = parseYamlScalar(current.trim());
      if (parsed === undefined || Array.isArray(parsed) || isPlainObject(parsed)) {
        return undefined;
      }
      items.push(parsed);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote) {
    return undefined;
  }
  const parsed = parseYamlScalar(current.trim());
  if (parsed === undefined || Array.isArray(parsed) || isPlainObject(parsed)) {
    return undefined;
  }
  items.push(parsed);
  return items;
}

function unquoteYamlString(input: string): string | undefined {
  const quote = input[0];
  const body = input.slice(1, -1);
  if (quote === "'") {
    return body.replace(/''/g, "'");
  }
  try {
    return JSON.parse(input) as string;
  } catch {
    return undefined;
  }
}

function stripYamlComment(input: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      if (char === quote && input[index - 1] !== '\\') {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') {
      return input.slice(0, index);
    }
  }
  return input;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
