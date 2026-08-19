import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  getCodingFailureHandoffPath,
  readCodingFailureHandoff,
  validateCodingFailureHandoff,
  writeCodingFailureHandoff,
  type CodingFailureHandoff,
} from './coding-failure-handoff.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('coding-failure-handoff', () => {
  it('round-trips a valid no-completion handoff artifact', async () => {
    const featureDir = makeFeatureDir();
    const handoff: CodingFailureHandoff = {
      stage: 'coding',
      reason: 'no_completion_artifact',
      stopReason: 'stop',
      mutationFailures: 2,
      lastToolError: {
        tool: 'apply_patch',
        error: 'invalid_patch',
        message: 'Patch payload did not match the NativePatch contract.',
        retryHint: 'Retry with the example.',
        diagnostics: [{ path: '$.version', message: 'NativePatch version must be 1.' }],
      },
      recoveryAttempted: true,
      suggestedAction: 'Retry native coding.',
      createdAt: '2026-08-10T00:00:00.000Z',
      schemaVersion: '1.0',
    };

    writeCodingFailureHandoff(featureDir, handoff);
    const result = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, handoff);
  });

  it('round-trips an invalid-completion-artifact handoff artifact', async () => {
    const featureDir = makeFeatureDir();
    const handoff: CodingFailureHandoff = {
      stage: 'coding',
      reason: 'invalid_completion_artifact',
      stopReason: 'stop',
      mutationFailures: 0,
      lastToolError: null,
      recoveryAttempted: false,
      suggestedAction: 'Rewrite the completion artifact.',
      createdAt: '2026-08-10T00:00:00.000Z',
      schemaVersion: '1.0',
      validationErrors: [
        { code: 'MALFORMED_JSON', field: '$', message: 'Artifact must be valid JSON.' },
      ],
      quarantinedArtifacts: ['features/demo/.coding-complete.invalid-1'],
    };

    writeCodingFailureHandoff(featureDir, handoff);
    const result = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, handoff);
  });

  it('rejects malformed JSON', async () => {
    const featureDir = makeFeatureDir();
    const filePath = getCodingFailureHandoffPath(featureDir);
    writeFileSync(filePath, '{broken\n', 'utf-8');

    const result = await readCodingFailureHandoff(filePath);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'MALFORMED_JSON');
  });

  it('rejects missing required fields', () => {
    const result = validateCodingFailureHandoff({
      stage: 'coding',
      reason: 'no_completion_artifact',
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'MISSING_REQUIRED_FIELD');
    assert.equal(result.field, 'stopReason');
  });

  it('rejects an unknown reason', () => {
    const result = validateCodingFailureHandoff({
      ...validNoCompletionHandoff(),
      reason: 'unexpected_reason',
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'INVALID_ENUM_VALUE');
    assert.equal(result.field, 'reason');
  });

  it('requires validation errors for invalid-completion-artifact handoffs', () => {
    const result = validateCodingFailureHandoff({
      ...validNoCompletionHandoff(),
      reason: 'invalid_completion_artifact',
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'MISSING_REQUIRED_FIELD');
    assert.equal(result.field, 'validationErrors');
  });

  it('rejects malformed validationErrors fields', () => {
    const notArray = validateCodingFailureHandoff({
      ...validNoCompletionHandoff(),
      validationErrors: 'bad',
    });
    assert.equal(notArray.ok, false);
    if (!notArray.ok) {
      assert.equal(notArray.code, 'INVALID_FIELD_TYPE');
      assert.equal(notArray.field, 'validationErrors');
    }

    const missingMessage = validateCodingFailureHandoff({
      ...validNoCompletionHandoff(),
      validationErrors: [{ code: 'MALFORMED_JSON' }],
    });
    assert.equal(missingMessage.ok, false);
    if (!missingMessage.ok) {
      assert.equal(missingMessage.code, 'INVALID_FIELD_TYPE');
      assert.equal(missingMessage.field, 'validationErrors.0.message');
    }
  });

  it('rejects malformed quarantinedArtifacts fields', () => {
    const result = validateCodingFailureHandoff({
      ...validNoCompletionHandoff(),
      quarantinedArtifacts: ['features/demo/.coding-complete.invalid-1', 42],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'INVALID_FIELD_TYPE');
    assert.equal(result.field, 'quarantinedArtifacts');
  });
});

function makeFeatureDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'coding-failure-handoff-'));
  dirs.push(root);
  const featureDir = join(root, 'features', 'demo');
  mkdirSync(featureDir, { recursive: true });
  return featureDir;
}

function validNoCompletionHandoff(): CodingFailureHandoff {
  return {
    stage: 'coding',
    reason: 'no_completion_artifact',
    stopReason: 'stop',
    mutationFailures: 0,
    lastToolError: null,
    recoveryAttempted: false,
    suggestedAction: 'Review the transcript and rerun native coding.',
    createdAt: '2026-08-10T00:00:00.000Z',
    schemaVersion: '1.0',
  };
}
