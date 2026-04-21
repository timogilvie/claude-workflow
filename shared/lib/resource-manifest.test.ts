import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeManifest, getManifest, openManifest, recordUse } from './resource-manifest.ts';
import { registerResource, toResourceRef } from './resource-registry.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'resource-manifest-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('resource-manifest', () => {
  it('opens, records uses, and closes a manifest with a stable digest', () => {
    const manifest = openManifest('session-1', {
      workflowType: 'feature',
      repoDir: tempDir,
    });

    assert.equal(manifest.sessionId, 'session-1');
    assert.deepEqual(manifest.phases, {});

    const resource = registerResource({
      type: 'prompt',
      name: 'review-phase',
      content: 'body',
    }, { repoDir: tempDir });
    recordUse('session-1', 'review', toResourceRef(resource), tempDir);
    recordUse('session-1', 'review', toResourceRef(resource), tempDir);

    const beforeClose = getManifest('session-1', tempDir);
    assert.equal(beforeClose?.phases.review.length, 1);

    const closed = closeManifest('session-1', { status: 'completed', repoDir: tempDir });
    assert.ok(closed?.digest);
    assert.equal(getManifest('session-1', tempDir)?.digest, closed?.digest);
  });
});
