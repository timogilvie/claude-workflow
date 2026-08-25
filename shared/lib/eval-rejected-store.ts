import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EvalRecord } from './eval-schema.ts';
import { resolveRejectedEvalsDir } from './evals-paths.ts';
import type { ValidationIssue } from './eval-validator.ts';
import { redact, redactValue } from './redaction-profiles.ts';
import { errorMessage } from './error-utils.ts';

export const DEFAULT_REJECTED_EVAL_RETENTION = 200;
export const REJECTED_EVAL_VALUE_MAX_CHARS = 200;

export interface RejectedEvalPayload {
  quarantinedAt: string;
  reason: 'write_time_validation';
  issues: ValidationIssue[];
  record: EvalRecord;
}

export interface QuarantineRejectedEvalRecordOptions {
  record: EvalRecord;
  issues: ValidationIssue[];
  repoDir?: string;
  dir?: string;
  retention?: number;
}

export interface ListRejectedEvalRecordsOptions {
  limit?: number;
  dir?: string;
}

interface RejectedFileEntry {
  path: string;
  filename: string;
  mtimeMs: number;
}

export function normalizeRejectedEvalRetention(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_REJECTED_EVAL_RETENTION;
  }
  return Math.max(1, Math.floor(value));
}

export function extractValueAtPath(value: unknown, path: string | undefined): unknown {
  if (!path) {
    return undefined;
  }

  const normalizedPath = path.split(':', 1)[0]?.trim();
  if (!normalizedPath) {
    return undefined;
  }

  const segments = parsePathSegments(normalizedPath);
  if (!segments) {
    return undefined;
  }

  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    const object = current as Record<string, unknown>;
    if (!Object.hasOwn(object, segment)) {
      return undefined;
    }
    current = object[segment];
  }

  return current;
}

export function formatIssueValue(value: unknown, repoDir?: string): string {
  const redactedValue = redactValue(value).value;
  const serialized = safeSerialize(redactedValue);
  const redacted = redact(repoDir ? serialized.replaceAll(repoDir, '<repo>') : serialized);
  return truncate(redacted, REJECTED_EVAL_VALUE_MAX_CHARS);
}

export function quarantineRejectedEvalRecord(
  options: QuarantineRejectedEvalRecordOptions,
): string | null {
  const rejectedDir = resolveRejectedEvalsDir(options.dir, options.repoDir).dir;
  const payload: RejectedEvalPayload = {
    quarantinedAt: new Date().toISOString(),
    reason: 'write_time_validation',
    issues: options.issues,
    record: options.record,
  };

  try {
    mkdirSync(rejectedDir, { recursive: true });
    const finalPath = reserveRejectedFilePath(rejectedDir, options.record, options.issues);
    const tempPath = `${finalPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, finalPath);
    pruneRejectedEvalRecords(rejectedDir, normalizeRejectedEvalRetention(options.retention));
    return finalPath;
  } catch (error) {
    process.stderr.write(`Eval rejected-record quarantine failed: ${errorMessage(error)}\n`);
    return null;
  }
}

export function countRejectedEvalRecords(repoDir?: string, dir?: string): number {
  try {
    const entries = getRejectedFileEntries(repoDir, dir);
    return entries.length;
  } catch {
    return 0;
  }
}

export function listRejectedEvalRecords(
  repoDir?: string,
  options?: ListRejectedEvalRecordsOptions,
): string[] {
  try {
    const entries = getRejectedFileEntries(repoDir, options?.dir);
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.filename.localeCompare(a.filename));
    const limit = options?.limit === undefined ? entries.length : Math.max(0, Math.floor(options.limit));
    return entries.slice(0, limit).map((entry) => entry.path);
  } catch {
    return [];
  }
}

function parsePathSegments(path: string): string[] | null {
  const segments: string[] = [];
  let buffer = '';
  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];
    if (char === '.') {
      if (buffer) {
        segments.push(buffer);
        buffer = '';
      }
      continue;
    }
    if (char === '[') {
      if (buffer) {
        segments.push(buffer);
        buffer = '';
      }
      const close = path.indexOf(']', index + 1);
      if (close === -1) {
        return null;
      }
      const raw = path.slice(index + 1, close).trim();
      const quoted = raw.match(/^['"](.+)['"]$/);
      const segment = quoted ? quoted[1] : raw;
      if (!segment) {
        return null;
      }
      segments.push(segment);
      index = close;
      continue;
    }
    buffer += char;
  }
  if (buffer) {
    segments.push(buffer);
  }
  return segments.length > 0 ? segments : null;
}

function safeSerialize(value: unknown): string {
  if (value === undefined) {
    return '<undefined>';
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return `[unserializable:${typeof value}]`;
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function reserveRejectedFilePath(
  rejectedDir: string,
  record: EvalRecord,
  issues: ValidationIssue[],
): string {
  const baseName = buildRejectedFilename(record, issues);
  for (let counter = 0; counter < 1000; counter += 1) {
    const suffix = counter === 0 ? '' : `-${counter}`;
    const candidate = join(rejectedDir, `${baseName}${suffix}.json`);
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  return join(rejectedDir, `${baseName}-${Math.random().toString(36).slice(2, 8)}.json`);
}

function buildRejectedFilename(record: EvalRecord, issues: ValidationIssue[]): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const issueSegment = sanitizeSegment(record.issueId ?? issues[0]?.detail ?? issues[0]?.code ?? 'unknown');
  const side = typeof record.challengeSide === 'string' ? record.challengeSide : 'unknown';
  return `${timestamp}-${issueSegment}-${sanitizeSegment(side)}`;
}

function sanitizeSegment(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.slice(0, 80) || 'unknown';
}

function pruneRejectedEvalRecords(rejectedDir: string, retention: number): void {
  const entries = getRejectedFileEntriesFromDir(rejectedDir);
  if (entries.length <= retention) {
    return;
  }
  entries.sort((a, b) => a.filename.localeCompare(b.filename));
  const removeCount = entries.length - retention;
  for (const entry of entries.slice(0, removeCount)) {
    rmSync(entry.path, { force: true });
  }
}

function getRejectedFileEntries(repoDir?: string, dir?: string): RejectedFileEntry[] {
  const rejectedDir = resolveRejectedEvalsDir(dir, repoDir).dir;
  return getRejectedFileEntriesFromDir(rejectedDir);
}

function getRejectedFileEntriesFromDir(rejectedDir: string): RejectedFileEntry[] {
  if (!existsSync(rejectedDir)) {
    return [];
  }

  const names = readdirSync(rejectedDir);
  const entries: RejectedFileEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const path = join(rejectedDir, name);
    try {
      const stats = statSync(path);
      if (stats.isFile()) {
        entries.push({ path, filename: basename(path), mtimeMs: stats.mtimeMs });
      }
    } catch {
      continue;
    }
  }
  return entries;
}
