import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeActivePointersAtomic } from '../resource-lifecycle.ts';
import { registerPromptTemplate, resolveActivePrompt } from './prompt-adapter.ts';
import { listResources } from '../resource-registry.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'prompt-adapter-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('prompt-adapter', () => {
  it('registers prompt templates with extracted names', () => {
    const ref = registerPromptTemplate('tools/prompts/issue-writer.md', 'hello', tempDir);
    assert.ok(ref);
    const resources = listResources({ type: 'prompt' }, tempDir);
    assert.equal(resources[0].name, 'issue-writer');
  });

  it('resolves canary prompt when traffic is 100%', () => {
    const stable = registerPromptTemplate('tools/prompts/issue-writer.md', 'stable', tempDir);
    const canary = registerPromptTemplate('tools/prompts/issue-writer.md', 'canary', tempDir);
    assert.ok(stable);
    assert.ok(canary);

    writeActivePointersAtomic({
      schemaVersion: '1.0.0',
      updatedAt: '2026-04-21T00:00:00.000Z',
      entries: {
        'prompt:issue-writer': {
          stable: { id: stable!.id, version: stable!.version, updatedAt: '2026-04-21T00:00:00.000Z' },
          canary: { id: canary!.id, version: canary!.version, updatedAt: '2026-04-21T00:00:00.000Z', trafficPercent: 100 },
        },
      },
    }, tempDir);

    const resolved = resolveActivePrompt('issue-writer', tempDir, { sessionId: 'session-a' });
    assert.equal(resolved?.slot, 'canary');
    assert.equal(resolved?.resource.version, canary!.version);
  });

  it('resolves stable prompt when canary traffic is 0%', () => {
    const stable = registerPromptTemplate('tools/prompts/issue-writer.md', 'stable', tempDir);
    const canary = registerPromptTemplate('tools/prompts/issue-writer.md', 'canary', tempDir);
    assert.ok(stable);
    assert.ok(canary);

    writeActivePointersAtomic({
      schemaVersion: '1.0.0',
      updatedAt: '2026-04-21T00:00:00.000Z',
      entries: {
        'prompt:issue-writer': {
          stable: { id: stable!.id, version: stable!.version, updatedAt: '2026-04-21T00:00:00.000Z' },
          canary: { id: canary!.id, version: canary!.version, updatedAt: '2026-04-21T00:00:00.000Z', trafficPercent: 0 },
        },
      },
    }, tempDir);

    const resolved = resolveActivePrompt('issue-writer', tempDir, { sessionId: 'session-a' });
    assert.equal(resolved?.slot, 'stable');
    assert.equal(resolved?.resource.version, stable!.version);
  });
});
