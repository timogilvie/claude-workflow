import {
  coerceUnverifiedCompletionClaim,
  hasVerificationEvidence,
  validateBlockedCompletion,
  type BlockedCompletion,
  type BlockedCompletionValidationError,
} from '../blocked-completion.ts';
import {
  isCodingCompleteConfidence,
  parseCodingComplete,
  serializeCodingComplete,
  type CodingArtifactsValidationError,
  type CodingComplete,
} from './coding-artifacts.ts';

export type CompletionArtifact = 'coding-complete' | 'blocked-completion';

export interface RetryGuidanceError {
  code: string;
  message: string;
  path?: string;
  field?: string;
}

type LenientSourceFormat = 'json' | 'fenced-json' | 'yaml';

export type ParseLenientObjectResult =
  | { ok: true; value: Record<string, unknown>; sourceFormat: LenientSourceFormat }
  | { ok: false };

export type NormalizeCodingCompleteResult =
  | {
    ok: true;
    value: CodingComplete;
    canonicalContent: string;
    warnings: string[];
    changed: boolean;
  }
  | { ok: false; errors: CodingArtifactsValidationError[] };

export type NormalizeBlockedCompletionResult =
  | {
    ok: true;
    value: BlockedCompletion;
    canonicalContent: string;
    warnings: string[];
    changed: boolean;
    coercedUnverifiedClaim: boolean;
  }
  | { ok: false; errors: BlockedCompletionValidationError[] };

export function parseLenientObject(raw: string): ParseLenientObjectResult {
  const json = parseJsonObject(raw);
  if (json.ok) return { ...json, sourceFormat: 'json' };

  const fenced = stripMarkdownJsonFence(raw);
  if (fenced !== null) {
    const fencedJson = parseJsonObject(fenced);
    if (fencedJson.ok) return { ...fencedJson, sourceFormat: 'fenced-json' };
  }

  const yaml = parseFlatYamlObject(raw);
  if (yaml.ok) return { ...yaml, sourceFormat: 'yaml' };

  return { ok: false };
}

