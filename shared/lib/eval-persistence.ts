/**
 * Eval result persistence — append and query eval records in JSONL format.
 *
 * Records are stored as newline-delimited JSON (one JSON object per line)
 * in a configurable directory (default: `.wavemill/evals/`).
 *
 * @module eval-persistence
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { EvalRecord } from './eval-schema.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { appendJsonlRecord, readJsonlFile } from './jsonl-utils.ts';
import { validateEvalRecord, type ValidationIssue } from './eval-validator.ts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const EVALS_FILENAME = 'evals.jsonl';
const WRITE_BLOCKING_CODES = new Set([
  'MISSING_REQUIRED_FIELD',
  'SCHEMA_VIOLATION',
  'EVAL_MISSING_TASK_DESCRIPTOR',
  'EVAL_EMPTY_MODELS_AVAILABLE',
  'EVAL_UNKNOWN_STAGE_MODEL',
  'EVAL_NONCANONICAL_REVIEWER',
] as const);

export class EvalValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(
      `Eval record failed write-time validation: ${issues.map((issue) => `${issue.code}${issue.detail ? `(${issue.detail})` : ''}`).join(', ')}`,
    );
    this.name = 'EvalValidationError';
    this.issues = issues;
  }
}

// ────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────

/** Options for specifying the eval storage directory. */
export interface PersistenceOptions {
  /** Override directory for eval storage. Resolved relative to cwd. */
  dir?: string;
  /** Repository root used to resolve the effective model registry during write-time validation. */
  repoDir?: string;
  /** Internal opt-out for unit-test fixtures that intentionally persist invalid records. */
  skipValidation?: boolean;
}

/** Options for querying stored eval records. */
export interface QueryOptions extends PersistenceOptions {
  /** Filter by model identifier (exact match) */
  model?: string;
  /** Include only records after this date (inclusive) */
  after?: Date;
  /** Include only records before this date (inclusive) */
  before?: Date;
  /** Include only records with score >= this value */
  minScore?: number;
  /** Include only records with score <= this value */
  maxScore?: number;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Resolve the full path to the evals JSONL file. */
function resolveEvalsFile(dir?: string, repoDir?: string): string {
  return join(resolveEvalsDir(dir, repoDir).dir, EVALS_FILENAME);
}

/**
 * Validate that the resolved directory doesn't escape the project root.
 * Throws if path traversal is detected.
 */
function assertSafePath(evalsDir: string, repoDir?: string): void {
  const projectRoot = resolve(repoDir ?? process.cwd());
  const resolved = resolve(evalsDir);
  const relativePath = relative(projectRoot, resolved);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(
      `Evals directory must be within the project root.\n` +
      `  Project root: ${projectRoot}\n` +
      `  Resolved dir: ${resolved}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Append an eval record to the JSONL file.
 *
 * Creates the output directory and file if they don't exist.
 * Uses atomic write (temp file + rename) to prevent corruption.
 *
 * @param record - The eval record to persist
 * @param options - Optional directory override
 */
export function appendEvalRecord(
  record: EvalRecord,
  options?: PersistenceOptions,
): void {
  const { dir: evalsDir, fromConfig } = resolveEvalsDir(options?.dir, options?.repoDir);
  if (fromConfig) assertSafePath(evalsDir, options?.repoDir);

  if (!options?.skipValidation) {
    const issues = validateEvalRecord(record, {
      file: '<inline>',
      line: 0,
      repoDir: options?.repoDir,
    }).filter((issue) => WRITE_BLOCKING_CODES.has(issue.code));
    if (issues.length > 0) {
      throw new EvalValidationError(issues);
    }
  }

  appendJsonlRecord(join(evalsDir, EVALS_FILENAME), record);
}

/**
 * Read and optionally filter eval records from the JSONL file.
 *
 * Returns an empty array if the file doesn't exist.
 * Malformed lines are silently skipped.
 *
 * @param options - Query filters and directory override
 * @returns Array of matching eval records
 */
export function readEvalRecords(options?: QueryOptions): EvalRecord[] {
  const filePath = resolveEvalsFile(options?.dir, options?.repoDir);

  return readEvalRecordsFromFile(filePath, options);
}

export function readEvalRecordsFromFile(
  filePath: string,
  options?: Omit<QueryOptions, 'dir'>,
): EvalRecord[] {
  if (!existsSync(filePath)) {
    return [];
  }

  return readJsonlFile<EvalRecord>(filePath).filter((record) =>
    matchesFilters(record, options),
  );
}

/**
 * Return whether an eval record exists for a specific challenge pair / PR URL.
 */
export function hasChallengeEvalRecord(
  pairId: string,
  prUrl: string,
  options?: QueryOptions,
): boolean {
  return readEvalRecords(options).some((record) =>
    record.challengePairId === pairId && record.prUrl === prUrl,
  );
}

/**
 * Return whether both sides of a challenge pair have persisted eval records.
 */
export function hasChallengeEvalRecordPair(
  pairId: string,
  primaryPrUrl: string,
  challengerPrUrl: string,
  options?: QueryOptions,
): boolean {
  return hasChallengeEvalRecord(pairId, primaryPrUrl, options)
    && hasChallengeEvalRecord(pairId, challengerPrUrl, options);
}

/**
 * Check whether a record matches all provided query filters.
 */
function matchesFilters(
  record: EvalRecord,
  options?: QueryOptions,
): boolean {
  if (!options) return true;

  if (options.model && record.modelId !== options.model) {
    return false;
  }

  if (options.after) {
    const recordDate = new Date(record.timestamp);
    if (recordDate < options.after) return false;
  }

  if (options.before) {
    const recordDate = new Date(record.timestamp);
    if (recordDate > options.before) return false;
  }

  if (options.minScore !== undefined && record.score < options.minScore) {
    return false;
  }

  if (options.maxScore !== undefined && record.score > options.maxScore) {
    return false;
  }

  return true;
}
