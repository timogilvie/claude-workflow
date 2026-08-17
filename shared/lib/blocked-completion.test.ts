import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BLOCKED_COMPLETION_REQUIRED_FIELDS,
  BLOCKED_COMPLETION_STAGE,
  BLOCKING_REASONS,
  RECOMMENDED_ACTIONS,
  readBlockedCompletion,
  validateBlockedCompletion,
} from './blocked-completion.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(__dirname, '../schemas/blocked-completion.schema.json'), 'utf-8'),
) as {
  required?: string[];
  properties?: Record<string, { enum?: string[]; const?: string }>;
};

function buildValidArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: 'coding',
    implementationComplete: true,
    committed: true,
    passingChecks: ['node --test shared/lib/blocked-completion.test.ts'],
    blockingChecks: ['npm test'],
    blockingReason: 'baseline_tests_failing',
    evidence: 'Repo-level test failures are unrelated to the scoped change.',
    recommendedAction: 'advance_to_review',
    ...overrides,
  };
}

function errorSummary(result: ReturnType<typeof validateBlockedCompletion>): Array<{ code: string; path: string }> {
  assert.equal(result.ok, false);
  if (result.ok) return [];
  return result.errors.map((error) => ({ code: error.code, path: error.path }));
}

test('validateBlockedCompletion accepts the minimal valid artifact', () => {
  const result = validateBlockedCompletion(buildValidArtifact());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.stage, 'coding');
  }
});

test('validateBlockedCompletion accepts optional commit and createdAt fields', () => {
  const result = validateBlockedCompletion(buildValidArtifact({
    commit: 'abc1234',
    createdAt: '2026-05-12T13:00:00.000Z',
  }));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.commit, 'abc1234');
    assert.equal(result.value.createdAt, '2026-05-12T13:00:00.000Z');
  }
});

test('validateBlockedCompletion accepts orchestrator capacity values', () => {
  const result = validateBlockedCompletion(buildValidArtifact({
    implementationComplete: false,
    passingChecks: [],
    blockingReason: 'model_at_capacity',
    recommendedAction: 'relaunch_coding',
  }));

  assert.equal(result.ok, true);
});

test('validateBlockedCompletion preserves unknown extra fields', () => {
  const result = validateBlockedCompletion(buildValidArtifact({
    extraContext: { source: 'targeted-check' },
  }));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.extraContext, { source: 'targeted-check' });
  }
});

test('validateBlockedCompletion reports missing required fields with shared paths', () => {
  const artifact = buildValidArtifact();
  delete artifact.stage;
  delete artifact.committed;

  assert.deepEqual(errorSummary(validateBlockedCompletion(artifact)), [
    { code: 'MISSING_REQUIRED_FIELD', path: '$.stage' },
    { code: 'MISSING_REQUIRED_FIELD', path: '$.committed' },
  ]);
});

test('readBlockedCompletion returns MALFORMED_JSON for malformed content', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'blocked-completion-'));
  try {
    const filePath = join(tempDir, '.coding-blocked-completion.json');
    writeFileSync(filePath, '{not valid json', 'utf-8');

    const result = await readBlockedCompletion(filePath);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.errors.map((error) => ({ code: error.code, path: error.path })), [
        { code: 'MALFORMED_JSON', path: '$' },
      ]);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('validateBlockedCompletion rejects non-object inputs without throwing', () => {
  for (const input of [null, [], 'nope']) {
    assert.deepEqual(errorSummary(validateBlockedCompletion(input)), [
      { code: 'INVALID_FIELD_TYPE', path: '$' },
    ]);
  }
});

test('validateBlockedCompletion rejects the wrong stage', () => {
  assert.deepEqual(errorSummary(validateBlockedCompletion(buildValidArtifact({ stage: 'review' }))), [
    { code: 'INVALID_STAGE', path: '$.stage' },
  ]);
});

test('validateBlockedCompletion rejects unknown blockingReason values', () => {
  for (const value of ['something_else', 'environment_or_baseline_tests_failing', 'environmental_and_baseline_collection_failures']) {
    assert.deepEqual(errorSummary(validateBlockedCompletion(buildValidArtifact({ blockingReason: value }))), [
      { code: 'INVALID_ENUM_VALUE', path: '$.blockingReason' },
    ]);
  }
});

test('validateBlockedCompletion rejects unknown recommendedAction values', () => {
  assert.deepEqual(errorSummary(validateBlockedCompletion(buildValidArtifact({
    recommendedAction: 'retry_later',
  }))), [
    { code: 'INVALID_ENUM_VALUE', path: '$.recommendedAction' },
  ]);
});

test('validateBlockedCompletion rejects non-string-array checks', () => {
  assert.deepEqual(errorSummary(validateBlockedCompletion(buildValidArtifact({
    passingChecks: ['ok', 1],
  }))), [
    { code: 'INVALID_FIELD_TYPE', path: '$.passingChecks[1]' },
  ]);

  assert.deepEqual(errorSummary(validateBlockedCompletion(buildValidArtifact({
    blockingChecks: 'npm test',
  }))), [
    { code: 'INVALID_FIELD_TYPE', path: '$.blockingChecks' },
  ]);
});

test('validateBlockedCompletion rejects invalid optional field types', () => {
  assert.deepEqual(errorSummary(validateBlockedCompletion(buildValidArtifact({ commit: 1234 }))), [
    { code: 'INVALID_FIELD_TYPE', path: '$.commit' },
  ]);

  assert.deepEqual(errorSummary(validateBlockedCompletion(buildValidArtifact({
    createdAt: false,
  }))), [
    { code: 'INVALID_FIELD_TYPE', path: '$.createdAt' },
  ]);
});

test('validateBlockedCompletion rejects implementationComplete without evidence', () => {
  assert.deepEqual(errorSummary(validateBlockedCompletion(buildValidArtifact({
    passingChecks: [],
  }))), [
    { code: 'NO_VERIFICATION_EVIDENCE', path: '$.passingChecks' },
  ]);
});

test('readBlockedCompletion returns ARTIFACT_NOT_FOUND for a non-existent file', async () => {
  const missingPath = join(tmpdir(), 'no-such-file-.coding-blocked-completion.json');

  const result = await readBlockedCompletion(missingPath);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.errors.map((error) => ({ code: error.code, path: error.path })), [
      { code: 'ARTIFACT_NOT_FOUND', path: '$' },
    ]);
  }
});

test('schema required fields and enums stay aligned with the validator exports', () => {
  assert.deepEqual(schema.required, [...BLOCKED_COMPLETION_REQUIRED_FIELDS]);
  assert.equal(schema.properties?.stage?.const, BLOCKED_COMPLETION_STAGE);
  assert.deepEqual(schema.properties?.blockingReason?.enum, [...BLOCKING_REASONS]);
  assert.deepEqual(schema.properties?.recommendedAction?.enum, [...RECOMMENDED_ACTIONS]);
});
