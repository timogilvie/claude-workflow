import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeActivePointersAtomic } from '../resource-lifecycle.ts';
import { registerDspyArtifact, resolveActiveArtifact } from './dspy-adapter.ts';
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

  it('resolves the active stable artifact pointer', () => {
    const stable = registerDspyArtifact('dspy/artifacts/optimized-selector.json', {
      version: '1.0.0',
      optimizer: 'miprov2',
      system_prompt: 'stable',
      few_shot_examples: [],
    }, tempDir);
    const candidate = registerDspyArtifact('dspy/artifacts/optimized-selector.json', {
      version: '2.0.0',
      optimizer: 'miprov2',
      system_prompt: 'candidate',
      few_shot_examples: [],
    }, tempDir);

    assert.ok(stable);
    assert.ok(candidate);

    writeActivePointersAtomic({
      schemaVersion: '1.0.0',
      updatedAt: '2026-04-21T00:00:00.000Z',
      entries: {
        'optimizer-artifact:optimized-selector': {
          stable: { id: candidate!.id, version: candidate!.version, updatedAt: '2026-04-21T00:00:00.000Z' },
          previousStable: { id: stable!.id, version: stable!.version, updatedAt: '2026-04-20T00:00:00.000Z' },
        },
      },
    }, tempDir);

    const resolved = resolveActiveArtifact('optimized-selector', tempDir);
    assert.equal(resolved?.slot, 'stable');
    assert.equal(resolved?.resource.version, candidate!.version);
  });
});
