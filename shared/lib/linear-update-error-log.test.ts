import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { logLinearUpdateError, logValidationWarning } from './linear-update-error-log.ts';
import type { ValidationIssue } from './task-packet-validator.ts';

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

test('logValidationWarning writes JSONL entry with expected fields', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'linear-validation-log-'));
  const issues: ValidationIssue[] = [
    {
      type: 'boilerplate-validation',
      severity: 'warning',
      section: 'Validation Steps',
      description: 'Validation steps are missing concrete commands',
      suggestedFix: 'Add repo-specific validation commands',
    },
  ];

  try {
    const logPath = logValidationWarning(
      repoPath,
      'HOK-1186',
      issues,
      'non-interactive',
      'proceeded',
    );

    assert.ok(logPath);

    const content = readFileSync(String(logPath), 'utf8').trim();
    const entry = JSON.parse(content) as Record<string, unknown>;
    const warnings = entry.warnings as Array<Record<string, unknown>>;

    assert.equal(entry.issueId, 'HOK-1186');
    assert.equal(entry.mode, 'non-interactive');
    assert.equal(entry.action, 'proceeded');
    assert.match(String(entry.timestamp), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], {
      type: 'boilerplate-validation',
      severity: 'warning',
      section: 'Validation Steps',
      description: 'Validation steps are missing concrete commands',
    });
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('logValidationWarning handles logging failures gracefully', () => {
  const issues: ValidationIssue[] = [
    {
      type: 'missing-requirement',
      severity: 'error',
      section: 'Scope',
      description: 'A required section is missing',
      suggestedFix: 'Restore the missing requirement',
    },
  ];

  const warnMessages: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnMessages.push(String(message));
  };

  try {
    const logPath = logValidationWarning('/dev/null', 'HOK-1186', issues, 'interactive', 'cancelled');
    assert.equal(logPath, null);
    assert.equal(warnMessages.length, 1);
    assert.match(warnMessages[0], /Failed to log validation warnings/);
  } finally {
    console.warn = originalWarn;
  }
});
