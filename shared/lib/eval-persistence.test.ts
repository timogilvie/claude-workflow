/**
 * Unit tests for eval-persistence — append, read, and query functions.
 *
 * Uses temp directories for file I/O and cleans up after each test.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvalRecord } from './eval-schema.ts';
import { enrichEvalRecord } from './eval-record-builder.ts';
import { appendEvalRecord, EvalValidationError, hasChallengeEvalRecord, hasChallengeEvalRecordPair, readEvalRecords } from './eval-persistence.ts';

// ────────────────────────────────────────────────────────────────
// Test Harness
// ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

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
    prUrl: 'https://github.com/org/repo/pull/42',
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 1,
          repo_size_loc: 100,
          description_tokens: 10,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
        learned: {
          complexity: 3,
          domain: 'backend',
          risk_flags: [],
        },
      },
      constraints: {
        models_available: ['claude-opus-4-6'],
        objective: 'balanced',
      },
      stages: {},
    },
    ...overrides,
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'eval-persist-test-'));
}

function cleanUp(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────
// Append Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Append Tests ---\n');

test('append creates directory and file if they do not exist', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'nested', 'evals');
  try {
    appendEvalRecord(makeRecord(), { dir: evalsDir });
    const content = readFileSync(join(evalsDir, 'evals.jsonl'), 'utf-8');
    assert.ok(content.length > 0);
  } finally {
    cleanUp(tmp);
  }
});

test('append writes a valid JSONL line', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    const record = makeRecord();
    appendEvalRecord(record, { dir: evalsDir });
    const content = readFileSync(join(evalsDir, 'evals.jsonl'), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.id, record.id);
    assert.equal(parsed.score, record.score);
    assert.equal(parsed.modelId, record.modelId);
  } finally {
    cleanUp(tmp);
  }
});

test('multiple appends produce multiple lines', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'id-1', score: 0.5 }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'id-2', score: 0.8 }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'id-3', score: 1.0 }), { dir: evalsDir });

    const content = readFileSync(join(evalsDir, 'evals.jsonl'), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 3);

    const ids = lines.map((l) => JSON.parse(l).id);
    assert.deepEqual(ids, ['id-1', 'id-2', 'id-3']);
  } finally {
    cleanUp(tmp);
  }
});

test('append rejects records that fail write-time validation', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    assert.throws(
      () => appendEvalRecord(makeRecord({ taskDescriptor: undefined }), { dir: evalsDir }),
      (error) => error instanceof EvalValidationError
        && error.issues.some((issue) => issue.code === 'EVAL_MISSING_TASK_DESCRIPTOR'),
    );
  } finally {
    cleanUp(tmp);
  }
});

test('append skipValidation bypasses the write-time gate for fixtures', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ taskDescriptor: undefined }), {
      dir: evalsDir,
      skipValidation: true,
    });
    const records = readEvalRecords({ dir: evalsDir });
    assert.equal(records.length, 1);
  } finally {
    cleanUp(tmp);
  }
});

test('append succeeds after invalid optional rubric boundary is normalized away', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    const record = makeRecord();
    enrichEvalRecord(record, {
      rubricEval: {
        schema_version: '1.0',
        rubric_version: '1.0',
        criteria: {
          completeness: { score: 0.8, rationale: 'Complete enough.' },
          correctness: { score: 0.8, rationale: 'Correct enough.' },
          code_quality: { score: 0.8, rationale: 'Clean enough.' },
          intervention_impact: { score: 0.8, rationale: 'Low intervention.' },
          autonomy: { score: 0.8, rationale: 'Mostly autonomous.' },
        },
        determinative_boundary: 'invalid_boundary' as never,
      },
    });

    appendEvalRecord(record, { dir: evalsDir });
    const [saved] = readEvalRecords({ dir: evalsDir });
    assert.equal(saved.rubricEval?.determinative_boundary, undefined);
  } finally {
    cleanUp(tmp);
  }
});

test('challenge record with challengeSide/challengeIntent/challengeExecutionRoute/challengeExecutionEvidence persists (HOK-2598 regression)', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    const expectedRoute = {
      planner: 'claude-opus-4-6',
      coder: 'gpt-5.4',
      reviewer: 'claude-opus-4-6',
      planDepth: 'deep',
      codeDepth: 'medium',
      reviewMode: 'llm',
    };
    const record = makeRecord({
      challengePairId: 'HOK-2581',
      challengeSide: 'challenger',
      challengeIntent: {
        pairId: 'HOK-2581',
        challengeStage: 'implementation',
        primary: {
          pairId: 'HOK-2581',
          side: 'primary',
          challengeStage: 'implementation',
          expectedStageModel: 'claude-sonnet-5',
          expectedRoute: { ...expectedRoute, coder: 'claude-sonnet-5' },
        },
        challenger: {
          pairId: 'HOK-2581',
          side: 'challenger',
          challengeStage: 'implementation',
          expectedStageModel: 'gpt-5.4',
          expectedRoute,
        },
      },
      challengeExecutionRoute: expectedRoute,
      challengeExecutionEvidence: {
        pairId: 'HOK-2581',
        side: 'challenger',
        validity: 'valid',
        challengeStage: 'implementation',
        expectedStageModel: 'gpt-5.4',
        evidence: [{ stage: 'implementation', model: 'gpt-5.4', source: 'eval.modelId' }],
      },
    });

    appendEvalRecord(record, { dir: evalsDir });

    const [saved] = readEvalRecords({ dir: evalsDir });
    assert.equal(saved.challengeSide, 'challenger');
    assert.deepEqual(saved.challengeExecutionRoute, expectedRoute);
    assert.equal(saved.challengeExecutionEvidence?.validity, 'valid');
  } finally {
    cleanUp(tmp);
  }
});

test('retry after a schema-rejected write persists exactly one record, not a duplicate (HOK-2598)', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    const invalidRecord = {
      ...makeRecord({ challengePairId: 'HOK-2581', challengeSide: 'challenger' }),
      challengeExecutionRoute: 'not-an-object' as unknown,
    };

    assert.throws(
      () => appendEvalRecord(invalidRecord as EvalRecord, { dir: evalsDir }),
      (error) => error instanceof EvalValidationError
        && error.issues.some((issue) => issue.code === 'SCHEMA_VIOLATION'),
    );
    assert.deepEqual(readEvalRecords({ dir: evalsDir }), []);

    const validRecord = makeRecord({
      challengePairId: 'HOK-2581',
      challengeSide: 'challenger',
      challengeExecutionRoute: {
        planner: 'claude-opus-4-6',
        coder: 'gpt-5.4',
        reviewer: 'claude-opus-4-6',
        planDepth: 'deep',
        codeDepth: 'medium',
        reviewMode: 'llm',
      },
    });
    appendEvalRecord(validRecord, { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir });
    assert.equal(records.length, 1);
    assert.equal(records[0].challengeSide, 'challenger');
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Read Tests — No Filters
// ────────────────────────────────────────────────────────────────

console.log('\n--- Read Tests ---\n');

test('read with no filters returns all records', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2' }), { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir });
    assert.equal(records.length, 2);
    assert.equal(records[0].id, 'r1');
    assert.equal(records[1].id, 'r2');
  } finally {
    cleanUp(tmp);
  }
});

test('read on missing file returns empty array', () => {
  const tmp = makeTempDir();
  try {
    const records = readEvalRecords({ dir: join(tmp, 'nonexistent') });
    assert.deepEqual(records, []);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Read Tests — Filters
// ────────────────────────────────────────────────────────────────

console.log('\n--- Filter Tests ---\n');

test('filter by model returns only matching records', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1', modelId: 'claude-opus-4-6' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2', modelId: 'claude-sonnet-4-5' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r3', modelId: 'claude-opus-4-6' }), { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir, model: 'claude-opus-4-6' });
    assert.equal(records.length, 2);
    assert.equal(records[0].id, 'r1');
    assert.equal(records[1].id, 'r3');
  } finally {
    cleanUp(tmp);
  }
});

test('filter by date range returns only records in range', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1', timestamp: '2026-01-15T00:00:00Z' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2', timestamp: '2026-02-10T00:00:00Z' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r3', timestamp: '2026-03-05T00:00:00Z' }), { dir: evalsDir });

    const records = readEvalRecords({
      dir: evalsDir,
      after: new Date('2026-02-01'),
      before: new Date('2026-02-28'),
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'r2');
  } finally {
    cleanUp(tmp);
  }
});

test('filter by minScore returns only records >= threshold', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1', score: 0.3, scoreBand: 'Partial' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2', score: 0.8, scoreBand: 'Minor Feedback' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r3', score: 1.0, scoreBand: 'Full Success' }), { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir, minScore: 0.8 });
    assert.equal(records.length, 2);
    assert.equal(records[0].id, 'r2');
    assert.equal(records[1].id, 'r3');
  } finally {
    cleanUp(tmp);
  }
});

test('filter by maxScore returns only records <= threshold', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1', score: 0.3, scoreBand: 'Partial' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2', score: 0.8, scoreBand: 'Minor Feedback' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r3', score: 1.0, scoreBand: 'Full Success' }), { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir, maxScore: 0.5 });
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'r1');
  } finally {
    cleanUp(tmp);
  }
});

test('combined filters work together', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({ id: 'r1', modelId: 'claude-opus-4-6', score: 0.9, scoreBand: 'Minor Feedback', timestamp: '2026-02-10T00:00:00Z' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r2', modelId: 'claude-opus-4-6', score: 0.3, scoreBand: 'Partial', timestamp: '2026-02-10T00:00:00Z' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r3', modelId: 'claude-sonnet-4-5', score: 0.9, scoreBand: 'Minor Feedback', timestamp: '2026-02-10T00:00:00Z' }), { dir: evalsDir });
    appendEvalRecord(makeRecord({ id: 'r4', modelId: 'claude-opus-4-6', score: 0.9, scoreBand: 'Minor Feedback', timestamp: '2026-01-05T00:00:00Z' }), { dir: evalsDir });

    const records = readEvalRecords({
      dir: evalsDir,
      model: 'claude-opus-4-6',
      minScore: 0.8,
      after: new Date('2026-02-01'),
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'r1');
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Malformed Line Handling
// ────────────────────────────────────────────────────────────────

console.log('\n--- Malformed Line Tests ---\n');

test('malformed lines are skipped gracefully', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  mkdirSync(evalsDir, { recursive: true });
  try {
    const validRecord = makeRecord({ id: 'valid-1' });
    const content = [
      JSON.stringify(validRecord),
      'this is not valid json',
      '{"incomplete": true',
      JSON.stringify(makeRecord({ id: 'valid-2' })),
    ].join('\n') + '\n';

    writeFileSync(join(evalsDir, 'evals.jsonl'), content, 'utf-8');

    const records = readEvalRecords({ dir: evalsDir });
    assert.equal(records.length, 2);
    assert.equal(records[0].id, 'valid-1');
    assert.equal(records[1].id, 'valid-2');
  } finally {
    cleanUp(tmp);
  }
});

test('empty file returns empty array', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  mkdirSync(evalsDir, { recursive: true });
  try {
    writeFileSync(join(evalsDir, 'evals.jsonl'), '', 'utf-8');
    const records = readEvalRecords({ dir: evalsDir });
    assert.deepEqual(records, []);
  } finally {
    cleanUp(tmp);
  }
});

console.log('\n--- Challenge Record Tests ---\n');

test('hasChallengeEvalRecord finds a persisted challenge eval by pair and PR URL', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({
      id: 'challenge-1',
      challengePairId: 'pair-123',
      prUrl: 'https://github.com/org/repo/pull/10',
    }), { dir: evalsDir });

    assert.equal(
      hasChallengeEvalRecord('pair-123', 'https://github.com/org/repo/pull/10', { dir: evalsDir }),
      true,
    );
    assert.equal(
      hasChallengeEvalRecord('pair-123', 'https://github.com/org/repo/pull/11', { dir: evalsDir }),
      false,
    );
  } finally {
    cleanUp(tmp);
  }
});

test('hasChallengeEvalRecordPair requires both challenge eval records to exist', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    appendEvalRecord(makeRecord({
      id: 'pair-primary',
      challengePairId: 'pair-456',
      prUrl: 'https://github.com/org/repo/pull/20',
    }), { dir: evalsDir });

    assert.equal(
      hasChallengeEvalRecordPair(
        'pair-456',
        'https://github.com/org/repo/pull/20',
        'https://github.com/org/repo/pull/21',
        { dir: evalsDir },
      ),
      false,
    );

    appendEvalRecord(makeRecord({
      id: 'pair-challenger',
      challengePairId: 'pair-456',
      prUrl: 'https://github.com/org/repo/pull/21',
    }), { dir: evalsDir });

    assert.equal(
      hasChallengeEvalRecordPair(
        'pair-456',
        'https://github.com/org/repo/pull/20',
        'https://github.com/org/repo/pull/21',
        { dir: evalsDir },
      ),
      true,
    );
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Cost Field Persistence Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Cost Field Persistence Tests ---\n');

test('tokenUsage and estimatedCost survive round-trip', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    const record = makeRecord({
      id: 'cost-1',
      tokenUsage: { inputTokens: 2000, outputTokens: 500, totalTokens: 2500 },
      estimatedCost: 0.01350,
    });
    appendEvalRecord(record, { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir });
    assert.equal(records.length, 1);
    assert.ok(records[0].tokenUsage, 'should have tokenUsage');
    assert.equal(records[0].tokenUsage!.inputTokens, 2000);
    assert.equal(records[0].tokenUsage!.outputTokens, 500);
    assert.equal(records[0].tokenUsage!.totalTokens, 2500);
    assert.equal(records[0].estimatedCost, 0.01350);
  } finally {
    cleanUp(tmp);
  }
});

test('records without cost fields read correctly (backward compat)', () => {
  const tmp = makeTempDir();
  const evalsDir = join(tmp, 'evals');
  try {
    // Record without tokenUsage/estimatedCost
    const record = makeRecord({ id: 'no-cost-1' });
    appendEvalRecord(record, { dir: evalsDir });

    const records = readEvalRecords({ dir: evalsDir });
    assert.equal(records.length, 1);
    assert.equal(records[0].tokenUsage, undefined);
    assert.equal(records[0].estimatedCost, undefined);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
