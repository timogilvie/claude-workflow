/**
 * Operator intervention artifacts.
 *
 * Provides a supported JSON contract for operator-recorded recovery work that
 * does not necessarily leave a PR comment, commit, or Claude transcript.
 *
 * @module operator-intervention
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { loadWavemillConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';

export const OPERATOR_INTERVENTION_FILENAME = '.operator-intervention.json';
export const OPERATOR_INTERVENTION_ARCHIVE_FILENAME = 'operator-intervention.json';
export const OPERATOR_INTERVENTION_SCHEMA_VERSION = '1.0';

export type OperatorInterventionSeverity = 'minor' | 'major';
export type OperatorInterventionStage = 'routing' | 'planning' | 'coding' | 'review' | 'ready';

export interface OperatorInterventionRecord {
  schemaVersion: string;
  type: 'operator_recovery';
  severity: OperatorInterventionSeverity;
  occurredAt: string;
  issue?: string;
  stage?: OperatorInterventionStage;
  attempt?: number;
  trigger?: string;
  summary?: string;
  actionsTaken?: string[];
  codeWrittenByOperator?: boolean;
  scoringNote?: string;
  operator?: string;
  relatedCommit?: string;
  challengePairId?: string;
  [key: string]: unknown;
}

export interface BuildOperatorInterventionInput {
  severity: OperatorInterventionSeverity;
  trigger: string;
  summary: string;
  occurredAt?: string;
  issue?: string;
  stage?: OperatorInterventionStage;
  attempt?: number;
  actionsTaken?: string[];
  codeWrittenByOperator?: boolean;
  scoringNote?: string;
  operator?: string;
  relatedCommit?: string;
  challengePairId?: string;
}

export interface OperatorInterventionTarget {
  featureDir: string;
  searched: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function warn(message: string): void {
  console.warn(`[operator-intervention] ${message}`);
}

function readJson(path: string): unknown | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch (err) {
    warn(`Failed to read ${path}: ${errorMessage(err)}`);
    return undefined;
  }
}

function normalizeRecord(value: unknown, source: string, fallbackOccurredAt?: string): OperatorInterventionRecord | undefined {
  if (!isRecord(value)) {
    warn(`Skipping non-object record in ${source}`);
    return undefined;
  }

  const type = typeof value.type === 'string' ? value.type : 'operator_recovery';
  if (type !== 'operator_recovery') {
    warn(`Skipping unsupported intervention type '${type}' in ${source}`);
    return undefined;
  }

  if (value.severity !== 'minor' && value.severity !== 'major') {
    warn(`Skipping operator intervention without valid severity in ${source}`);
    return undefined;
  }

  const occurredAt =
    typeof value.occurredAt === 'string' && value.occurredAt.trim()
      ? value.occurredAt
      : fallbackOccurredAt ?? new Date().toISOString();

  const record: OperatorInterventionRecord = {
    ...value,
    schemaVersion: typeof value.schemaVersion === 'string' ? value.schemaVersion : OPERATOR_INTERVENTION_SCHEMA_VERSION,
    type: 'operator_recovery',
    severity: value.severity,
    occurredAt,
  };

  if (typeof value.attempt === 'number' && Number.isFinite(value.attempt)) {
    record.attempt = value.attempt;
  } else {
    delete record.attempt;
  }

  if (Array.isArray(value.actionsTaken)) {
    record.actionsTaken = value.actionsTaken.filter((entry): entry is string => typeof entry === 'string');
  }

  return record;
}

/** Parse a raw operator intervention object or array, skipping invalid entries. */
export function parseOperatorInterventions(raw: unknown, source = 'operator intervention'): OperatorInterventionRecord[] {
  const fallbackOccurredAt = (() => {
    try {
      if (existsSync(source)) return statSync(source).mtime.toISOString();
    } catch {
      return undefined;
    }
    return undefined;
  })();
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map((entry) => normalizeRecord(entry, source, fallbackOccurredAt))
    .filter((entry): entry is OperatorInterventionRecord => Boolean(entry));
}

/** Read operator interventions from a feature directory or direct JSON path. */
export function readOperatorInterventions(pathOrDir: string): OperatorInterventionRecord[] {
  const path = pathOrDir.endsWith('.json')
    ? pathOrDir
    : join(pathOrDir, OPERATOR_INTERVENTION_FILENAME);
  const raw = readJson(path);
  return raw === undefined ? [] : parseOperatorInterventions(raw, path);
}

