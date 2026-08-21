import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ResourceManifest, ResourceRef } from '../shared/lib/resource-manifest.ts';
import { computeHarnessId, saveManifest } from '../shared/lib/resource-manifest.ts';
import {
  diffHarnessRefs,
  resolveDiffTarget,
  runDiff,
} from './registry.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeManifest(sessionId: string, resources: ResourceRef[]): void {
  const manifest: ResourceManifest = {
    manifestSchemaVersion: '1.1.0',
    sessionId,
    workflowType: 'test',
    createdAt: new Date().toISOString(),
    phases: {},
    resources,
    digest: '',
  };
  manifest.harnessId = computeHarnessId(resources);
  saveManifest(manifest, tempDir);
}

describe('registry diff', () => {
  it('diffHarnessRefs reports changed, onlyLeft, and onlyRight', () => {
    const left: ResourceRef[] = [
      { id: 'prompt:a@sha256:1', version: 'sha256:1' },
      { id: 'prompt:b@sha256:2', version: 'sha256:2' },
      { id: 'environment:e@sha256:x', version: 'sha256:x' },
    ];
    const right: ResourceRef[] = [
      { id: 'prompt:a@sha256:1', version: 'sha256:1' },
      { id: 'prompt:b@sha256:3', version: 'sha256:3' },
      { id: 'prompt:c@sha256:4', version: 'sha256:4' },
    ];
    const diff = diffHarnessRefs(left, right);
    assert.deepEqual(diff.changed, [{ id: 'prompt:b', left: 'sha256:2', right: 'sha256:3' }]);
    assert.deepEqual(diff.onlyLeft, ['environment:e']);
    assert.deepEqual(diff.onlyRight, ['prompt:c']);
  });

  it('resolves by session id and by full harness id', () => {
    const resources: ResourceRef[] = [{ id: 'prompt:test@sha256:v1', version: 'sha256:v1' }];
    writeManifest('session-a', resources);
    const bySession = resolveDiffTarget('session-a', tempDir);
    assert.equal(bySession.sessionId, 'session-a');
    assert.equal(bySession.resolvedByHarnessId, false);

    const byHarness = resolveDiffTarget(bySession.harnessId, tempDir);
    assert.equal(byHarness.sessionId, 'session-a');
    assert.equal(byHarness.resolvedByHarnessId, true);
  });

  it('throws for unknown harness id and ambiguous prefix', () => {
    const resources: ResourceRef[] = [{ id: 'prompt:shared@sha256:v1', version: 'sha256:v1' }];
    writeManifest('session-1', resources);
    writeManifest('session-2', resources);

    assert.throws(() => resolveDiffTarget('0'.repeat(64), tempDir), /Unknown harness id/);
    assert.throws(
      () => resolveDiffTarget(resources[0]!.id.split('@')[0]!, tempDir),
      /not found/,
      'session-id lookup fails before harness interpretation for non-hex ids',
    );
    const harnessId = computeHarnessId(resources);
    assert.throws(
      () => resolveDiffTarget(harnessId.slice(0, 8), tempDir),
      /Ambiguous harness id prefix/,
    );
  });

  it('harness-id diff hides environment-only changes; session-id diff shows them', () => {
    const env1: ResourceRef = { id: 'environment:runtime-environment@sha256:env1', version: 'sha256:env1' };
    const env2: ResourceRef = { id: 'environment:runtime-environment@sha256:env2', version: 'sha256:env2' };
    const prompt1: ResourceRef = { id: 'prompt:review@sha256:v1', version: 'sha256:v1' };
    const prompt2: ResourceRef = { id: 'prompt:review@sha256:v2', version: 'sha256:v2' };
    const extraTool: ResourceRef = { id: 'tool:node@sha256:extra', version: 'sha256:extra' };

    writeManifest('left', [env1, prompt1]);
    writeManifest('right-prompt', [env1, prompt2]);
    writeManifest('right-env', [env2, prompt1, extraTool]);

    const leftTarget = resolveDiffTarget('left', tempDir);
    const promptTarget = resolveDiffTarget('right-prompt', tempDir);
    const envTarget = resolveDiffTarget('right-env', tempDir);

    const promptDiff = runDiff(leftTarget.harnessId, promptTarget.harnessId, tempDir, false);
    assert.ok(!promptDiff.includes('environment:'), 'prompt diff should not mention environment');
    assert.ok(promptDiff.includes('prompt:review'), 'prompt diff should mention the changed prompt');
    assert.ok(
      runDiff('left', 'right-prompt', tempDir, false).includes('environment:') === false,
      'session diff also sees environment since same env',
    );

    const envDiff = runDiff(leftTarget.harnessId, envTarget.harnessId, tempDir, false);
    assert.ok(!envDiff.includes('environment:'), `env-only harness diff should hide environment; got:\n${envDiff}`);
    assert.ok(!envDiff.includes('prompt:review'), 'env-only harness diff should not mention prompt');
    // The only difference is an extra tool ref, which harness diff surfaces.
    assert.ok(envDiff.includes('tool:'), 'env-only harness diff should still surface non-environment differences');
    const envSessionDiff = runDiff('left', 'right-env', tempDir, false);
    assert.ok(envSessionDiff.includes('environment:'), 'session diff should show environment change');
    assert.ok(envSessionDiff.includes('tool:'), 'session diff should show tool change');
    assert.ok(envSessionDiff.includes('prompt:review') === false, 'session diff should not show prompt change');
  });

  it('json output includes changed, onlyLeft, and onlyRight shapes', () => {
    const prompt1: ResourceRef = { id: 'prompt:review@sha256:v1', version: 'sha256:v1' };
    const prompt2: ResourceRef = { id: 'prompt:review@sha256:v2', version: 'sha256:v2' };
    writeManifest('a', [prompt1]);
    writeManifest('b', [prompt2]);
    const json = JSON.parse(runDiff('a', 'b', tempDir, true));
    assert.ok(Array.isArray(json.changed), 'json.changed is array');
    assert.deepEqual(json.changed, [{ id: 'prompt:review', left: 'sha256:v1', right: 'sha256:v2' }]);
    assert.deepEqual(json.onlyLeft, []);
    assert.deepEqual(json.onlyRight, []);
    assert.equal(json.left.sessionId, 'a');
    assert.equal(json.right.sessionId, 'b');
  });
});
