// ---------------------------------------------------------------------------
// Profile-based secret redaction for files, output, payloads, and comments.
//
// Rule ordering (most-specific first to avoid partial overlaps):
//   1. pem_private_key   — block pattern, anchored BEGIN/END
//   2. github_pat (fine-grained) — github_pat_ prefix (longer, more specific)
//   3. github_pat (classic)    — ghp/ghs/gho/ghu/ghr prefix
//   4. aws_access_key   — AKIA + fixed-length uppercase
//   5. openai_key       — sk- prefix
//   6. bearer_token     — Bearer/bearer + space
//   7. slack_token      — xox[baprs]- prefix
//   8. generic_api_key  — assignment context (api_key=, apikey:, etc.)
//
// All RegExp instances are created fresh per call to avoid shared lastIndex.
// All patterns are free of nested quantifiers — linear-time matching, ReDoS-safe.
// ---------------------------------------------------------------------------

export interface RedactionRule {
  id: string;
  pattern: { source: string; flags: string };
  placeholder: string;
}

export interface RedactionProfile {
  id: string;
  rules: readonly RedactionRule[];
  secretValues?: readonly string[];
}

export interface RedactionResult {
  text: string;
  redacted: boolean;
  matchCount: number;
  categories: string[];
}

export interface ValueRedactionResult {
  value: unknown;
  redacted: boolean;
  matchCount: number;
  categories: string[];
}

// Key names whose object values are always masked regardless of content.
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

export const DEFAULT_RULES: readonly RedactionRule[] = [
  {
    id: 'pem_private_key',
    pattern: {
      source: '-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----',
      flags: 'gs',
    },
    placeholder: '[REDACTED:pem_private_key]',
  },
  {
    id: 'github_pat',
    pattern: {
      source: 'github_pat_[a-zA-Z0-9_]{82,}',
      flags: 'g',
    },
    placeholder: '[REDACTED:github_pat]',
  },
  {
    id: 'github_pat',
    pattern: {
      source: '(?:ghp|ghs|gho|ghu|ghr)_[a-zA-Z0-9]{36,}',
      flags: 'g',
    },
    placeholder: '[REDACTED:github_pat]',
  },
  {
    id: 'aws_access_key',
    pattern: {
      source: 'AKIA[0-9A-Z]{16}',
      flags: 'g',
    },
    placeholder: '[REDACTED:aws_access_key]',
  },
  {
    id: 'openai_key',
    pattern: {
      source: 'sk-[a-zA-Z0-9T_-]{20,}',
      flags: 'g',
    },
    placeholder: '[REDACTED:openai_key]',
  },
  {
    id: 'bearer_token',
    pattern: {
      source: '(?:Bearer|bearer)\\s+[a-zA-Z0-9._+/\\-]{20,}',
      flags: 'g',
    },
    placeholder: '[REDACTED:bearer_token]',
  },
  {
    id: 'slack_token',
    // xox[baprs] covers bot, app, personal, refresh, and service tokens.
    // The role char is required after xox to avoid matching xoxo-style strings.
    pattern: {
      source: 'xox[baprs]-[A-Za-z0-9-]{10,}',
      flags: 'g',
    },
    placeholder: '[REDACTED:slack_token]',
  },
  {
    id: 'generic_api_key',
    // Matches assignment contexts: api_key=, apikey:, api-key = "...", etc.
    // Requires at least 16 chars of alphanumeric+symbol content after the delimiter.
    pattern: {
      source: '(?:api[_-]?key|apikey)\\s*[=:]\\s*["\']?[A-Za-z0-9_\\-]{16,}["\']?',
      flags: 'gi',
    },
    placeholder: '[REDACTED:generic_api_key]',
  },
];

export const defaultProfile: RedactionProfile = {
  id: 'default',
  rules: DEFAULT_RULES,
};

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyRules(text: string, rules: readonly RedactionRule[]): { text: string; matchCount: number; categories: Set<string> } {
  let current = text;
  let totalMatchCount = 0;
  const categories = new Set<string>();

  for (const rule of rules) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let localCount = 0;
    const replaced = current.replace(regex, () => {
      localCount++;
      return rule.placeholder;
    });
    if (localCount > 0) {
      current = replaced;
      totalMatchCount += localCount;
      categories.add(rule.id);
    }
  }

  return { text: current, matchCount: totalMatchCount, categories };
}

function applyLiterals(text: string, secretValues: readonly string[]): { text: string; matchCount: number } {
  let current = text;
  let totalMatchCount = 0;

  for (const secret of secretValues) {
    if (!secret) continue;
    const regex = new RegExp(escapeRegExp(secret), 'g');
    let localCount = 0;
    const replaced = current.replace(regex, () => {
      localCount++;
      return '[REDACTED:configured_secret]';
    });
    if (localCount > 0) {
      current = replaced;
      totalMatchCount += localCount;
    }
  }

  return { text: current, matchCount: totalMatchCount };
}

