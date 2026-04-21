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
  it('registers prompt templates with extracted names', () => {
    const ref = registerPromptTemplate('tools/prompts/issue-writer.md', 'hello', tempDir);
    assert.ok(ref);
    const resources = listResources({ type: 'prompt' }, tempDir);
    assert.equal(resources[0].name, 'issue-writer');
  });
});
