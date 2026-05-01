import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { SCHEMA_VERSION } from './eval-schema.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import {
  EVAL_ERROR_CODES,
  EVAL_ERROR_SEVERITY_ORDER,
  type EvalErrorCode,
} from './eval-error-codes.ts';

const require = createRequire(import.meta.url);
const Ajv2020 =
  require('ajv/dist/2020').default || require('ajv/dist/2020');
const evalSchema = require('./eval-schema.json');
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
const validateSchema = ajv.compile(evalSchema) as (value: unknown) => boolean;

const REQUIRED_FIELDS = [
  'id',
  'schemaVersion',
  'originalPrompt',
  'modelId',
  'modelVersion',
  'score',
  'scoreBand',
  'timeSeconds',
  'timestamp',
  'interventionRequired',
  'interventionCount',
  'interventionDetails',
  'rationale',
] as const;

const TRAINING_REQUIRED_FIELDS = ['modelId', 'modelVersion', 'timestamp'] as const;

export interface ValidationIssue {
  code: EvalErrorCode;
  detail?: string;
  file: string;
  line: number;
  recordId?: string;
  message: string;
}

export interface ValidationReport {
  totalLines: number;
  validRecords: number;
  issues: ValidationIssue[];
  countsByCode: Record<string, number>;
  files: string[];
}

interface ValidationLocation {
  file: string;
  line: number;
}

function makeIssue(
  code: EvalErrorCode,
  location: ValidationLocation,
  detail?: string,
  recordId?: string,
): ValidationIssue {
  return {
    code,
    detail,
    file: location.file,
    line: location.line,
    ...(recordId ? { recordId } : {}),
    message: EVAL_ERROR_CODES[code].message,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecordId(record: Record<string, unknown>): string | undefined {
  return typeof record.id === 'string' && record.id.trim().length > 0
    ? record.id
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function compareSemver(a: string, b: string): number {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const delta = (aParts[index] || 0) - (bParts[index] || 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function toDetail(instancePath: string, missingProperty?: string): string | undefined {
  if (missingProperty) {
    return missingProperty;
  }

  const cleaned = instancePath.replace(/^\//, '').replace(/\//g, '.');
  return cleaned || undefined;
}

function isKnownSchemaVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

function buildCounts(issues: ValidationIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.code] = (counts[issue.code] || 0) + 1;
  }
  return counts;
}

export function validateEvalRecord(
  record: unknown,
  opts: ValidationLocation,
): ValidationIssue[] {
  if (!isPlainObject(record)) {
    return [makeIssue('NOT_AN_OBJECT', opts)];
  }

  const issues: ValidationIssue[] = [];
  const recordId = getRecordId(record);

  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) {
      issues.push(makeIssue('MISSING_REQUIRED_FIELD', opts, field, recordId));
    }
  }

  if (!validateSchema(record)) {
    for (const error of validateSchema.errors || []) {
      if (error.keyword === 'required') {
        continue;
      }
      const detail = toDetail(
        error.instancePath || '',
        typeof error.params?.missingProperty === 'string'
          ? error.params.missingProperty
          : undefined,
      );
      issues.push(makeIssue('SCHEMA_VIOLATION', opts, detail, recordId));
    }
  }

  if (isKnownSchemaVersion(record.schemaVersion) && compareSemver(record.schemaVersion, SCHEMA_VERSION) > 0) {
    issues.push(makeIssue('UNKNOWN_SCHEMA_VERSION', opts, 'schemaVersion', recordId));
  }

  if (
    record.score === null ||
    !isNonEmptyString(record.rationale)
  ) {
    issues.push(makeIssue('INELIGIBLE_REWARD_NO_JUDGE', opts, 'rationale', recordId));
  }

  if (!TRAINING_REQUIRED_FIELDS.every((field) => isNonEmptyString(record[field]))) {
    issues.push(
      makeIssue(
        'INELIGIBLE_TRAINING_INCOMPLETE_RUN',
        opts,
        TRAINING_REQUIRED_FIELDS.filter((field) => !isNonEmptyString(record[field])).join(','),
        recordId,
      ),
    );
  }

  return issues;
}

export function deriveNonRewardReasonFromIssues(
  issues: ValidationIssue[],
): { code: string; message: string } | null {
  if (issues.length === 0) {
    return null;
  }

  const highestSeverity = [...issues].sort(
    (a, b) =>
      EVAL_ERROR_SEVERITY_ORDER.indexOf(a.code) - EVAL_ERROR_SEVERITY_ORDER.indexOf(b.code),
  )[0];

  return {
    code: highestSeverity.code,
    message: highestSeverity.message,
  };
}

export async function validateEvalsFile(filePath: string): Promise<ValidationReport> {
  const resolvedPath = resolve(filePath);
  try {
    await stat(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to validate evals file ${resolvedPath}: ${message}`);
  }

  const issues: ValidationIssue[] = [];
  let totalLines = 0;
  let validRecords = 0;

  const rl = createInterface({
    input: createReadStream(resolvedPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const lineText of rl) {
    totalLines += 1;

    if (!lineText.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(lineText);
    } catch {
      issues.push(makeIssue('MALFORMED_JSON', { file: resolvedPath, line: totalLines }));
      continue;
    }

    const lineIssues = validateEvalRecord(parsed, {
      file: resolvedPath,
      line: totalLines,
    });
    issues.push(...lineIssues);
    if (lineIssues.length === 0) {
      validRecords += 1;
    }
  }

  issues.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));

  return {
    totalLines,
    validRecords,
    issues,
    countsByCode: buildCounts(issues),
    files: [resolvedPath],
  };
}

export async function validateEvalsStore(repoDir?: string): Promise<ValidationReport> {
  const evalsDir = resolveEvalsDir(undefined, repoDir).dir;
  const filePath = join(evalsDir, 'evals.jsonl');

  if (!existsSync(evalsDir) || !existsSync(filePath)) {
    return {
      totalLines: 0,
      validRecords: 0,
      issues: [],
      countsByCode: {},
      files: [filePath],
    };
  }

  return validateEvalsFile(filePath);
}
