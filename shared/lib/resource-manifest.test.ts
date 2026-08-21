import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  closeManifest,
  computeHarnessId,
  getManifest,
  openManifest,
  recordUse,
  resolveHarnessId,
  ensureManifest,
} from './resource-manifest.ts';
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
    assert.match(beforeClose?.harnessId ?? '', /^[a-f0-9]{64}$/);
    assert.notEqual(beforeClose?.harnessId, manifest.harnessId, 'harnessId changes after recordUse');

    const closed = closeManifest('session-1', { status: 'completed', repoDir: tempDir });
    assert.ok(closed?.digest);
    assert.equal(getManifest('session-1', tempDir)?.digest, closed?.digest);
    assert.match(closed?.harnessId ?? '', /^[a-f0-9]{64}$/);
    assert.equal(closed?.harnessId, beforeClose?.harnessId, 'harnessId is stable at close');
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

  it('computes a deterministic harnessId ignoring order and duplicates', () => {
    const refA = { id: 'prompt:a@sha256:abc', version: 'sha256:abc' };
    const refB = { id: 'prompt:b@sha256:def', version: 'sha256:def' };
    const id1 = computeHarnessId([refA, refB]);
    const id2 = computeHarnessId([refB, refA, refA, refB]);
    assert.equal(id1, id2);
    assert.match(id1, /^[a-f0-9]{64}$/);
  });

  it('excludes environment refs and reacts to prompt version changes', () => {
    const env = { id: 'environment:runtime-environment@sha256:env1', version: 'sha256:env1' };
    const prompt = { id: 'prompt:x@sha256:v1', version: 'sha256:v1' };
    const idWithoutEnv = computeHarnessId([prompt]);
    const idWithEnv = computeHarnessId([env, prompt, env]);
    assert.equal(idWithEnv, idWithoutEnv, 'environment refs do not affect harnessId');

    const promptV2 = { id: 'prompt:x@sha256:v2', version: 'sha256:v2' };
    assert.notEqual(computeHarnessId([promptV2]), idWithoutEnv, 'prompt version change changes harnessId');
  });

  it('resolves harnessId for legacy manifests without persisting a change', async () => {
    const sessionId = 'legacy-session';
    const manifestDir = join(tempDir, '.wavemill', 'manifests');
    await mkdir(manifestDir, { recursive: true });
    const legacy = {
      manifestSchemaVersion: '1.0.0',
      sessionId,
      workflowType: 'feature',
      createdAt: new Date().toISOString(),
      phases: {},
      resources: [{ id: 'prompt:test@sha256:v1', version: 'sha256:v1' }],
      digest: 'existing-digest',
    };
    await writeFile(join(manifestDir, `${sessionId}.json`), `${JSON.stringify(legacy, null, 2)}\n`, 'utf-8');

    const resolved = resolveHarnessId(sessionId, tempDir);
    assert.equal(resolved, computeHarnessId([{ id: 'prompt:test@sha256:v1', version: 'sha256:v1' }]));

    const raw = JSON.parse(await readFile(join(manifestDir, `${sessionId}.json`), 'utf-8')) as Record<string, unknown>;
    assert.equal(raw.harnessId, undefined, 'legacy file must not be modified');
  });

  it('creates a manifest lazily via recordUse for an unknown session', () => {
    const sessionId = 'lazy-session';
    const ref = { id: 'prompt:p@sha256:v1', version: 'sha256:v1' };
    const result = recordUse(sessionId, 'coding', ref, tempDir);
    assert.ok(result, 'recordUse creates a manifest lazily');
    assert.equal(getManifest(sessionId, tempDir)?.workflowType, 'unknown');
    assert.match(getManifest(sessionId, tempDir)?.harnessId ?? '', /^[a-f0-9]{64}$/);
  });
});
