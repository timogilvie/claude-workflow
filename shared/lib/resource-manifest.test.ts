import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EMPTY_HARNESS_ID,
  closeManifest,
  computeHarnessId,
  computeManifestDigest,
  findManifestsByHarnessId,
  getHarnessId,
  getManifest,
  openManifest,
  recordUse,
  resolveManifestPath,
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
  it('computes deterministic harness ids over included resource tuples', () => {
    const refs = [
      { id: 'environment:runtime-environment@sha256:env', version: 'sha256:env' },
      { id: 'tool:node@v22.22.2', version: 'v22.22.2' },
      { id: 'runtime:openai:gpt-5@sha256:runtime', version: 'sha256:runtime' },
      { id: 'prompt:review@sha256:prompt', version: 'sha256:prompt' },
      { id: 'memory:subsystem@sha256:memory', version: 'sha256:memory' },
      { id: 'agent-config:native:planning@sha256:agent', version: 'sha256:agent' },
      { id: 'prompt:legacy', version: 'v1' },
      { id: 'prompt:review@sha256:prompt', version: 'sha256:prompt' },
    ];

    const expectedInput = [
      'agent-config:native:planning@sha256:agent',
      'memory:subsystem@sha256:memory',
      'prompt:legacy@v1',
      'prompt:review@sha256:prompt',
      'runtime:openai:gpt-5@sha256:runtime',
    ].join('\n');

    assert.equal(
      computeHarnessId(refs),
      createHash('sha256').update(expectedInput, 'utf-8').digest('hex'),
    );
    assert.equal(computeHarnessId([...refs].reverse()), computeHarnessId(refs));
    assert.equal(computeHarnessId([]), EMPTY_HARNESS_ID);
    assert.equal(
      computeHarnessId([
        { id: 'environment:runtime-environment@sha256:env', version: 'sha256:env' },
        { id: 'tool:node@v22.22.2', version: 'v22.22.2' },
      ]),
      EMPTY_HARNESS_ID,
    );
  });

  it('opens, records uses, and closes a manifest with a stable digest', () => {
    const manifest = openManifest('session-1', {
      workflowType: 'feature',
      repoDir: tempDir,
    });

    assert.equal(manifest.sessionId, 'session-1');
    assert.deepEqual(manifest.phases, {});
    assert.equal(manifest.harnessId, computeHarnessId(manifest.resources));

    const resource = registerResource({
      type: 'prompt',
      name: 'review-phase',
      content: 'body',
    }, { repoDir: tempDir });
    recordUse('session-1', 'review', toResourceRef(resource), tempDir);
    recordUse('session-1', 'review', toResourceRef(resource), tempDir);

    const beforeClose = getManifest('session-1', tempDir);
    assert.equal(beforeClose?.phases.review.length, 1);
    assert.equal(beforeClose?.harnessId, computeHarnessId(beforeClose?.resources ?? []));
    assert.notEqual(beforeClose?.harnessId, manifest.harnessId);

    const closed = closeManifest('session-1', { status: 'completed', repoDir: tempDir });
    assert.ok(closed?.digest);
    assert.equal(closed?.harnessId, beforeClose?.harnessId);
    assert.equal(getManifest('session-1', tempDir)?.digest, closed?.digest);
  });

  it('excludes harnessId from the manifest digest', () => {
    const manifest = openManifest('digest-session', {
      workflowType: 'feature',
      repoDir: tempDir,
    });
    const withoutHarnessId = { ...manifest, harnessId: undefined };

    assert.equal(computeManifestDigest(manifest), computeManifestDigest(withoutHarnessId));
  });

  it('resolves harness ids for legacy manifests without a persisted field', async () => {
    const resource = registerResource({
      type: 'prompt',
      name: 'legacy-prompt',
      content: 'legacy body',
    }, { repoDir: tempDir });
    const ref = toResourceRef(resource);
    assert.ok(ref);

    const legacyManifest = {
      manifestSchemaVersion: '1.0.0',
      sessionId: 'legacy-session',
      workflowType: 'feature',
      createdAt: new Date().toISOString(),
      phases: { coding: [ref] },
      resources: [ref],
      digest: '',
    };
    await mkdir(join(tempDir, '.wavemill', 'manifests'), { recursive: true });
    await writeFile(
      resolveManifestPath('legacy-session', tempDir),
      `${JSON.stringify(legacyManifest, null, 2)}\n`,
      'utf-8',
    );

    assert.equal(getHarnessId('legacy-session', tempDir), computeHarnessId([ref]));
  });

  it('finds manifests by exact harness id and unique prefix', () => {
    const first = openManifest('find-1', { workflowType: 'feature', repoDir: tempDir });
    const prompt = registerResource({
      type: 'prompt',
      name: 'find-2',
      content: 'different',
    }, { repoDir: tempDir });
    openManifest('find-2', { workflowType: 'feature', repoDir: tempDir });
    const promptRef = toResourceRef(prompt);
    assert.ok(promptRef);
    recordUse('find-2', 'coding', promptRef, tempDir);
    const second = getManifest('find-2', tempDir);
    assert.ok(second?.harnessId);

    assert.deepEqual(
      findManifestsByHarnessId(first.harnessId!, tempDir).map((entry) => entry.sessionId),
      ['find-1'],
    );
    assert.deepEqual(
      findManifestsByHarnessId(second.harnessId!.slice(0, 8), tempDir).map((entry) => entry.sessionId),
      ['find-2'],
    );
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
