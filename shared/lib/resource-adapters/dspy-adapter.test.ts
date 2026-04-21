import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerDspyArtifact } from './dspy-adapter.ts';
import { listResources } from '../resource-registry.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dspy-adapter-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('dspy-adapter', () => {
  it('prefers artifact version metadata when present', () => {
    const ref = registerDspyArtifact('dspy/artifacts/optimized-selector.json', {
      version: '2.1.0',
      optimizer: 'miprov2',
      created_at: '2026-04-21T00:00:00Z',
      teacher_model: 'claude-opus-4-7',
      runtime_model: 'claude-haiku-4-5-20251001',
    }, tempDir);

    assert.ok(ref);
    const [resource] = listResources({ type: 'optimizer-artifact' }, tempDir);
    assert.equal(resource.version, '2.1.0');
    assert.equal(resource.lineage?.optimizer, 'miprov2');
  });
});