/**
 * Redact secrets from a string, returning full stats.
 * Mirrors the existing redactSecrets() signature for callers that need counts/categories.
 */
export function redactWithStats(text: string, profile: RedactionProfile = defaultProfile): RedactionResult {
  if (typeof text !== 'string') {
    return { text: String(text ?? ''), redacted: false, matchCount: 0, categories: [] };
  }

  const rulesResult = applyRules(text, profile.rules);
  const literalsResult = profile.secretValues?.length
    ? applyLiterals(rulesResult.text, profile.secretValues)
    : { text: rulesResult.text, matchCount: 0 };

  const totalMatchCount = rulesResult.matchCount + literalsResult.matchCount;
  const allCategories = [...rulesResult.categories];
  if (literalsResult.matchCount > 0) {
    allCategories.push('configured_secret');
  }

  return {
    text: literalsResult.text,
    redacted: totalMatchCount > 0,
    matchCount: totalMatchCount,
    categories: allCategories,
  };
}

/**
 * Redact secrets from a string, returning only the redacted string.
 * Convenience wrapper over redactWithStats().
 */
export function redact(text: string, profile: RedactionProfile = defaultProfile): string {
  return redactWithStats(text, profile).text;
}

/**
 * Recursively redact secrets from an arbitrary value tree.
 *
 * - Recurses through objects and arrays up to depth 10.
 * - Values under secret-bearing key names are replaced with '[REDACTED]'.
 * - All string leaf values are pattern-scanned.
 * - Returns the redacted value and aggregate redaction status.
 */
export function redactValue(
  value: unknown,
  profile: RedactionProfile = defaultProfile,
  depth = 0,
): ValueRedactionResult {
  if (depth > 10) {
    return { value, redacted: false, matchCount: 0, categories: [] };
  }

  if (value === null || value === undefined) {
    return { value, redacted: false, matchCount: 0, categories: [] };
  }

  if (typeof value === 'string') {
    const r = redactWithStats(value, profile);
    return { value: r.text, redacted: r.redacted, matchCount: r.matchCount, categories: r.categories };
  }

  if (Array.isArray(value)) {
    let anyRedacted = false;
    let totalMatchCount = 0;
    const allCategories = new Set<string>();
    const redactedArray = value.map((item) => {
      const r = redactValue(item, profile, depth + 1);
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
        const r = redactValue(v, profile, depth + 1);
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

/**
 * Build a RedactionProfile that includes configured secret env-var values.
 *
 * Reads safety.redaction.secretEnvNames from config (via the provided getter)
 * and resolves each name against the provided env map (default: process.env).
 * Empty or undefined env values are skipped.
 */
export function buildProfileFromConfig(
  getSecretEnvNames: () => string[],
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): RedactionProfile {
  const names = getSecretEnvNames();
  const secretValues = names
    .map((name) => env[name])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);

  return {
    id: 'configured',
    rules: DEFAULT_RULES,
    secretValues,
  };
}

// ---------------------------------------------------------------------------
// Legacy compatibility re-exports (mirrors native-agent/tools/redaction.ts API)
// ---------------------------------------------------------------------------

export type RedactionCategory =
  | 'openai_key'
  | 'aws_access_key'
  | 'bearer_token'
  | 'pem_private_key'
  | 'github_pat'
  | 'slack_token'
  | 'generic_api_key';

export interface SecretPattern {
  category: string;
  regex: RegExp;
}

export interface RedactionOptions {
  extraPatterns?: (RegExp | SecretPattern)[];
  placeholder?: string | ((category: string) => string);
}

function resolvePlaceholder(
  placeholder: RedactionOptions['placeholder'],
  category: string,
): string {
  if (placeholder === undefined) return `[REDACTED:${category}]`;
  if (typeof placeholder === 'string') return placeholder;
  return placeholder(category);
}

/**
 * Redact secret patterns from a string (legacy API, preserved for callers).
 *
 * Uses the default profile patterns. Accepts extra patterns and custom placeholders
 * via options. Returns the full RedactionResult for stats-aware consumers.
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

  // Apply default profile rules with per-rule placeholder resolution.
  for (const rule of DEFAULT_RULES) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    const placeholder = resolvePlaceholder(options?.placeholder, rule.id);
    let localCount = 0;
    const newText = text.replace(regex, () => {
      localCount++;
      return placeholder;
    });
    if (localCount > 0) {
      text = newText;
      totalMatchCount += localCount;
      categories.add(rule.id);
    }
  }

  // Apply extra patterns from options.
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
 * Redact secrets from an arbitrary value tree (legacy API, preserved for callers).
 */
export function redactSecretsInValue(
  value: unknown,
  options?: RedactionOptions,
  depth = 0,
): { value: unknown; redacted: boolean; matchCount: number; categories: string[] } {
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
