/**
 * Task Trace Events — best-effort lifecycle correlation stream (HOK-2259)
 *
 * Provides a stable `traceId` per workflow task and a JSONL event stream
 * (`trace.jsonl`) that links route artifacts, stage results, eval records,
 * and ready-check outcomes across the full task lifecycle.
 *
 * Design rules:
 * - `appendTraceEvent` is best-effort and never throws or rejects
 * - The stream is append-only; reads are never required for workflow correctness
 * - `traceId` is generated once and reused across reroute / resume
 * - Schema is additive; old events without optional fields remain valid
 *
 * @module trace-event
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ────────────────────────────────────────────────────────────────
// Schema version
// ────────────────────────────────────────────────────────────────

export const TRACE_SCHEMA_VERSION = '1.0';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type TracePhase = 'launch' | 'planning' | 'coding' | 'review' | 'ready' | 'eval' | 'cleanup';

export type TraceEventName =
  | 'task_launched'
  | 'contract_projected'
  | 'route_assigned'
  | 'route_promoted'
  | 'phase_started'
  | 'phase_completed'
  | 'check_passed'
  | 'check_failed'
  | 'fallback_used'
  | 'remediation_started'
  | 'remediation_completed'
  | 'eval_recorded'
  | 'cleanup_archived';

export type TraceEventStatus = 'ok' | 'failed' | 'skipped';

export interface TraceEvent {
  schemaVersion: string;
  traceId: string;
  issueId: string;
  slug: string;
  timestamp: string;
  phase: TracePhase;
  event: TraceEventName;
  status?: TraceEventStatus;
  model?: string;
  agent?: string;
  failureType?: string;
  /** Hashes or paths of related artifacts */
  artifactRefs?: string[];
  /** Additional structured metadata for this event */
  meta?: Record<string, unknown>;
}

/** Minimal context needed to emit trace events for a task. */
export interface TraceContext {
  traceId: string;
  issueId: string;
  slug: string;
  featureDir: string;
}

/** Persisted trace metadata file shape. */
interface TraceContextFile {
  schemaVersion: string;
  traceId: string;
  issueId: string;
  slug: string;
  createdAt: string;
}

// ────────────────────────────────────────────────────────────────
// ID generation
// ────────────────────────────────────────────────────────────────

/**
 * Generate a stable trace ID for a new task.
 *
 * Format: `trc_<8-hex-timestamp>_<16-hex-random>`
 * This is human-readable, sortable, and collision-resistant without
 * requiring external UUID libraries.
 */
export function generateTraceId(): string {
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const rnd = randomBytes(8).toString('hex');
  return `trc_${ts}_${rnd}`;
}

// ────────────────────────────────────────────────────────────────
// Path helpers
// ────────────────────────────────────────────────────────────────

/** Absolute path to the trace JSONL stream in a feature directory. */
export function getTraceFilePath(featureDir: string): string {
  return path.join(featureDir, 'trace.jsonl');
}

/** Absolute path to the persisted trace context metadata file. */
export function getTraceContextPath(featureDir: string): string {
  return path.join(featureDir, '.trace-context.json');
}

/** Absolute path to the archived trace file under evals/artifacts. */
export function getArchivedTracePath(archiveDir: string): string {
  return path.join(archiveDir, 'trace.jsonl');
}

// ────────────────────────────────────────────────────────────────
// Context persistence
// ────────────────────────────────────────────────────────────────

/**
 * Load an existing trace context for a task from the feature directory.
 *
 * Returns `null` when no context exists or the file is malformed.
 * Never throws.
 */
