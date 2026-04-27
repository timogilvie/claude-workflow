import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvalRecord } from './eval-schema.ts';
import {
  createEvalBackup,
  deduplicateEvalRecords,
  formatDuplicateReport,
} from './eval-deduplication.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

function makeRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'record-1',
    schemaVersion: '1.0.0',
    originalPrompt: 'prompt',
    modelId: 'claude-opus-4-6',
    modelVersion: 'version',
    score: 1,
    scoreBand: 'Full Success',
    timeSeconds: 1,
    timestamp: '2026-03-01T00:00:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    ...overrides,
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'eval-dedup-'));
}

console.log('\n--- eval-deduplication tests ---\n');

test('deduplicateEvalRecords keeps earliest record per issue/pr pair', () => {
  const result = deduplicateEvalRecords([
    makeRecord({ id: 'a', issueId: 'HOK-1', prUrl: 'https://x/pull/1', timestamp: '2026-03-02T00:00:00Z' }),
    makeRecord({ id: 'b', issueId: 'HOK-1', prUrl: 'https://x/pull/1', timestamp: '2026-03-01T00:00:00Z' }),
    makeRecord({ id: 'c', issueId: 'HOK-2', prUrl: 'https://x/pull/2', timestamp: '2026-03-03T00:00:00Z' }),
  ]);

  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.deduplicatedRecords.length, 2);
  assert.equal(result.deduplicatedRecords.find((record) => record.issueId === 'HOK-1')?.id, 'b');
});

test('deduplicateEvalRecords prefers richer rubric provenance over earlier timestamp', () => {
  const result = deduplicateEvalRecords([
    makeRecord({
      id: 'legacy',
      issueId: 'HOK-1',
      prUrl: 'https://x/pull/1',
      timestamp: '2026-03-01T00:00:00Z',
      rubric_provenance: 'legacy_absent',
    }),
    makeRecord({
      id: 'judge',
      issueId: 'HOK-1',
      prUrl: 'https://x/pull/1',
      timestamp: '2026-03-02T00:00:00Z',
      rubric_provenance: 'judge',
    }),
  ]);

  assert.equal(result.deduplicatedRecords[0]?.id, 'judge');
});

test('formatDuplicateReport summarizes duplicate groups', () => {
  const result = deduplicateEvalRecords([
    makeRecord({ id: 'a', issueId: 'HOK-1', prUrl: 'https://x/pull/42', timestamp: '2026-03-02T00:00:00Z' }),
    makeRecord({ id: 'b', issueId: 'HOK-1', prUrl: 'https://x/pull/42', timestamp: '2026-03-01T00:00:00Z' }),
  ]);

  const output = formatDuplicateReport(result);
  assert.match(output, /HOK-1 \+ 42/);
  assert.match(output, /keeping b/);
});

test('createEvalBackup uses timestamp-safe suffixes', () => {
  const tempDir = makeTempDir();
  try {
    const filePath = join(tempDir, 'evals.jsonl');
    writeFileSync(filePath, '{"id":"x"}\n', 'utf-8');

    const backupPath = createEvalBackup(filePath, new Date('2026-03-09T10:11:12Z'));
    assert.match(backupPath, /\.backup-2026-03-09T10-11-12Z$/);
    assert.equal(existsSync(backupPath), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
});
