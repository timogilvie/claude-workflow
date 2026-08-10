import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  buildNoMarkerHandoff,
  getNoMarkerHandoffPath,
  readNoMarkerHandoff,
  validateNoMarkerHandoff,
  writeNoMarkerHandoff,
} from './coding-handoff.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('coding no-marker handoff', () => {
  it('builds, writes, redacts, and reads a valid handoff', () => {
    const featureDir = mkdtempSync(join(tmpdir(), 'coding-handoff-'));
    dirs.push(featureDir);

    const handoff = buildNoMarkerHandoff({
      createdAt: '2026-08-10T00:00:00.000Z',
      stopReason: 'stop',
      model: 'scripted',
      mutationFailureCount: 2,
      lastMutationFailure: {
        tool: 'apply_patch',
        error: 'invalid_patch',
        message: 'Authorization: Bearer sk-testsecret1234567890abcdefghijkl',
        retryHint: 'Fix the listed schema errors and retry.',
        diagnostics: [{ path: '$.version', message: 'NativePatch version must be 1.' }],
      },
    });

    const path = writeNoMarkerHandoff(featureDir, handoff);
    assert.equal(path, getNoMarkerHandoffPath(featureDir));

    const read = readNoMarkerHandoff(path);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value.reason, 'no_completion_marker');
    assert.equal(read.value.mutationFailureCount, 2);
    assert.equal(read.value.lastMutationFailure?.tool, 'apply_patch');
    assert.match(read.value.lastMutationFailure?.message ?? '', /\[REDACTED/);
    assert.ok(read.value.suggestedNextActions.some((action) => action.includes('Retry coding')));
  });

  it('rejects malformed handoff artifacts', () => {
    const result = validateNoMarkerHandoff({
      schemaVersion: 1,
      stage: 'coding',
      reason: 'unexpected',
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.field, 'reason');
  });
});