export function loadTraceContext(featureDir: string): TraceContext | null {
  const contextPath = getTraceContextPath(featureDir);
  if (!existsSync(contextPath)) {
    return null;
  }
  try {
    const raw = readFileSync(contextPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TraceContextFile>;
    if (!parsed.traceId || !parsed.issueId || !parsed.slug) {
      return null;
    }
    return {
      traceId: parsed.traceId,
      issueId: parsed.issueId,
      slug: parsed.slug,
      featureDir,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a trace context to the feature directory.
 *
 * Writes atomically (temp file + rename). Never throws.
 */
export async function saveTraceContext(ctx: TraceContext): Promise<void> {
  try {
    await fs.mkdir(ctx.featureDir, { recursive: true });
    const contextPath = getTraceContextPath(ctx.featureDir);
    const tmpPath = path.join(ctx.featureDir, '.tmp-trace-context.json');
    const payload: TraceContextFile = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId: ctx.traceId,
      issueId: ctx.issueId,
      slug: ctx.slug,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpPath, contextPath);
  } catch {
    // best-effort — trace persistence must never break the workflow
  }
}

/**
 * Resolve or create a trace context for a task.
 *
 * Loads an existing context if present; otherwise creates a new one with a
 * freshly generated `traceId` and persists it to the feature directory.
 */
export async function resolveTraceContext(
  featureDir: string,
  issueId: string,
  slug: string,
): Promise<TraceContext> {
  const existing = loadTraceContext(featureDir);
  if (existing && existing.issueId === issueId && existing.slug === slug) {
    return existing;
  }
  const ctx: TraceContext = {
    traceId: generateTraceId(),
    issueId,
    slug,
    featureDir,
  };
  await saveTraceContext(ctx);
  return ctx;
}

// ────────────────────────────────────────────────────────────────
// Event appending
// ────────────────────────────────────────────────────────────────

/**
 * Append a trace event to the task's `trace.jsonl` stream.
 *
 * This function is best-effort: it swallows all errors and never rejects.
 * The caller should not rely on a successful return for workflow correctness.
 */
export async function appendTraceEvent(
  ctx: TraceContext,
  eventFields: Omit<TraceEvent, 'schemaVersion' | 'traceId' | 'issueId' | 'slug' | 'timestamp'>,
): Promise<void> {
  try {
    const event: TraceEvent = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId: ctx.traceId,
      issueId: ctx.issueId,
      slug: ctx.slug,
      timestamp: new Date().toISOString(),
      ...eventFields,
    };
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(getTraceFilePath(ctx.featureDir), line, 'utf-8');
  } catch {
    // best-effort
  }
}

/**
 * Synchronous variant of appendTraceEvent for use in synchronous callers.
 * Never throws.
 */
export function appendTraceEventSync(
  ctx: TraceContext,
  eventFields: Omit<TraceEvent, 'schemaVersion' | 'traceId' | 'issueId' | 'slug' | 'timestamp'>,
): void {
  try {
    const event: TraceEvent = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId: ctx.traceId,
      issueId: ctx.issueId,
      slug: ctx.slug,
      timestamp: new Date().toISOString(),
      ...eventFields,
    };
    const line = JSON.stringify(event) + '\n';
    appendFileSync(getTraceFilePath(ctx.featureDir), line, 'utf-8');
  } catch {
    // best-effort
  }
}

// ────────────────────────────────────────────────────────────────
// Archive
// ────────────────────────────────────────────────────────────────

/**
 * Copy the trace.jsonl from a feature directory to the eval archive directory.
 *
 * Returns true when the copy succeeded, false when not applicable or failed.
 * Never throws.
 */
export async function archiveTraceFile(featureDir: string, archiveDir: string): Promise<boolean> {
  try {
    const src = getTraceFilePath(featureDir);
    if (!existsSync(src)) {
      return false;
    }
    await fs.mkdir(archiveDir, { recursive: true });
    const dst = getArchivedTracePath(archiveDir);
    await fs.copyFile(src, dst);
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────
// Artifact hash helper
// ────────────────────────────────────────────────────────────────

/**
 * Compute a short artifact reference string for a file path.
 *
 * Format: `<relative-path>#<sha256-prefix>` or just `<relative-path>` on
 * read failure. Used in artifactRefs fields of trace events.
 * Never throws.
 */
export function artifactRef(filePath: string, baseDir?: string): string {
  try {
    const rel = baseDir ? path.relative(baseDir, filePath) : filePath;
    const content = readFileSync(filePath);
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
    return `${rel}#${hash}`;
  } catch {
    return filePath;
  }
}
