import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIR = join('.wavemill', 'logs');
const LOG_FILE = 'linear-update-errors.jsonl';
const MAX_STACK_CHARS = 500;

interface LinearUpdateErrorLogEntry {
  timestamp: string;
  issueId: string;
  error: string;
  errorCode: number | string | null;
  payloadSizeChars: number;
  method: 'updateIssue';
  stack: string | null;
}

export function logLinearUpdateError(
  repoPath: string,
  issueId: string,
  error: unknown,
  payloadSizeChars: number,
): string {
  const logDir = join(repoPath, LOG_DIR);
  const logPath = join(logDir, LOG_FILE);
  const entry: LinearUpdateErrorLogEntry = {
    timestamp: new Date().toISOString(),
    issueId,
    error: errorMessage(error),
    errorCode: extractErrorCode(error),
    payloadSizeChars,
    method: 'updateIssue',
    stack: truncateStack(error),
  };

  mkdirSync(logDir, { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return logPath;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

function truncateStack(error: unknown): string | null {
  if (!(error instanceof Error) || typeof error.stack !== 'string') {
    return null;
  }
  return error.stack.slice(0, MAX_STACK_CHARS);
}

function extractErrorCode(error: unknown): number | string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const record = error as Record<string, unknown>;

  for (const key of ['status', 'statusCode', 'code']) {
    const value = record[key];
    if (typeof value === 'number' || typeof value === 'string') {
      return value;
    }
  }

  const cause = record.cause;
  if (cause && typeof cause === 'object') {
    const causeRecord = cause as Record<string, unknown>;
    for (const key of ['status', 'statusCode', 'code']) {
      const value = causeRecord[key];
      if (typeof value === 'number' || typeof value === 'string') {
        return value;
      }
    }
  }

  return null;
}
