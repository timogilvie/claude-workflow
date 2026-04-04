import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export interface JsonlTransformOptions {
  dryRun?: boolean;
  backupExtension?: string;
}

export interface JsonlTransformContext {
  index: number;
  originalLine: string;
}

export interface JsonlTransformResult<T> {
  record: T;
  changed: boolean;
}

export interface JsonlTransformSummary {
  recordsProcessed: number;
  recordsChanged: number;
  malformedLines: number;
  fileModified: boolean;
}

/**
 * Read a JSONL file into typed records.
 *
 * Blank lines and malformed JSON entries are skipped.
 */
export function readJsonlFile<T>(path: string): T[] {
  const content = readFileSync(path, 'utf-8');
  const records: T[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed JSONL entries.
    }
  }

  return records;
}

/**
 * Append a JSON-serializable record to a JSONL file using atomic rename.
 */
export function appendJsonlRecord<T>(path: string, record: T): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });

  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const tmpPath = join(directory, `.jsonl-${randomUUID()}.tmp`);
  writeFileSync(tmpPath, `${existing}${JSON.stringify(record)}\n`, 'utf-8');
  renameSync(tmpPath, path);
}

export function readTransformWrite<T>(
  path: string,
  transform: (record: T, context: JsonlTransformContext) => JsonlTransformResult<T>,
  options: JsonlTransformOptions = {},
): JsonlTransformSummary {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n');
  const outputLines: string[] = [];
  let recordsProcessed = 0;
  let recordsChanged = 0;
  let malformedLines = 0;
  let fileModified = false;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let record: T;
    try {
      record = JSON.parse(line) as T;
    } catch {
      malformedLines++;
      outputLines.push(line);
      continue;
    }

    const result = transform(record, {
      index: recordsProcessed,
      originalLine: line,
    });
    recordsProcessed++;

    if (result.changed) {
      recordsChanged++;
      fileModified = true;
      outputLines.push(JSON.stringify(result.record));
    } else {
      outputLines.push(line);
    }
  }

  if (fileModified && !options.dryRun) {
    copyFileSync(path, `${path}${options.backupExtension || '.backup'}`);
    writeFileSync(path, `${outputLines.join('\n')}\n`, 'utf-8');
  }

  return {
    recordsProcessed,
    recordsChanged,
    malformedLines,
    fileModified,
  };
}
