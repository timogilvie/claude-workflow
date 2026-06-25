import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeManifest, getManifest, openManifest, recordUse } from './resource-manifest.ts';
import { registerResource, toResourceRef } from './resource-registry.ts';
import { registerNativeRuntime } from './resource-adapters/native-runtime-adapter.ts';

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

  it('records native phase prompt, runtime, and tool-set refs in the manifest', () => {
    const sessionId = 'native-phase-manifest-test';
    openManifest(sessionId, { workflowType: 'feature', repoDir: tempDir });

    // Register the native prompt.
    const promptResource = registerResource(
      { type: 'prompt', name: 'native-read-only-phase', content: 'native system prompt' },
      { repoDir: tempDir },
    );
    const promptRef = toResourceRef(promptResource);
    if (promptRef) recordUse(sessionId, 'planning', promptRef, tempDir);

    // Register native runtime provenance.
    const refs = registerNativeRuntime({
      phase: 'planning',
      provider: 'openai',
      model: 'gpt-4o',
      api: 'openai-responses',
      tools: [
        { name: 'read_file', class: 'read-only' },
        { name: 'list_files', class: 'read-only' },
        { name: 'git_status', class: 'read-only' },
      ],
      promptRef: promptRef ?? undefined,
      repoDir: tempDir,
    });

    if (refs.runtime) recordUse(sessionId, 'planning', refs.runtime, tempDir);
    if (refs.toolSet) recordUse(sessionId, 'planning', refs.toolSet, tempDir);

    const manifest = getManifest(sessionId, tempDir);
    assert.ok(manifest, 'manifest must exist');

    const planningRefs = manifest?.phases.planning ?? [];
    assert.ok(planningRefs.length >= 3, `planning phase must have at least 3 refs (prompt, runtime, toolSet); got ${planningRefs.length}`);

    const refIds = planningRefs.map((r) => r.id);
    assert.ok(
      refIds.some((id) => id.startsWith('prompt:')),
      'planning phase must include a prompt ref',
    );
    assert.ok(
      refIds.some((id) => id.startsWith('runtime:')),
      'planning phase must include a runtime ref',
    );
    assert.ok(
      refIds.some((id) => id.startsWith('agent-config:')),
      'planning phase must include an agent-config (tool-set) ref',
    );
  });
});
