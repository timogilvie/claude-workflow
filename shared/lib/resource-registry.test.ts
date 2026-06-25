import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import {
  getResource,
  getResourceByHash,
  hashContent,
  listResources,
  registerResource,
  resolveRegistryFile,
} from './resource-registry.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'resource-registry-'));
  clearConfigCache(tempDir);
});

afterEach(async () => {
  clearConfigCache(tempDir);
  await rm(tempDir, { recursive: true, force: true });
});

describe('resource-registry', () => {
  it('registers and reads back a resource version', async () => {
    const resource = registerResource({
      type: 'prompt',
      name: 'issue-writer',
      content: 'prompt body',
    }, { repoDir: tempDir });

    assert.ok(resource);
    assert.equal(resource?.type, 'prompt');
    assert.equal(getResource(resource!.id, resource!.version, tempDir)?.id, resource!.id);
    assert.equal(listResources({}, tempDir).length, 1);
  });

  it('deduplicates identical content for the same type and name', async () => {
    const first = registerResource({
      type: 'memory',
      name: 'project-context',
      content: 'same',
    }, { repoDir: tempDir });
    const second = registerResource({
      type: 'memory',
      name: 'project-context',
      content: 'same',
    }, { repoDir: tempDir });

    assert.equal(first?.id, second?.id);
    assert.equal(listResources({}, tempDir).length, 1);
  });

  it('skips malformed lines when listing resources', async () => {
    const registryFile = resolveRegistryFile(tempDir);
    await mkdir(dirname(registryFile), { recursive: true });
    await writeFile(registryFile, '{"bad":\n{"id":"ok","type":"tool","name":"codex","version":"1","contentHash":"abc","createdAt":"2026-04-21T00:00:00.000Z"}\n', 'utf-8');
    const records = listResources({}, tempDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].name, 'codex');
  });

  it('supports lookup by content hash', () => {
    registerResource({
      type: 'tool',
      name: 'node',
      content: 'v22.0.0',
    }, { repoDir: tempDir });

    const found = getResourceByHash('tool', hashContent('v22.0.0'), tempDir);
    assert.ok(found);
    assert.equal(found?.name, 'node');
  });

  it('returns null when registry is disabled', async () => {
    await writeFile(join(tempDir, '.wavemill-config.json'), JSON.stringify({
      registry: { enabled: false },
    }), 'utf-8');
    clearConfigCache(tempDir);

    const result = registerResource({
      type: 'prompt',
      name: 'disabled',
      content: 'x',
    }, { repoDir: tempDir });

    assert.equal(result, null);
    assert.equal(existsSync(resolveRegistryFile(tempDir)), false);
  });

  it('registers and reads back a runtime resource', () => {
    const resource = registerResource({
      type: 'runtime',
      name: 'openai:gpt-4o',
      content: JSON.stringify({ provider: 'openai', model: 'gpt-4o', api: 'openai-responses' }),
      metadata: { provider: 'openai', model: 'gpt-4o', api: 'openai-responses' },
    }, { repoDir: tempDir });

    assert.ok(resource, 'runtime resource must be registered');
    assert.equal(resource?.type, 'runtime');
    assert.equal(resource?.name, 'openai:gpt-4o');

    const listed = listResources({ type: 'runtime' }, tempDir);
    assert.equal(listed.length, 1, 'exactly one runtime resource');
    assert.equal(listed[0].metadata?.provider, 'openai');
  });
});
