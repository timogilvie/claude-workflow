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

test('validateBlockedCompletion preserves unknown extra fields', () => {
  const result = validateBlockedCompletion(buildValidArtifact({
    extraContext: { source: 'targeted-check' },
  }));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.extraContext, { source: 'targeted-check' });
  }
});

test('validateBlockedCompletion reports each missing required field deterministically', () => {
  for (const field of BLOCKED_COMPLETION_REQUIRED_FIELDS) {
    const artifact = buildValidArtifact();
    delete artifact[field];

    const result = validateBlockedCompletion(artifact);
    assert.deepEqual(result, {
      ok: false,
      code: 'MISSING_REQUIRED_FIELD',
      field,
      message: `Blocked completion artifact is missing required field "${field}".`,
    });
  }
});

test('readBlockedCompletion returns MALFORMED_JSON for malformed content', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'blocked-completion-'));
  try {
    const filePath = join(tempDir, '.coding-blocked-completion.json');
    writeFileSync(filePath, '{not valid json', 'utf-8');

    const result = await readBlockedCompletion(filePath);
    assert.deepEqual(result, {
      ok: false,
      code: 'MALFORMED_JSON',
      message: `Blocked completion artifact at ${filePath} contains malformed JSON.`,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('validateBlockedCompletion rejects non-object inputs without throwing', () => {
  for (const input of [null, [], 'nope']) {
    const result = validateBlockedCompletion(input);
    assert.deepEqual(result, {
      ok: false,
      code: 'INVALID_FIELD_TYPE',
      field: 'artifact',
      message: 'Blocked completion artifact must be a JSON object.',
    });
  }
});

test('validateBlockedCompletion rejects the wrong stage', () => {
  const result = validateBlockedCompletion(buildValidArtifact({ stage: 'review' }));

  assert.deepEqual(result, {
    ok: false,
    code: 'INVALID_STAGE',
    field: 'stage',
    message: 'Blocked completion stage must be "coding".',
  });
});

test('validateBlockedCompletion rejects unknown blockingReason values', () => {
  const result = validateBlockedCompletion(buildValidArtifact({
    blockingReason: 'something_else',
  }));

  assert.deepEqual(result, {
    ok: false,
    code: 'INVALID_ENUM_VALUE',
    field: 'blockingReason',
    message: 'Blocked completion field "blockingReason" must be a recognized value.',
  });
});

test('validateBlockedCompletion rejects unknown recommendedAction values', () => {
  const result = validateBlockedCompletion(buildValidArtifact({
    recommendedAction: 'retry_later',
  }));

  assert.deepEqual(result, {
    ok: false,
    code: 'INVALID_ENUM_VALUE',
    field: 'recommendedAction',
    message: 'Blocked completion field "recommendedAction" must be a recognized value.',
  });
});

test('validateBlockedCompletion rejects non-string-array checks', () => {
  const passingResult = validateBlockedCompletion(buildValidArtifact({
    passingChecks: ['ok', 1],
  }));
  assert.deepEqual(passingResult, {
    ok: false,
    code: 'INVALID_FIELD_TYPE',
    field: 'passingChecks',
    message: 'Blocked completion field "passingChecks" must be an array of strings.',
  });

  const blockingResult = validateBlockedCompletion(buildValidArtifact({
    blockingChecks: 'npm test',
  }));
  assert.deepEqual(blockingResult, {
    ok: false,
    code: 'INVALID_FIELD_TYPE',
    field: 'blockingChecks',
    message: 'Blocked completion field "blockingChecks" must be an array of strings.',
  });
});

test('validateBlockedCompletion rejects invalid optional field types', () => {
  const commitResult = validateBlockedCompletion(buildValidArtifact({ commit: 1234 }));
  assert.deepEqual(commitResult, {
    ok: false,
    code: 'INVALID_FIELD_TYPE',
    field: 'commit',
    message: 'Blocked completion field "commit" must be a string when present.',
  });

  const createdAtResult = validateBlockedCompletion(buildValidArtifact({
    createdAt: false,
  }));
  assert.deepEqual(createdAtResult, {
    ok: false,
    code: 'INVALID_FIELD_TYPE',
    field: 'createdAt',
    message: 'Blocked completion field "createdAt" must be a string when present.',
  });
});

test('readBlockedCompletion propagates ENOENT for a non-existent file', async () => {
  const missingPath = join(tmpdir(), 'no-such-file-.coding-blocked-completion.json');

  await assert.rejects(
    () => readBlockedCompletion(missingPath),
    (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, 'ENOENT');
      return true;
    },
  );
});

test('schema required fields and enums stay aligned with the validator exports', () => {
  assert.deepEqual(schema.required, [...BLOCKED_COMPLETION_REQUIRED_FIELDS]);
  assert.equal(schema.properties?.stage?.const, BLOCKED_COMPLETION_STAGE);
  assert.deepEqual(schema.properties?.blockingReason?.enum, [...BLOCKING_REASONS]);
  assert.deepEqual(schema.properties?.recommendedAction?.enum, [...RECOMMENDED_ACTIONS]);
});
