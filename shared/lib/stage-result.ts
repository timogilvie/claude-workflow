/**
 * Stage Result — Controller-Owned Stage Result Artifacts (HOK-1192)
 *
 * Defines the schema and I/O helpers for per-stage result files written by
 * the orchestrator. Each stage (planning, coding, review, ready) gets a
 * `.{stage}-result.json` file in the feature directory.
 *
 * Key design rules:
 * - Only the orchestrator writes these files — agents never modify them
 * - Writes are atomic (temp file + rename) to prevent partial JSON
 * - Reads never throw — they return null for missing or malformed files
 * - The schema is additive — old files without `artifacts`/`failureReason` remain valid
 *
 * @module stage-result
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Status values for controller-owned stage result files. */
export type StageStatus = 'running' | 'awaiting_user' | 'completed' | 'aborted' | 'failed';

/** Stage names used in result file naming. */
export type StageName = 'planning' | 'coding' | 'review' | 'ready';

/** Valid stage names for runtime validation. */
const VALID_STAGES: readonly StageName[] = ['planning', 'coding', 'review', 'ready'] as const;

/** Valid status values for runtime validation. */
const VALID_STATUSES: readonly StageStatus[] = ['running', 'awaiting_user', 'completed', 'aborted', 'failed'] as const;

// ── Per-stage artifact types ──

/** Artifacts produced during the planning stage. */
export interface PlanningArtifacts {
  type: 'planning';
  planFile?: string;
  taskPacketFile?: string;
}

/** Artifacts produced during the coding stage. */
export interface CodingArtifacts {
  type: 'coding';
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  commitCount?: number;
}

/** Artifacts produced during the review stage. */
export interface ReviewArtifacts {
  type: 'review';
  prNumber?: number;
  prUrl?: string;
  findingsCount?: number;
  blockingIssues?: number;
}

/** Artifacts produced during the ready stage. */
export interface ReadyArtifacts {
  type: 'ready';
  verdict?: 'pass' | 'fail' | 'warn' | 'pending';
  checksRun?: number;
  checksPassed?: number;
  mergeConflict?: string;
}

/** Discriminated union of all stage artifact types. */
export type StageArtifacts =
  | PlanningArtifacts
  | CodingArtifacts
  | ReviewArtifacts
  | ReadyArtifacts;

/**
 * Structure of a `.<stage>-result.json` file written by the orchestrator.
 *
 * Fields `artifacts` and `failureReason` are optional for backward
 * compatibility with files created before HOK-1192.
 */
export interface StageResult {
  stage: StageName;
  status: StageStatus;
  startedAt: string;
  finishedAt: string | null;
  agent: string;
  model: string;
  notes: string;
  artifacts?: StageArtifacts;
  failureReason?: string | null;
}

/** All stage result files found in a feature directory. */
export interface StageResultMap {
  planning?: StageResult;
  coding?: StageResult;
  review?: StageResult;
  ready?: StageResult;
}

// ────────────────────────────────────────────────────────────────
// Path Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Get the file path for a stage result file.
 *
 * @param featureDir - Absolute path to the feature directory
 * @param stage - Stage name
 * @returns Absolute path to `<featureDir>/.<stage>-result.json`
 */
export function getResultFilePath(featureDir: string, stage: StageName): string {
  return path.join(featureDir, `.${stage}-result.json`);
}

// ────────────────────────────────────────────────────────────────
// Read Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Read a single stage result file.
 *
 * Returns `null` when the file is missing, empty, or contains invalid JSON.
 * Validates that the `stage` field in the file matches the requested stage.
 * Never throws.
 *
 * @param featureDir - Absolute path to the feature directory
 * @param stage - Stage name to read
 * @returns Parsed StageResult or null
 */
export async function readStageResult(
  featureDir: string,
  stage: StageName,
): Promise<StageResult | null> {
  const resultPath = getResultFilePath(featureDir, stage);
  try {
    const content = await fs.readFile(resultPath, 'utf-8');
    if (!content.trim()) {
      process.stderr.write(`stage-result: empty file at ${resultPath}\n`);
      return null;
    }
    const parsed = JSON.parse(content) as StageResult;
    if (parsed.stage !== stage) {
      process.stderr.write(
        `stage-result: stage mismatch in ${resultPath} (expected '${stage}', got '${parsed.stage}')\n`,
      );
      return null;
    }
    if (!parsed.status) {
      process.stderr.write(`stage-result: missing status in ${resultPath}\n`);
      return null;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    process.stderr.write(`stage-result: failed to read ${resultPath}: ${err}\n`);
    return null;
  }
}

/**
 * Read all stage result files from a feature directory.
 *
 * Looks for `.planning-result.json`, `.coding-result.json`, etc.
 * Invalid or missing files are silently skipped.
 *
 * @param featureDir - Absolute path to the feature directory
 * @returns Map of stage name to result (only populated stages included)
 */
export async function readAllStageResults(featureDir: string): Promise<StageResultMap> {
  const results: StageResultMap = {};

  for (const stage of VALID_STAGES) {
    const result = await readStageResult(featureDir, stage);
    if (result) {
      results[stage] = result;
    }
  }

  return results;
}

// ────────────────────────────────────────────────────────────────
// Write Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Write a stage result file atomically.
 *
 * Creates the feature directory if it doesn't exist. Writes to a temporary
 * file first, then renames to the final path to prevent partial JSON on crash.
 *
 * @param featureDir - Absolute path to the feature directory
 * @param result - Complete StageResult to write
 */
export async function writeStageResult(
  featureDir: string,
  result: StageResult,
): Promise<void> {
  await fs.mkdir(featureDir, { recursive: true });

  const resultPath = getResultFilePath(featureDir, result.stage);
  const tmpPath = path.join(featureDir, `.tmp-${result.stage}-result.json`);

  const json = JSON.stringify(result, null, 2) + '\n';
  await fs.writeFile(tmpPath, json, 'utf-8');
  await fs.rename(tmpPath, resultPath);
}

/**
 * Update a stage result file with a partial patch.
 *
 * Reads the existing file (if any), merges the patch on top, and writes
 * the result atomically. If no existing file exists, the patch is written
 * as a new result (requires at minimum `stage` and `status` in the patch).
 *
 * The `startedAt` field from the existing result is preserved unless
 * explicitly overridden in the patch.
 *
 * @param featureDir - Absolute path to the feature directory
 * @param stage - Stage name to update
 * @param patch - Partial StageResult fields to merge
 */
export async function updateStageResult(
  featureDir: string,
  stage: StageName,
  patch: Partial<StageResult>,
): Promise<void> {
  const existing = await readStageResult(featureDir, stage);

  const merged: StageResult = {
    stage,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    agent: '',
    model: '',
    notes: '',
    ...existing,
    ...patch,
    stage, // always enforce stage from argument, not patch
  };

  await writeStageResult(featureDir, merged);
}

// ────────────────────────────────────────────────────────────────
// Validation Helpers (for CLI)
// ────────────────────────────────────────────────────────────────

/** Check if a string is a valid stage name. */
export function isValidStage(value: string): value is StageName {
  return (VALID_STAGES as readonly string[]).includes(value);
}

/** Check if a string is a valid stage status. */
export function isValidStatus(value: string): value is StageStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}