/** Build a normalized operator intervention record with schema defaults. */
export function buildOperatorInterventionRecord(input: BuildOperatorInterventionInput): OperatorInterventionRecord {
  return {
    schemaVersion: OPERATOR_INTERVENTION_SCHEMA_VERSION,
    type: 'operator_recovery',
    severity: input.severity,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    trigger: input.trigger,
    summary: input.summary,
    ...(input.issue ? { issue: input.issue } : {}),
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.actionsTaken?.length ? { actionsTaken: input.actionsTaken } : {}),
    ...(input.codeWrittenByOperator !== undefined ? { codeWrittenByOperator: input.codeWrittenByOperator } : {}),
    ...(input.scoringNote ? { scoringNote: input.scoringNote } : {}),
    ...(input.operator ? { operator: input.operator } : {}),
    ...(input.relatedCommit ? { relatedCommit: input.relatedCommit } : {}),
    ...(input.challengePairId ? { challengePairId: input.challengePairId } : {}),
  };
}

/** Write an intervention artifact atomically, appending by default. */
export function writeOperatorIntervention(
  featureDir: string,
  record: OperatorInterventionRecord,
  options: { append?: boolean } = {},
): string {
  mkdirSync(featureDir, { recursive: true });
  const path = join(featureDir, OPERATOR_INTERVENTION_FILENAME);
  let content: OperatorInterventionRecord | OperatorInterventionRecord[] = record;

  if (options.append !== false && existsSync(path)) {
    const existing = readOperatorInterventions(path);
    content = existing.length > 0 ? [...existing, record] : record;
  }

  const tmpPath = join(featureDir, `.tmp-operator-intervention-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmpPath, `${JSON.stringify(content, null, 2)}\n`);
  renameSync(tmpPath, path);
  return path;
}

function maybeFeatureDir(path: string): boolean {
  if (!existsSync(path)) return false;
  if (existsSync(join(path, 'selected-task.json'))) return true;
  const parent = basename(dirname(path));
  return parent === 'features' || parent === 'bugs';
}

function scanIssueMatch(dir: string, issue: string): string | undefined {
  try {
    if (!existsSync(dir)) return undefined;
    for (const slug of readdirSync(dir)) {
      const featureDir = join(dir, slug);
      const selected = readJson(join(featureDir, 'selected-task.json'));
      if (isRecord(selected) && selected.taskId === issue) return featureDir;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Resolve a CLI target to a feature/bug directory and report searched paths. */
export function resolveOperatorInterventionTarget(target: string, repoDir = process.cwd()): OperatorInterventionTarget {
  const root = resolve(repoDir);
  const searched: string[] = [];
  const direct = isAbsolute(target) ? target : resolve(root, target);

  searched.push(direct);
  if (maybeFeatureDir(direct) && existsSync(direct)) return { featureDir: direct, searched };

  const configuredRoot = loadWavemillConfig(root).mill?.worktreeRoot;
  const worktreeRoots = [configuredRoot, 'worktrees'].filter((value): value is string => Boolean(value));
  const candidates: string[] = [];

  for (const kind of ['features', 'bugs']) {
    candidates.push(join(root, kind, target));
  }
  for (const worktreeRoot of worktreeRoots) {
    for (const kind of ['features', 'bugs']) {
      candidates.push(join(resolve(root, worktreeRoot), target, kind, target));
    }
  }

  for (const candidate of candidates) {
    searched.push(candidate);
    if (existsSync(candidate)) return { featureDir: candidate, searched };
  }

  const issueRoots = [join(root, 'features'), join(root, 'bugs')];
  for (const worktreeRoot of worktreeRoots) {
    const resolvedRoot = resolve(root, worktreeRoot);
    searched.push(resolvedRoot);
    try {
      if (!existsSync(resolvedRoot)) continue;
      for (const child of readdirSync(resolvedRoot)) {
        issueRoots.push(join(resolvedRoot, child, 'features'), join(resolvedRoot, child, 'bugs'));
      }
    } catch {
      continue;
    }
  }
  for (const issueRoot of issueRoots) {
    searched.push(issueRoot);
    const match = scanIssueMatch(issueRoot, target);
    if (match) return { featureDir: match, searched };
  }

  throw new Error(`Could not resolve intervention target '${target}'. Searched:\n${searched.map((p) => `  - ${p}`).join('\n')}`);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

/** Format a compact event detail for eval records and judge prompts. */
export function formatOperatorInterventionDetail(record: OperatorInterventionRecord): string {
  const parts = [
    `severity=${record.severity}`,
    record.stage ? `stage=${record.stage}` : '',
    record.attempt !== undefined ? `attempt=${record.attempt}` : '',
    record.trigger ? `trigger=${record.trigger}` : '',
    record.summary ? `summary=${record.summary}` : '',
    record.codeWrittenByOperator ? 'codeWrittenByOperator=true' : '',
    record.scoringNote ? `scoringNote=${record.scoringNote}` : '',
  ].filter(Boolean);
  return truncate(parts.join('; '), 500);
}
