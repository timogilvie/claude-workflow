export const TRANSIENT_ERROR_PATTERN =
  /\bHTTP (?:5\d\d|429|408)\b|No server is currently available|Service Unavailable|Bad Gateway|Gateway Time-?out|secondary rate limit|rate limit|abuse detection|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|connection reset|TLS handshake timeout|i\/o timeout|dial tcp|Could not resolve host|Failed to connect|network is unreachable|temporarily unavailable|unexpected EOF|error sending request|timed out|The remote end hung up unexpectedly|RPC failed|unable to access/i;

const TRANSIENT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

export class TransientError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'TransientError';
    this.cause = options.cause;
  }
}

export function isTransientErrorText(text: string): boolean {
  return TRANSIENT_ERROR_PATTERN.test(text);
}

export function isTransientError(error: unknown): boolean {
  if (error instanceof TransientError) {
    return true;
  }

  if (typeof error === 'string') {
    return isTransientErrorText(error);
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as Record<string, unknown>;
  const code = record.code;
  if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }

  if (record.killed === true && typeof record.signal === 'string') {
    return true;
  }

  const parts = [record.message, record.stderr, record.stdout]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part));
  return parts.some(isTransientErrorText);
}

export function computeBackoffDelayMs(
  attempt: number,
  options: {
    baseMs: number;
    maxMs: number;
    factor?: number;
    jitterRatio?: number;
    random?: () => number;
  },
): number {
  const factor = options.factor ?? 2;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, attempt - 1);
  const raw = options.baseMs * (factor ** exponent);
  const capped = Math.min(options.maxMs, raw);
  const jitter = capped * jitterRatio * ((random() * 2) - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export async function retryTransient<T>(
  fn: () => T | Promise<T>,
  options: {
    label?: string;
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: { attempt: number; delayMs: number; error: unknown; label?: string }) => void;
    random?: () => number;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const shouldRetry = options.shouldRetry ?? isTransientError;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, {
        baseMs: options.baseDelayMs ?? 2_000,
        maxMs: options.maxDelayMs ?? 20_000,
        random: options.random,
      });
      options.onRetry?.({ attempt, delayMs, error, label: options.label });
      await sleep(delayMs);
    }
  }

  throw new Error('retryTransient: unreachable');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
