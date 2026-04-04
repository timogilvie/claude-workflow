/**
 * Eval result persistence — append and query eval records in JSONL format.
 *
 * Records are stored as newline-delimited JSON (one JSON object per line)
 * in a configurable directory (default: `.wavemill/evals/`).
 *
 * @module eval-persistence
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvalRecord } from './eval-schema.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { appendJsonlRecord, readJsonlFile } from './jsonl-utils.ts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const EVALS_FILENAME = 'evals.jsonl';

// ────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────

/** Options for specifying the eval storage directory. */
export interface PersistenceOptions {
  /** Override directory for eval storage. Resolved relative to cwd. */
  dir?: string;
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
function resolveEvalsFile(dir?: string): string {
  return join(resolveEvalsDir(dir).dir, EVALS_FILENAME);
}

/**
 * Validate that the resolved directory doesn't escape the project root.
 * Throws if path traversal is detected.
 */
function assertSafePath(evalsDir: string): void {
  const projectRoot = resolve('.');
  const resolved = resolve(evalsDir);
  if (!resolved.startsWith(projectRoot)) {
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
  const { dir: evalsDir, fromConfig } = resolveEvalsDir(options?.dir);
  if (fromConfig) assertSafePath(evalsDir);
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
  const filePath = resolveEvalsFile(options?.dir);

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
