/**
 * PII redaction for Hokusai submissions.
 *
 * Call `redactHokusaiSubmission()` after `toHokusaiSubmission()` and before any
 * submission data leaves the user's machine.
 *
 * @module hokusai-redaction
 */

import { createHash, randomBytes } from 'node:crypto';
import { loadUserConfig, saveUserConfig, type HokusaiUserConfig } from './hokusai-consent.ts';
import type { HokusaiSubmission } from './hokusai-schema.ts';

export interface RedactionOptions {
  salt?: string;
  configDir?: string;
}

const HASHED_IDENTIFIER_PATHS = new Set(['run_id', 'task_id']);
const PRESERVED_STRING_PATHS = new Set([
  'route_taken.planner_model',
  'route_taken.coder_model',
  'route_taken.reviewer_model',
]);

function isNonEmptySalt(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function hashIdentifier(value: string, salt: string): string {
  const digest = createHash('sha256')
    .update(`${salt}:${value}`)
    .digest('hex')
    .slice(0, 16);

  return `redacted-${digest}`;
}

function redactSubmissionValue(value: unknown, path: string[], salt: string): unknown {
  const joinedPath = path.join('.');

  if (HASHED_IDENTIFIER_PATHS.has(joinedPath)) {
    return hashIdentifier(String(value), salt);
  }

  if (typeof value === 'string') {
    return PRESERVED_STRING_PATHS.has(joinedPath) ? value : '';
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      redactSubmissionValue(entry, [...path, String(index)], salt),
    );
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactSubmissionValue(entry, [...path, key], salt),
      ]),
    );
  }

  return value;
}

function withRedactionSalt(config: HokusaiUserConfig, salt: string): HokusaiUserConfig {
  return {
    ...config,
    hokusai: {
      ...(config.hokusai || {}),
      redactionSalt: salt,
    },
  };
}

/**
 * Load the user's persistent redaction salt, creating one on first use.
 */
export function getOrCreateRedactionSalt(configDir?: string): string {
  const config = loadUserConfig(configDir);
  const existingSalt = config.hokusai?.redactionSalt;

  if (isNonEmptySalt(existingSalt)) {
    return existingSalt;
  }

  const salt = randomBytes(32).toString('hex');
  saveUserConfig(withRedactionSalt(config, salt), configDir);
  return salt;
}

/**
 * Redact a Hokusai submission so only training-relevant fields remain readable.
 *
 * Identifiers are deterministically hashed for deduplication. Known model
 * selection fields are preserved verbatim. Any other string field is stripped
 * entirely so schema growth does not silently leak new free-text data.
 */
export function redactHokusaiSubmission(
  submission: HokusaiSubmission,
  options: RedactionOptions = {},
): HokusaiSubmission {
  const salt = options.salt ?? getOrCreateRedactionSalt(options.configDir);
  return redactSubmissionValue(submission, [], salt) as HokusaiSubmission;
}
