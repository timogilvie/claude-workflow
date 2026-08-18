/**
 * Shared retry helper for `gh` CLI invocations.
 *
 * The tend loop and its merge path call `gh` (and, transitively, the GitHub
 * REST/GraphQL APIs) through `execShellCommand`. GitHub occasionally returns
 * transient 5xx/429/network errors that should be retried with bounded
 * exponential backoff rather than surfacing as a hard failure. This module
 * centralises the error classification and retry schedule so every `gh` call
 * site uses the same definition of "transient" and the same backoff curve.
 *
 * Only transient errors are retried. Authentication failures (401/403) and
 * other 4xx/non-network errors are rethrown immediately — the tend loop's
 * supervisor classifies auth failures as fatal (invalid state), and surfacing
 * them quickly produces a more visible `needs-user` dashboard state than a
 * silently-retrying loop.
 */

/**
 * Default maximum number of attempts (1 initial try + 3 retries).
 */
export const GH_RETRY_MAX_ATTEMPTS = 4;

/**
 * Base delay for the exponential backoff, in milliseconds.
 */
export const GH_RETRY_BASE_DELAY_MS = 1_000;

/**
 * Maximum delay for the exponential backoff, in milliseconds.
 */
export const GH_RETRY_MAX_DELAY_MS = 15_000;

/**
 * Patterns that indicate a transient, retryable GitHub/network error.
 * Matched case-insensitively against the concatenation of an error's
 * stdout, stderr, and message.
 */
export const GH_TRANSIENT_PATTERNS: readonly RegExp[] = [
  // HTTP status codes emitted by `gh` in its error text.
  /HTTP\s+5\d\d/i,
  /HTTP\s+429/i,
  /HTTP\s+408/i,
  // Rate limiting / abuse detection.
  /rate\s*limit/i,
  /secondary\s+rate\s+limit/i,
  /abuse\s+detection/i,
  // Low-level network errors (Node errno codes and their messages).
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ENETUNREACH|EHOSTUNREACH/i,
  /timed?\s*out|timeout/i,
  /connection\s+reset|connection\s+refused|could\s+not\s+resolve\s+host|failed\s+to\s+connect|network\s+is\s+unreachable|TLS\s+handshake|unexpected\s+EOF|dial\s+tcp|i\/o\s+timeout|no\s+such\s+host/i,
  // GitHub-specific transient wording.
  /No\s+server\s+is\s+currently\s+available/i,
  /Something\s+went\s+wrong\s+while\s+executing\s+your\s+query/i,
  // HTTP status phrases.
  /Bad\s+Gateway|Service\s+Unavailable|Gateway\s+Time-?out|Server\s+Error/i,
];

/**
 * Patterns that indicate a non-transient (terminal) GitHub error.
 * Listed for documentation/test ergonomics; the classifier treats anything
 * that is not auth and not transient as "other".
 */
export const GH_NON_TRANSIENT_PATTERNS: readonly RegExp[] = [
  /HTTP\s+404/i,
  /HTTP\s+422/i,
  /not\s+found/i,
  /ENOENT/i,
];

const AUTH_PATTERNS: readonly RegExp[] = [
  /HTTP\s+401/i,
  /HTTP\s+403/i,
  /Bad\s+credentials/i,
  /gh\s+auth\s+login/i,
  /authentication/i,
];

const RATE_LIMIT_GUARD_PATTERNS: readonly RegExp[] = [
  /rate\s*limit/i,
  /secondary\s+rate\s+limit/i,
  /abuse\s+detection/i,
];

const EXEC_NETWORK_ERROR_CODES: readonly Set<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

export type GhErrorKind = 'transient' | 'auth' | 'other';

export interface ClassifiedGhError {
  kind: GhErrorKind;
  /** The pattern source that matched, or null when no pattern matched. */
  matched: string | null;
}

/**
 * Extract a single searchable text blob from an error-like value.
 *
 * `gh` failures surface as `execSync` errors whose `stdout`/`stderr` fields
 * carry the HTTP status text and body — not just `message`. We concatenate
 * all available output so the classifier can match on any of them.
 *
 * Accepts a plain string (e.g. raw command output) as well.
 */
export function errorText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object') {
    const record = error as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
      code?: unknown;
      signal?: unknown;
      killed?: unknown;
    };

    const parts: string[] = [];
    for (const field of ['stdout', 'stderr', 'message'] as const) {
      const value = record[field];
      if (typeof value === 'string' && value.length > 0) {
        parts.push(value);
      } else if (Buffer.isBuffer(value)) {
        const text = value.toString().trim();
        if (text.length > 0) {
          parts.push(text);
        }
      }
    }

    // execSync timeout: { killed: true, signal: 'SIGTERM' } with no HTTP text.
    if (record.killed === true && typeof record.signal === 'string') {
      parts.push('timeout');
    }

    // Node errno code (e.g. error.code === 'ECONNRESET').
    if (typeof record.code === 'string' && EXEC_NETWORK_ERROR_CODES.has(record.code)) {
      parts.push(record.code);
    }

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  return String(error);
}

