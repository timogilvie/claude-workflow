import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { logLinearUpdateError } from './linear-update-error-log.ts';

test('logLinearUpdateError writes JSONL entry with expected fields', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'linear-update-log-'));

  try {
    const error = new Error('Request failed with status 413');
    Object.assign(error, { status: 413 });

    const logPath = logLinearUpdateError(repoPath, 'HOK-1181', error, 50_000);
    const content = readFileSync(logPath, 'utf8').trim();
    const entry = JSON.parse(content) as Record<string, unknown>;

    assert.equal(entry.issueId, 'HOK-1181');
    assert.equal(entry.error, 'Request failed with status 413');
    assert.equal(entry.errorCode, 413);
    assert.equal(entry.payloadSizeChars, 50_000);
    assert.equal(entry.method, 'updateIssue');
    assert.match(String(entry.timestamp), /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(typeof entry.stack === 'string');
    assert.ok(String(entry.stack).includes('Request failed with status 413'));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('logLinearUpdateError truncates stack and falls back to null errorCode', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'linear-update-log-'));

  try {
    const error = new Error('Network timeout');
    error.stack = 'x'.repeat(800);

    const logPath = logLinearUpdateError(repoPath, 'HOK-1182', error, 123);
    const content = readFileSync(logPath, 'utf8').trim();
    const entry = JSON.parse(content) as Record<string, unknown>;

    assert.equal(entry.errorCode, null);
    assert.equal(String(entry.stack).length, 500);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});
