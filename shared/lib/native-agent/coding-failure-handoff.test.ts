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
  it('round-trips a valid handoff artifact', async () => {
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
});

function makeFeatureDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'coding-failure-handoff-'));
  dirs.push(root);
  const featureDir = join(root, 'features', 'demo');
  mkdirSync(featureDir, { recursive: true });
  return featureDir;
}
