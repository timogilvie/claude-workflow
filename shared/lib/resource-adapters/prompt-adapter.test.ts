import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerPromptTemplate } from './prompt-adapter.ts';
import { listResources } from '../resource-registry.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'prompt-adapter-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('prompt-adapter', () => {
  it('registers prompt templates with extracted names and merged metadata', () => {
    const ref = registerPromptTemplate('tools/prompts/issue-writer.md', 'hello', tempDir, {
      metadata: {
        resourceClass: 'prompt',
        role: 'issue-writer',
      },
    });
    assert.ok(ref);
    const resources = listResources({ type: 'prompt' }, tempDir);
    assert.equal(resources[0].name, 'issue-writer');
    assert.equal(resources[0].metadata?.resourceClass, 'prompt');
    assert.equal(resources[0].metadata?.role, 'issue-writer');
  });
});
