import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import {
  countRejectedEvalRecords,
  extractValueAtPath,
  formatIssueValue,
  listRejectedEvalRecords,
  quarantineRejectedEvalRecord,
  REJECTED_EVAL_VALUE_MAX_CHARS,
} from './eval-rejected-store.ts';
import type { ValidationIssue } from './eval-validator.ts';

function makeRecord(overrides?: Partial<EvalRecord>): EvalRecord {
  return {
    id: '550e8400-e29b-41d4-a716-446655440001',
    schemaVersion: '1.0.0',
    originalPrompt: 'Add a logout button',
    modelId: 'claude-opus-4-6',
    modelVersion: 'claude-opus-4-6-20250514',
    score: 1.0,
    scoreBand: 'Full Success',
    timeSeconds: 245,
    timestamp: '2026-02-14T10:30:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Task completed autonomously.',
    issueId: 'HOK-500',
    ...overrides,
  };
}

function makeIssue(detail = 'rubricEval.determinative_boundary'): ValidationIssue {
  return {
    code: 'SCHEMA_VIOLATION',
    detail,
    file: '<inline>',
    line: 0,
    message: 'Schema violation.',
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'eval-rejected-store-test-'));
}

test('extractValueAtPath handles dotted paths and array indices', () => {
  const value = {
    rubricEval: { determinative_boundary: 'bad-boundary' },
    evidence: [{ source: { path: 'first' } }, { source: { path: 'second' } }],
    keyed: { 'has.dot': 'literal' },
  };

  assert.equal(extractValueAtPath(value, 'rubricEval.determinative_boundary'), 'bad-boundary');
  assert.equal(extractValueAtPath(value, 'evidence[1].source.path'), 'second');
  assert.equal(extractValueAtPath(value, 'keyed["has.dot"]'), 'literal');
  assert.equal(extractValueAtPath(value, 'missing.value'), undefined);
  assert.equal(extractValueAtPath(value, 'evidence['), undefined);
  assert.equal(extractValueAtPath(value, 'rubricEval.determinative_boundary: must be enum'), 'bad-boundary');
});

test('formatIssueValue serializes primitives, objects, missing values, and circular values', () => {
  assert.equal(formatIssueValue('bad-boundary'), '"bad-boundary"');
  assert.equal(formatIssueValue(undefined), '<undefined>');
  assert.equal(formatIssueValue({ ok: true }), '{"ok":true}');

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(formatIssueValue(circular), '[unserializable:object]');
});

test('formatIssueValue redacts and truncates values', () => {
  assert.equal(formatIssueValue({ token: 'super-secret-token' }), '{"token":"[REDACTED]"}');
  assert.match(formatIssueValue('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'), /\[REDACTED:bearer_token\]/);
  const long = formatIssueValue('x'.repeat(REJECTED_EVAL_VALUE_MAX_CHARS + 50));
  assert.equal(long.length, REJECTED_EVAL_VALUE_MAX_CHARS);
  assert.ok(long.endsWith('...'));
});

test('quarantineRejectedEvalRecord writes payload and prunes oldest files by filename', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  const rejectedDir = join(evalsDir, 'rejected');
  try {
    mkdirSync(rejectedDir, { recursive: true });
    writeFileSync(join(rejectedDir, '2026-01-01T00-00-00-000Z-old-primary.json'), '{}\n');
    writeFileSync(join(rejectedDir, '2026-01-02T00-00-00-000Z-middle-primary.json'), '{}\n');

    const record = makeRecord({
      issueId: 'HOK-900',
      rubricEval: { determinative_boundary: 'bad-boundary' } as never,
    });
    const issues = [{ ...makeIssue(), value: '"bad-boundary"' }];
    const path = quarantineRejectedEvalRecord({ record, issues, dir: evalsDir, retention: 2 });

    assert.ok(path);
    assert.equal(countRejectedEvalRecords(undefined, evalsDir), 2);
    assert.equal(listRejectedEvalRecords(undefined, { dir: evalsDir }).some((file) => file.endsWith('old-primary.json')), false);
    const payload = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(payload.reason, 'write_time_validation');
    assert.equal(payload.record.id, record.id);
    assert.deepEqual(payload.issues, issues);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('count/list return empty results for missing directories and ignore non-json files', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    assert.equal(countRejectedEvalRecords(undefined, evalsDir), 0);
    assert.deepEqual(listRejectedEvalRecords(undefined, { dir: evalsDir }), []);

    const rejectedDir = join(evalsDir, 'rejected');
    mkdirSync(rejectedDir, { recursive: true });
    writeFileSync(join(rejectedDir, 'ignored.txt'), 'not json');
    writeFileSync(join(rejectedDir, 'kept.json'), '{}\n');
    assert.equal(countRejectedEvalRecords(undefined, evalsDir), 1);
    assert.deepEqual(listRejectedEvalRecords(undefined, { dir: evalsDir }).map((path) => path.endsWith('kept.json')), [true]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
