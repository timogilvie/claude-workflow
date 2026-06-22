/**
 * Secret-pattern redaction for native-agent tool outputs and provider payloads.
 *
 * Provides two public surfaces:
 * - `redactString` — replace secret-looking substrings in a text value.
 * - `redactPayload` — recursively redact a structured payload (combines
 *   pattern-based string redaction with key-name-based value replacement).
 *
 * Pattern coverage:
 * - Bearer auth tokens
 * - AWS access key IDs (AKIA… / ASIA…)
 * - sk-… style API tokens (OpenAI, Anthropic)
 * - Inline assignment forms: `apiKey=<value>`, `token: <value>`, etc.
 *
 * Key-name coverage (redacts value regardless of content):
 * - authorization, apikey, api_key, token, secret, password, passwd,
 *   key, bearer, credential, credentials, x-api-key
 */

// ---------------------------------------------------------------------------
// Placeholder
// ---------------------------------------------------------------------------

export const REDACTION_PLACEHOLDER = '[REDACTED]';

// ---------------------------------------------------------------------------
// Pattern compilation
// ---------------------------------------------------------------------------

// Patterns are compiled once as global-flagged RegExps.
// String.match() and String.replace() with global regexes reset lastIndex
// after each call, so module-level singletons are safe to reuse.

const BEARER_TOKEN_PATTERN = new RegExp('Bearer\\s+[A-Za-z0-9+/=_\\-.]{8,}', 'g');
const AWS_ACCESS_KEY_PATTERN = new RegExp('(?:AKIA|ASIA)[A-Z0-9]{16}', 'g');
const SK_TOKEN_PATTERN = new RegExp('sk-[A-Za-z0-9_\\-]{20,}', 'g');
// Assignment forms: `apiKey=value`, `token: "value"`, `x-api-key: abc123`, etc.
// Matches the whole key=value pair so the replacement removes both.
const ASSIGNMENT_FORM_PATTERN = new RegExp(
  '\\b(?:api[_-]?key|apikey|token|secret|password|passwd|authorization|x-api-key)\\s*[:=]\\s*[\'"]?[A-Za-z0-9_\\-.+/]{8,}[\'"]?',
  'gi',
);

/** Default compiled pattern set used by redactString and redactPayload. */
export const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  BEARER_TOKEN_PATTERN,
  AWS_ACCESS_KEY_PATTERN,
  SK_TOKEN_PATTERN,
  ASSIGNMENT_FORM_PATTERN,
];

// ---------------------------------------------------------------------------
// Secret key names (key-based value replacement in redactPayload)
// ---------------------------------------------------------------------------

const SECRET_KEY_SET = new Set([
  'authorization',
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'passwd',
  'key',
  'bearer',
  'credential',
  'credentials',
  'x-api-key',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RedactionOptions {
  /** Pattern set to use; defaults to DEFAULT_SECRET_PATTERNS. */
  patterns?: readonly RegExp[];
}

export interface RedactionResult {
  /** Redacted text (may equal the input if no patterns matched). */
  text: string;
  /** Total number of pattern match instances replaced. */
  matchCount: number;
  /** True if at least one replacement was made. */
  applied: boolean;
}

// ---------------------------------------------------------------------------
// redactString
// ---------------------------------------------------------------------------

/**
 * Replace secret-pattern matches in `input` with REDACTION_PLACEHOLDER.
 *
 * Returns the (possibly unchanged) text plus redaction metadata.
 * Does not mutate `input`.
 */
export function redactString(input: string, options?: RedactionOptions): RedactionResult {
  const patterns = options?.patterns ?? DEFAULT_SECRET_PATTERNS;
  let text = input;
  let matchCount = 0;

  for (const pattern of patterns) {
    // Ensure the pattern is used with the global flag for full-string scanning.
    // Using String.match() on a global regex resets lastIndex after completion.
    const globalPattern =
      pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g');

    const matches = text.match(globalPattern);
    if (matches !== null && matches.length > 0) {
      matchCount += matches.length;
      // Replace all occurrences; using a fresh RegExp avoids lastIndex issues.
      const replacer = new RegExp(pattern.source, globalPattern.flags);
      text = text.replace(replacer, REDACTION_PLACEHOLDER);
    }
  }

  return { text, matchCount, applied: matchCount > 0 };
}

// ---------------------------------------------------------------------------
// redactPayload
// ---------------------------------------------------------------------------

export interface PayloadRedactionOptions extends RedactionOptions {
  /**
   * Maximum recursion depth. Nodes deeper than this are returned as-is.
   * Defaults to 10.
   */
  maxDepth?: number;
}

/**
 * Recursively redact a structured payload.
 *
 * - Object keys in SECRET_KEY_SET: value is replaced with REDACTION_PLACEHOLDER.
 * - String values (for non-secret keys): pattern-based redaction is applied.
 * - Arrays are traversed element-by-element.
 * - Numbers, booleans, null, undefined: returned unchanged.
 * - Circular references: replaced with the string '[Circular]'.
 * - Input is never mutated; a deep copy (with redactions) is returned.
 * - Recursion is bounded by maxDepth (default 10).
 */
export function redactPayload<T>(payload: T, options?: PayloadRedactionOptions): T {
  const patterns = options?.patterns ?? DEFAULT_SECRET_PATTERNS;
  const maxDepth = options?.maxDepth ?? 10;
  const seen = new WeakSet<object>();
  return redactValue(payload, 0, maxDepth, patterns, seen) as T;
}

function redactValue(
  value: unknown,
  depth: number,
  maxDepth: number,
  patterns: readonly RegExp[],
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redactString(value, { patterns }).text;
  }
  if (typeof value !== 'object') {
    // Numbers, booleans, symbols, functions — returned as-is.
    return value;
  }
  if (depth >= maxDepth) {
    // Depth limit reached; return node unchanged to avoid infinite recursion.
    return value;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    return '[Circular]';
  }
  seen.add(obj);

  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => redactValue(item, depth + 1, maxDepth, patterns, seen));
  } else {
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_SET.has(k.toLowerCase())) {
        redacted[k] = REDACTION_PLACEHOLDER;
      } else {
        redacted[k] = redactValue(v, depth + 1, maxDepth, patterns, seen);
      }
    }
    result = redacted;
  }

  // Allow the same object to be seen from different branches after processing.
  // This is safe because we have already produced the redacted copy above.
  seen.delete(obj);
  return result;
}