export function normalizeCodingCompleteContent(raw: string): NormalizeCodingCompleteResult {
  const parsed = parseCodingComplete(raw);
  if (parsed.ok) {
    return {
      ok: true,
      value: parsed.value,
      canonicalContent: raw,
      warnings: [],
      changed: false,
    };
  }

  const lenient = parseLenientObject(raw);
  if (!lenient.ok) {
    return { ok: false, errors: parsed.errors };
  }

  const confidence = lenient.value.confidence;
  if (typeof confidence !== 'string' || confidence.length === 0) {
    return { ok: false, errors: [missingConfidenceError()] };
  }
  if (!isCodingCompleteConfidence(confidence)) {
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
  for (const [key, value] of Object.entries(lenient.value)) {
    if (key === 'confidence' || value === undefined || value === null) continue;
    fields[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }

  const value: CodingComplete = {
    confidence,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
  return {
    ok: true,
    value,
    canonicalContent: serializeCodingComplete(value),
    warnings: [`normalized ${lenient.sourceFormat} payload to key=value .coding-complete contract`],
    changed: true,
  };
}

export function normalizeBlockedCompletionContent(raw: string): NormalizeBlockedCompletionResult {
  const strict = parseStrictBlockedCompletion(raw);
  if (strict.ok) {
    const coerced = coerceUnverifiedCompletionClaim(strict.value);
    return {
      ok: true,
      value: coerced.value,
      canonicalContent: JSON.stringify(coerced.value, null, 2) + '\n',
      warnings: coerced.coerced ? ['implementationComplete coerced to false: no verification evidence'] : [],
      changed: coerced.coerced,
      coercedUnverifiedClaim: coerced.coerced,
    };
  }

  if (strict.error.code !== 'MALFORMED_JSON') {
    return { ok: false, errors: [strict.error] };
  }

  const lenient = parseLenientObject(raw);
  if (!lenient.ok) {
    return { ok: false, errors: [strict.error] };
  }

  const validation = validateBlockedCompletion(lenient.value);
  if (!validation.ok) {
    return { ok: false, errors: [validation] };
  }

  const coerced = coerceUnverifiedCompletionClaim(validation.value);
  return {
    ok: true,
    value: coerced.value,
    canonicalContent: JSON.stringify(coerced.value, null, 2) + '\n',
    warnings: [
      `normalized ${lenient.sourceFormat} payload to canonical .coding-blocked-completion.json`,
      ...(coerced.coerced ? ['implementationComplete coerced to false: no verification evidence'] : []),
    ],
    changed: true,
    coercedUnverifiedClaim: coerced.coerced,
  };
}

export function buildCompletionArtifactRetryGuidance(
  artifact: CompletionArtifact,
  errors: readonly RetryGuidanceError[],
): string {
  const formattedErrors = errors.map((error) => {
    const location = error.path ?? error.field;
    return `- ${error.code}${location ? ` at ${location}` : ''}: ${error.message}`;
  }).join('\n');

  if (artifact === 'coding-complete') {
    return [
      'Rewrite the completion marker using plain key=value lines.',
      formattedErrors,
      'Required contract:',
      'confidence=high',
      'Allowed confidence values: high, medium, low.',
    ].join('\n');
  }

  return [
    'Rewrite .coding-blocked-completion.json as valid JSON matching this contract.',
    formattedErrors,
    'If no verification ran or passingChecks is empty, set implementationComplete to false.',
    'Example:',
    JSON.stringify({
      stage: 'coding',
      implementationComplete: true,
      committed: true,
      commit: 'abc1234',
      passingChecks: ['node --test shared/lib/example.test.ts'],
      blockingChecks: ['npm test'],
      blockingReason: 'baseline_tests_failing',
      evidence: 'Scoped checks passed; repo-level failures are unrelated.',
      recommendedAction: 'advance_to_review',
    }, null, 2),
  ].join('\n');
}

export function noVerificationEvidenceError(): BlockedCompletionValidationError {
  return {
    ok: false,
    code: 'INVALID_FIELD_TYPE',
    field: 'passingChecks',
    message: 'Blocked completion cannot claim implementationComplete=true with no passingChecks evidence.',
  };
}

export function hasBlockedCompletionVerificationEvidence(value: BlockedCompletion): boolean {
  return hasVerificationEvidence(value);
}

function parseStrictBlockedCompletion(raw: string):
  | { ok: true; value: BlockedCompletion }
  | { ok: false; error: BlockedCompletionValidationError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: {
        ok: false,
        code: 'MALFORMED_JSON',
        message: 'Blocked completion artifact contains malformed JSON.',
      },
    };
  }

  const validation = validateBlockedCompletion(parsed);
  return validation.ok ? validation : { ok: false, error: validation };
}

function parseJsonObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      return { ok: true, value: parsed };
    }
  } catch {
    // Fall through.
  }
  return { ok: false };
}

function stripMarkdownJsonFence(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match ? match[1] ?? '' : null;
}

function parseFlatYamlObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const result: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  let sawField = false;

  for (const rawLine of lines) {
    const withoutComment = stripYamlComment(rawLine);
    if (withoutComment.trim() === '') continue;

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();
    if (trimmed === '---' || trimmed === '...') return { ok: false };

    if (trimmed.startsWith('- ')) {
      if (currentArrayKey === null || indent === 0) return { ok: false };
      const current = result[currentArrayKey];
      if (!Array.isArray(current)) return { ok: false };
      current.push(parseYamlScalar(trimmed.slice(2).trim()));
      continue;
    }

    if (indent !== 0) return { ok: false };
    currentArrayKey = null;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) return { ok: false };
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false };
    if (rawValue === '') {
      result[key] = [];
      currentArrayKey = key;
    } else {
      result[key] = parseYamlScalar(rawValue);
    }
    sawField = true;
  }

  return sawField ? { ok: true, value: result } : { ok: false };
}

function parseYamlScalar(raw: string): unknown {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlowSequence(inner).map((item) => parseYamlScalar(item.trim()));
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function splitFlowSequence(raw: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of raw) {
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    }
    if (char === ',' && quote === null) {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items;
}

function stripYamlComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === '"' || char === "'") && quote === null) quote = char;
    else if (char === quote) quote = null;
    else if (char === '#' && quote === null) return raw.slice(0, index);
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingConfidenceError(): CodingArtifactsValidationError {
  return {
    code: 'missing_confidence',
    path: '$.confidence',
    message: 'Coding completion marker must include confidence=<high|medium|low>.',
  };
}
