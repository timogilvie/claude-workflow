import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  diffHarnesses,
  formatHarnessDiff,
  resolveHarnessSelector,
} from './harness-diff.ts';
import { computeHarnessId, resolveManifestPath } from './resource-manifest.ts';
import type { ResourceRef } from './resource-registry.ts';

function ref(id: string, version: string): ResourceRef {
  return { id, version };
}

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'harness-diff-'));
  mkdirSync(join(repoDir, '.wavemill', 'manifests'), { recursive: true });
  return repoDir;
}

function writeManifest(repoDir: string, sessionId: string, resources: ResourceRef[], harnessId = computeHarnessId(resources)): void {
  writeFileSync(resolveManifestPath(sessionId, repoDir), `${JSON.stringify({
    manifestSchemaVersion: '1.1.0',
    sessionId,
    workflowType: 'feature',
    createdAt: '2026-08-21T00:00:00.000Z',
    phases: { coding: resources },
    resources,
    harnessId,
    digest: '',
  }, null, 2)}\n`, 'utf-8');
}

test('diffHarnesses classifies added removed changed and preserves legacy onlyLeft onlyRight', () => {
  const left = [
    ref('prompt:main@v1', 'v1'),
    ref('memory:guide@v1', 'v1'),
    ref('agent-config:native:coding@v1', 'v1'),
    ref('environment:runtime@env1', 'env1'),
  ];
  const right = [
    ref('prompt:main@v2', 'v2'),
    ref('memory:guide@v1', 'v1'),
    ref('runtime:openai:gpt-5@v1', 'v1'),
    ref('tool:node@v22', 'v22'),
  ];

  const diff = diffHarnesses(left, right);
  assert.deepEqual(diff.removed, ['agent-config:native:coding@v1']);
  assert.deepEqual(diff.added, ['runtime:openai:gpt-5@v1']);
  assert.deepEqual(diff.changed, [{ name: 'prompt:main', from: 'v1', to: 'v2' }]);
  assert.deepEqual(diff.unchanged, ['memory:guide@v1']);
  assert.ok(diff.onlyLeft.includes('prompt:main@v1'));
  assert.ok(diff.onlyRight.includes('prompt:main@v2'));
  assert.deepEqual(diff.excludedLeft, ['environment:runtime@env1']);
  assert.deepEqual(diff.excludedRight, ['tool:node@v22']);
});

test('formatHarnessDiff reports no differences for identical harness resources', () => {
  const repoDir = makeRepo();
  try {
    const resources = [ref('prompt:main@v1', 'v1')];
    writeManifest(repoDir, 'same-a', resources);
    writeManifest(repoDir, 'same-b', resources);
    const left = resolveHarnessSelector('same-a', repoDir);
    const right = resolveHarnessSelector('same-b', repoDir);
    const text = formatHarnessDiff(left, right, diffHarnesses(left.resources, right.resources));
    assert.match(text, /No differences/);
    assert.match(text, /same-a, same-b|same-b, same-a/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveHarnessSelector accepts sessions, exact harness ids, and unique prefixes', () => {
  const repoDir = makeRepo();
  try {
    const resources = [ref('prompt:main@v1', 'v1')];
    const harnessId = computeHarnessId(resources);
    writeManifest(repoDir, 'session-a', resources, harnessId);

    assert.equal(resolveHarnessSelector('session-a', repoDir).harnessId, harnessId);
    assert.equal(resolveHarnessSelector(harnessId, repoDir).sessions[0], 'session-a');
    assert.equal(resolveHarnessSelector(harnessId.slice(0, 8), repoDir).sessions[0], 'session-a');
    assert.throws(
      () => resolveHarnessSelector('missing-selector', repoDir),
      /Harness ID or session not found/,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveHarnessSelector rejects ambiguous harness prefixes', () => {
  const repoDir = makeRepo();
  try {
    writeManifest(repoDir, 'ambiguous-a', [ref('prompt:a@v1', 'v1')], `${'a'.repeat(63)}1`);
    writeManifest(repoDir, 'ambiguous-b', [ref('prompt:b@v1', 'v1')], `${'a'.repeat(63)}2`);
    assert.throws(
      () => resolveHarnessSelector('aaaaaaaa', repoDir),
      /Ambiguous harness ID prefix/,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
