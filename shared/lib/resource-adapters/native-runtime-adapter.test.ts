import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from '../config.ts';
import { listResources, registerResource } from '../resource-registry.ts';
import { registerNativeRuntime, type NativeToolSummary } from './native-runtime-adapter.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'native-runtime-adapter-'));
  clearConfigCache(tempDir);
});

afterEach(async () => {
  clearConfigCache(tempDir);
  await rm(tempDir, { recursive: true, force: true });
});

const TOOLS: NativeToolSummary[] = [
  { name: 'read_file', class: 'read-only' },
  { name: 'list_files', class: 'read-only' },
  { name: 'git_status', class: 'read-only' },
];

describe('registerNativeRuntime', () => {
  it('registers a runtime resource with provider/model/api metadata', () => {
    const refs = registerNativeRuntime({
      phase: 'planning',
      provider: 'openai',
      model: 'gpt-4o',
      api: 'openai-responses',
      tools: TOOLS,
      repoDir: tempDir,
    });

    assert.ok(refs.runtime, 'runtime ref must be non-null');
    assert.ok(refs.runtime.id.startsWith('runtime:'), `runtime id must start with "runtime:"; got ${refs.runtime.id}`);

    const runtimeResources = listResources({ type: 'runtime' }, tempDir);
    assert.equal(runtimeResources.length, 1, 'exactly one runtime resource should be registered');

    const resource = runtimeResources[0];
    assert.equal(resource.metadata?.provider, 'openai');
    assert.equal(resource.metadata?.model, 'gpt-4o');
    assert.equal(resource.metadata?.api, 'openai-responses');
  });

  it('registers an agent-config resource capturing phase tool set', () => {
    registerNativeRuntime({
      phase: 'planning',
      provider: 'openai',
      model: 'gpt-4o',
      api: 'openai-responses',
      tools: TOOLS,
      repoDir: tempDir,
    });

    const configResources = listResources({ type: 'agent-config' }, tempDir);
    assert.equal(configResources.length, 1, 'exactly one agent-config resource should be registered');

    const resource = configResources[0];
    assert.equal(resource.name, 'native:planning');
    assert.equal(resource.metadata?.phase, 'planning');

    const toolNames = resource.metadata?.toolNames as string[];
    assert.ok(Array.isArray(toolNames), 'toolNames must be an array');
    assert.ok(toolNames.includes('read_file'), 'read_file must be in toolNames');
    assert.ok(toolNames.includes('list_files'), 'list_files must be in toolNames');
    assert.ok(toolNames.includes('git_status'), 'git_status must be in toolNames');
  });

  it('links the runtime resource as a dependency of the tool-set resource', () => {
    const refs = registerNativeRuntime({
      phase: 'planning',
      provider: 'openai',
      model: 'gpt-4o',
      api: 'openai-responses',
      tools: TOOLS,
      repoDir: tempDir,
    });

    assert.ok(refs.runtime, 'runtime ref must be present');
    assert.ok(refs.toolSet, 'toolSet ref must be present');

    const configResources = listResources({ type: 'agent-config' }, tempDir);
    const deps = configResources[0].dependencies ?? [];
    const depIds = deps.map((d) => d.id);
    assert.ok(depIds.includes(refs.runtime!.id), 'runtime ref must be a dependency of the tool-set');
  });

  it('links the prompt ref as a dependency of the tool-set when provided', () => {
    // Register a prompt resource to produce a real ref.
    const promptResource = registerResource(
      { type: 'prompt', name: 'native-read-only-phase', content: 'system prompt' },
      { repoDir: tempDir },
    );
    const promptRef = promptResource ? { id: promptResource.id, version: promptResource.version } : null;
    assert.ok(promptRef, 'prompt ref setup must succeed');

    registerNativeRuntime({
      phase: 'planning',
      provider: 'openai',
      model: 'gpt-4o',
      api: 'openai-responses',
      tools: TOOLS,
      promptRef,
      repoDir: tempDir,
    });

    const configResources = listResources({ type: 'agent-config' }, tempDir);
    const deps = configResources[0].dependencies ?? [];
    const depIds = deps.map((d) => d.id);
    assert.ok(depIds.includes(promptRef.id), 'prompt ref must be a dependency of the tool-set');
  });

  it('deduplicates identical registrations (idempotent)', () => {
    registerNativeRuntime({
      phase: 'planning',
      provider: 'openai',
      model: 'gpt-4o',
      api: 'openai-responses',
      tools: TOOLS,
      repoDir: tempDir,
    });

    registerNativeRuntime({
      phase: 'planning',
      provider: 'openai',
      model: 'gpt-4o',
      api: 'openai-responses',
      tools: TOOLS,
      repoDir: tempDir,
    });

    assert.equal(listResources({ type: 'runtime' }, tempDir).length, 1, 'runtime resource must be deduplicated');
    assert.equal(listResources({ type: 'agent-config' }, tempDir).length, 1, 'tool-set resource must be deduplicated');
  });

  it('produces separate resources for different providers', () => {
    registerNativeRuntime({
      phase: 'planning',
      provider: 'openai',
      model: 'gpt-4o',
      api: 'openai-responses',
      tools: TOOLS,
      repoDir: tempDir,
    });

    registerNativeRuntime({
      phase: 'planning',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      api: 'openai-completions',
      tools: TOOLS,
      repoDir: tempDir,
    });

    assert.equal(listResources({ type: 'runtime' }, tempDir).length, 2, 'two runtime resources for two providers');
  });

  it('returns null refs when registry is disabled', async () => {
    await writeFile(
      join(tempDir, '.wavemill-config.json'),
      JSON.stringify({ registry: { enabled: false } }),
      'utf-8',
    );
    clearConfigCache(tempDir);

    const refs = registerNativeRuntime({
      phase: 'planning',
      provider: 'openai',
      model: 'gpt-4o',
      api: 'openai-responses',
      tools: TOOLS,
      repoDir: tempDir,
    });

    assert.equal(refs.runtime, null, 'runtime must be null when registry disabled');
    assert.equal(refs.toolSet, null, 'toolSet must be null when registry disabled');
  });
});
