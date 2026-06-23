// ---------------------------------------------------------------------------
// Secret redaction for tool results, assistant content, and transcript events.
// ---------------------------------------------------------------------------

export type RedactionCategory =
  | 'openai_key'
  | 'aws_access_key'
  | 'bearer_token'
  | 'pem_private_key'
  | 'github_pat';

export interface SecretPattern {
  category: string;
  regex: RegExp;
}

export interface RedactionResult {
  text: string;
  redacted: boolean;
  matchCount: number;
  categories: string[];
}

export interface RedactionOptions {
  extraPatterns?: (RegExp | SecretPattern)[];
  placeholder?: string | ((category: string) => string);
}

export interface ValueRedactionResult {
  value: unknown;
  redacted: boolean;
  matchCount: number;
  categories: string[];
}

// Patterns stored as source+flags to create fresh RegExp instances per call,
// avoiding shared lastIndex side-effects across repeated invocations.
const DEFAULT_SECRET_PATTERNS: ReadonlyArray<{ category: RedactionCategory; source: string; flags: string }> = [
  // OpenAI-style sk- tokens (at least 20 alphanumeric chars after sk-)
  { category: 'openai_key', source: 'sk-[a-zA-Z0-9T_-]{20,}', flags: 'g' },
  // AWS access key IDs
  { category: 'aws_access_key', source: 'AKIA[0-9A-Z]{16}', flags: 'g' },
  // Bearer token values (at least 20 chars)
  { category: 'bearer_token', source: '(?:Bearer|bearer)\\s+[a-zA-Z0-9._+/\\-]{20,}', flags: 'g' },
  // PEM private key blocks (multiline)
  { category: 'pem_private_key', source: '-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----', flags: 'gs' },
  // GitHub PAT tokens (ghp_, ghs_, gho_, ghu_, ghr_)
  { category: 'github_pat', source: '(?:ghp|ghs|gho|ghu|ghr)_[a-zA-Z0-9]{36,}', flags: 'g' },
  // GitHub fine-grained PAT
  { category: 'github_pat', source: 'github_pat_[a-zA-Z0-9_]{82,}', flags: 'g' },
];

// Key names whose values are always masked, regardless of value content.
const SECRET_KEY_NAMES = new Set([
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

function resolvePlaceholder(
  placeholder: RedactionOptions['placeholder'],
  category: string,
): string {
  if (placeholder === undefined) return `[REDACTED:${category}]`;
  if (typeof placeholder === 'string') return placeholder;
  return placeholder(category);
}

/**
 * Redact secret patterns from a string.
 *
 * Returns a RedactionResult with the redacted text and aggregate stats.
 * Handles null/undefined gracefully by returning an empty-string result.
 */
export function redactSecrets(value: unknown, options?: RedactionOptions): RedactionResult {
  if (value === null || value === undefined) {
    return { text: '', redacted: false, matchCount: 0, categories: [] };
  }
  if (typeof value !== 'string') {
    return { text: String(value), redacted: false, matchCount: 0, categories: [] };
  }

  let text = value;
  let totalMatchCount = 0;
  const categories = new Set<string>();

  for (const { category, source, flags } of DEFAULT_SECRET_PATTERNS) {
    const regex = new RegExp(source, flags);
    const placeholder = resolvePlaceholder(options?.placeholder, category);
    let localCount = 0;
    const newText = text.replace(regex, () => {
      localCount++;
      return placeholder;
    });
    if (localCount > 0) {
      text = newText;
      totalMatchCount += localCount;
      categories.add(category);
    }
  }

  if (options?.extraPatterns) {
    for (const pattern of options.extraPatterns) {
      let category: string;
      let source: string;
      let flags: string;
      if (pattern instanceof RegExp) {
        category = 'custom';
        source = pattern.source;
        flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
      } else {
        category = pattern.category;
        source = pattern.regex.source;
        flags = pattern.regex.flags.includes('g') ? pattern.regex.flags : pattern.regex.flags + 'g';
      }
      const regex = new RegExp(source, flags);
      const placeholder = resolvePlaceholder(options.placeholder, category);
      let localCount = 0;
      const newText = text.replace(regex, () => {
        localCount++;
        return placeholder;
      });
      if (localCount > 0) {
        text = newText;
        totalMatchCount += localCount;
        categories.add(category);
      }
    }
  }

  return {
    text,
    redacted: totalMatchCount > 0,
    matchCount: totalMatchCount,
    categories: [...categories],
  };
}

/**
 * Redact secrets from an arbitrary value tree.
 *
 * - Recurses through objects and arrays up to depth 10.
 * - Values under secret-bearing key names are replaced with '[REDACTED]'.
 * - All string leaf values are pattern-scanned with redactSecrets.
 * - Returns the redacted value and aggregate redaction status.
 */
export function redactSecretsInValue(
  value: unknown,
  options?: RedactionOptions,
  depth = 0,
): ValueRedactionResult {
  if (depth > 10) {
    return { value, redacted: false, matchCount: 0, categories: [] };
  }

  if (value === null || value === undefined) {
    return { value, redacted: false, matchCount: 0, categories: [] };
  }

  if (typeof value === 'string') {
    const r = redactSecrets(value, options);
    return { value: r.text, redacted: r.redacted, matchCount: r.matchCount, categories: r.categories };
  }

  if (Array.isArray(value)) {
    let anyRedacted = false;
    let totalMatchCount = 0;
    const allCategories = new Set<string>();
    const redactedArray = value.map((item) => {
      const r = redactSecretsInValue(item, options, depth + 1);
      if (r.redacted) {
        anyRedacted = true;
        totalMatchCount += r.matchCount;
        for (const c of r.categories) allCategories.add(c);
      }
      return r.value;
    });
    return { value: redactedArray, redacted: anyRedacted, matchCount: totalMatchCount, categories: [...allCategories] };
  }

  if (typeof value === 'object') {
    let anyRedacted = false;
    let totalMatchCount = 0;
    const allCategories = new Set<string>();
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_NAMES.has(k.toLowerCase())) {
        result[k] = '[REDACTED]';
        anyRedacted = true;
        totalMatchCount++;
        allCategories.add('secret_key');
      } else {
        const r = redactSecretsInValue(v, options, depth + 1);
        result[k] = r.value;
        if (r.redacted) {
          anyRedacted = true;
          totalMatchCount += r.matchCount;
          for (const c of r.categories) allCategories.add(c);
        }
      }
    }
    return { value: result, redacted: anyRedacted, matchCount: totalMatchCount, categories: [...allCategories] };
  }

  return { value, redacted: false, matchCount: 0, categories: [] };
}
