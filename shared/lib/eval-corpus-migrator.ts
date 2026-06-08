import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { EvalRecord } from './eval-schema.ts';
import { EVAL_ERROR_SEVERITY_ORDER } from './eval-error-codes.ts';
import { getEffectiveRegistry, normalizeReviewerModelId } from './model-registry.ts';
import { validateEvalRecord, type ValidationIssue } from './eval-validator.ts';

export interface EvalCorpusMigratorOptions {
  evalsFile: string;
  quarantineFile: string;
  repoDir?: string;
  dryRun?: boolean;
}

export interface EvalCorpusMigrationSummary {
  inputRecordCount: number;
  unchanged: number;
  fixedInPlace: number;
  quarantined: number;
  conservationTotal: number;
  changed: boolean;
  fixedByReason: Record<string, number>;
  quarantinedByCode: Record<string, number>;
}

function countBy(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

function highestSeverityIssue(issues: ValidationIssue[]): ValidationIssue {
  return [...issues].sort(
    (left, right) =>
      EVAL_ERROR_SEVERITY_ORDER.indexOf(left.code) - EVAL_ERROR_SEVERITY_ORDER.indexOf(right.code),
  )[0];
}

function quarantineReason(issue: ValidationIssue): string {
  return issue.detail ? `${issue.code}:${issue.detail}` : issue.code;
}

function parseJsonlRecords(filePath: string): Array<{ lineNumber: number; record: EvalRecord }> {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const records: Array<{ lineNumber: number; record: EvalRecord }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Malformed JSON in ${filePath}:${index + 1}: ${message}`);
    }

    records.push({
      lineNumber: index + 1,
      record: parsed as EvalRecord,
    });
  }

  return records;
}

function atomicWrite(filePath: string, lines: string[]): void {
  const tmpPath = join(dirname(filePath), `.tmp-${randomUUID()}.jsonl`);
  writeFileSync(tmpPath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf-8');
  renameSync(tmpPath, filePath);
}

function normalizeNegativeCiDurations(record: EvalRecord): { record: EvalRecord; changed: boolean } {
  const checks = record.outcomes?.ci?.checks;
  if (!Array.isArray(checks)) {
    return { record, changed: false };
  }

  let changed = false;
  const normalizedChecks = checks.map((check) => {
    if (
      !check
      || typeof check.durationSeconds !== 'number'
      || !Number.isFinite(check.durationSeconds)
      || check.durationSeconds >= 0
    ) {
      return check;
    }

    changed = true;
    return {
      ...check,
      durationSeconds: 0,
    };
  });

  if (!changed) {
    return { record, changed: false };
  }

  return {
    record: {
      ...record,
      outcomes: {
        ...record.outcomes!,
        ci: {
          ...record.outcomes!.ci!,
          checks: normalizedChecks,
        },
      },
    },
    changed: true,
  };
}

export function migrateEvalCorpus(
  options: EvalCorpusMigratorOptions,
): EvalCorpusMigrationSummary {
  const evalsFile = resolve(options.evalsFile);
  const quarantineFile = resolve(options.quarantineFile);
  const repoDir = options.repoDir;
  const registry = getEffectiveRegistry(repoDir);
  const records = parseJsonlRecords(evalsFile);
  const keptLines: string[] = [];
  const quarantinedLines: string[] = [];
  const fixedByReason: Record<string, number> = {};
  const quarantinedByCode: Record<string, number> = {};
  let unchanged = 0;
  let fixedInPlace = 0;
  let quarantined = 0;

  for (const { lineNumber, record } of records) {
    const beforeReviewer = record.taskDescriptor?.stages?.reviewer?.model;

    let candidate = record;
    if (typeof beforeReviewer === 'string') {
      const normalized = normalizeReviewerModelId(beforeReviewer, registry);
      if (normalized && normalized !== beforeReviewer) {
        candidate = {
          ...record,
          taskDescriptor: {
            ...record.taskDescriptor!,
            stages: {
              ...record.taskDescriptor!.stages,
              reviewer: {
                ...record.taskDescriptor!.stages.reviewer,
                model: normalized,
              },
            },
          },
        };
        countBy(fixedByReason, `reviewer:${beforeReviewer}->${normalized}`);
      }
    }

    const durationNormalization = normalizeNegativeCiDurations(candidate);
    if (durationNormalization.changed) {
      candidate = durationNormalization.record;
      countBy(fixedByReason, 'ci.durationSeconds:negative->0');
    }

    const issuesAfter = validateEvalRecord(candidate, {
      file: evalsFile,
      line: lineNumber,
      repoDir,
    });

    if (issuesAfter.length === 0) {
      keptLines.push(JSON.stringify(candidate));
      if (candidate !== record) {
        fixedInPlace += 1;
      } else {
        unchanged += 1;
      }
      continue;
    }

    const topIssue = highestSeverityIssue(issuesAfter);
    quarantined += 1;
    countBy(quarantinedByCode, topIssue.code);
    quarantinedLines.push(JSON.stringify({
      ...record,
      quarantine_reason: quarantineReason(topIssue),
    }));
  }

  const conservationTotal = unchanged + fixedInPlace + quarantined;
  if (conservationTotal !== records.length) {
    throw new Error(
      `Conservation invariant failed: unchanged(${unchanged}) + fixedInPlace(${fixedInPlace}) + quarantined(${quarantined}) != inputRecordCount(${records.length})`,
    );
  }

  const changed = fixedInPlace > 0 || quarantined > 0;
  if (changed && !options.dryRun) {
    atomicWrite(evalsFile, keptLines);
    atomicWrite(quarantineFile, quarantinedLines);
  }

  return {
    inputRecordCount: records.length,
    unchanged,
    fixedInPlace,
    quarantined,
    conservationTotal,
    changed,
    fixedByReason,
    quarantinedByCode,
  };
}