/**
 * Classify an error produced by a `gh` invocation.
 *
 * Order of evaluation:
 *  1. **auth** — `HTTP 401`, `HTTP 403` (unless rate-limit/abuse wording is
 *     present), `Bad credentials`, `gh auth login`, `authentication`.
 *  2. **transient** — 5xx/429/408, rate limits, network errno codes, timeouts,
 *     and GitHub's transient outage phrases.
 *  3. **other** — everything else (404/422, ENOENT, plain errors).
 *
 * Auth is checked first because GitHub sometimes returns 403 alongside
 * rate-limit text; in that case the rate-limit wording wins (transient).
 */
export function classifyGhError(error: unknown): ClassifiedGhError {
  const text = errorText(error);

  if (text.length === 0) {
    return { kind: 'other', matched: null };
  }

  // Auth — but a 403 that mentions rate limiting is transient, not auth.
  const isRateLimited = RATE_LIMIT_GUARD_PATTERNS.some((pattern) => pattern.test(text));
  if (!isRateLimited) {
    for (const pattern of AUTH_PATTERNS) {
      if (pattern.test(text)) {
        return { kind: 'auth', matched: pattern.source };
      }
    }
  }

  for (const pattern of GH_TRANSIENT_PATTERNS) {
    if (pattern.test(text)) {
      return { kind: 'transient', matched: pattern.source };
    }
  }

  return { kind: 'other', matched: null };
}

/**
 * Convenience predicate: is this error a transient, retryable `gh` failure?
 */
export function isTransientGhError(errorOrText: unknown): boolean {
  return classifyGhError(errorOrText).kind === 'transient';
}

/**
 * Compute the delay before the next retry attempt, in milliseconds.
 *
 * Uses exponential growth (`base * 2^(attempt-1)`) capped at `max`, with
 * bounded jitter: the final delay is 50-100% of the capped delay. The loop-level
 * backoff reuses this with a wider base/max so the curve shape stays consistent
 * between `gh`-call retries and loop-level retries.
 *
 * @param attempt - 1-based attempt number that just failed (1 → first retry).
 * @param base - Base delay in ms.
 * @param max - Cap on the un-jittered delay in ms.
 * @param random - Jitter source in [0, 1); defaults to `Math.random`.
 */
export function computeBackoffDelayMs(
  attempt: number,
  base: number,
  max: number,
  random: () => number = Math.random,
): number {
  if (attempt <= 0) {
    return 0;
  }

  // Exponential growth with an overflow-safe doubling loop (avoids 2**n for
  // large n, which is unnecessary once we've capped at max).
  let raw = base;
  for (let i = 1; i < attempt; i += 1) {
    if (raw >= max) {
      break;
    }
    raw *= 2;
  }
  const capped = Math.min(raw, max);
  const jitter = 0.5 + (Math.max(0, Math.min(1, random())) * 0.5);
  return Math.max(0, Math.round(capped * jitter));
}

/**
 * Error thrown when a transient `gh` failure exhausts all retry attempts.
 * Carries the original error and the attempt count so callers can distinguish
 * "gave up on a transient outage" from a hard failure (e.g. merge-path code
 * restores the PR to `ready` instead of falsely blocking it).
 */
export class GhTransientError extends Error {
  readonly attempts: number;
  readonly cause: unknown;
  readonly label?: string;

  constructor(message: string, options: { attempts: number; cause?: unknown; label?: string }) {
    super(message);
    this.name = 'GhTransientError';
    this.attempts = options.attempts;
    this.cause = options.cause;
    this.label = options.label;
  }
}

export interface GhRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (event: { attempt: number; maxAttempts: number; delayMs: number; error: unknown; label?: string }) => void;
  label?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a `gh` operation with bounded exponential backoff for transient failures.
 *
 * Non-transient failures are rethrown immediately. If every attempt fails with
 * a transient error, the final error is wrapped in `GhTransientError`.
 */
export async function withGhRetry<T>(
  fn: () => T | Promise<T>,
  options: GhRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? GH_RETRY_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? GH_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? GH_RETRY_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const isRetryable = options.isRetryable ?? isTransientGhError;

  let lastError: unknown = null;
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) {
        throw error;
      }

      if (attempt >= attempts) {
        throw new GhTransientError(
          `${options.label ?? 'gh command'} failed after ${attempts} transient attempts: ${errorText(error)}`,
          { attempts, cause: error, label: options.label },
        );
      }

      const delayMs = computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs, random);
      options.onRetry?.({ attempt, maxAttempts: attempts, delayMs, error, label: options.label });
      await sleep(delayMs);
    }
  }

  throw new GhTransientError(
    `${options.label ?? 'gh command'} failed after ${attempts} transient attempts: ${errorText(lastError)}`,
    { attempts, cause: lastError, label: options.label },
  );
}
