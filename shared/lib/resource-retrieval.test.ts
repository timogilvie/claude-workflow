import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  resolvePromptResource,
  resolveMemoryResource,
  resolvePolicyResource,
  resolveResource,
  resolvePromptPath,
} from './resource-retrieval.ts';
import { listResources } from './resource-registry.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'resource-retrieval-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('resolvePromptResource', () => {
  it('resolves the planning phase prompt', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'planning',
      role: 'phase',
    });
    assert.ok(result.content.length > 0);
    assert.match(result.path, /planning-phase\.md$/);
    assert.equal(result.selectedStability, 'stable');
    assert.equal(result.metadata['stage'], 'planning');
    assert.equal(result.metadata['role'], 'phase');
  });

  it('resolves the coding phase prompt', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'coding',
      role: 'phase',
    });
    assert.match(result.path, /coding-phase\.md$/);
    assert.ok(result.content.length > 0);
  });

  it('resolves the review phase prompt', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'review',
      role: 'phase',
    });
    assert.match(result.path, /review-phase\.md$/);
  });

  it('resolves the general reviewer prompt in normal mode', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'review',
      role: 'reviewer',
      operatingMode: 'normal',
      persona: 'general',
    });
    assert.match(result.path, /review-general\.md$/);
    assert.equal(result.metadata['persona'], 'general');
    assert.equal(result.metadata['operatingMode'], 'normal');
  });

  it('resolves the scoped general reviewer prompt in constrained mode', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'review',
      role: 'reviewer',
      operatingMode: 'constrained',
      persona: 'general',
    });
    assert.match(result.path, /review-general-scoped\.md$/);
  });

  it('resolves the scoped general reviewer prompt in survival mode', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'review',
      role: 'reviewer',
      operatingMode: 'survival',
      persona: 'general',
    });
    assert.match(result.path, /review-general-scoped\.md$/);
  });

  it('resolves non-general reviewer personas without mode sensitivity', async () => {
    for (const persona of ['security', 'performance', 'correctness', 'design'] as const) {
      const result = await resolvePromptResource({
        class: 'prompt',
        stage: 'review',
        role: 'reviewer',
        persona,
      });
      assert.match(result.path, new RegExp(`review-${persona}\\.md$`), `persona ${persona}`);
    }
  });

  it('resolves initiative planner prompt in normal mode', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'initiative-planning',
      role: 'planner',
      operatingMode: 'normal',
    });
    assert.match(result.path, /initiative-planner\.md$/);
  });

  it('resolves compressed initiative planner in constrained mode', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'initiative-planning',
      role: 'planner',
      operatingMode: 'constrained',
    });
    assert.match(result.path, /initiative-planner-compressed\.md$/);
  });

  it('resolves compressed initiative planner in survival mode', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'initiative-planning',
      role: 'planner',
      operatingMode: 'survival',
    });
    assert.match(result.path, /initiative-planner-compressed\.md$/);
  });

  it('defaults stability to stable', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'eval',
      role: 'judge',
    });
    assert.equal(result.selectedStability, 'stable');
  });

  it('rejects unsupported stability channels', async () => {
    await assert.rejects(
      () => resolvePromptResource({
        class: 'prompt',
        stage: 'planning',
        role: 'phase',
        stability: 'canary',
      }),
      /canary.*not yet supported/,
    );
  });

  it('produces a clear error for unknown stage/role combinations', async () => {
    await assert.rejects(
      () => resolvePromptResource({
        class: 'prompt',
        stage: 'eval',
        role: 'writer' as never,
      }),
      /No prompt catalog entry.*stage="eval".*role="writer"/,
    );
  });

  it('includes the request in the error message', async () => {
    let caught: Error | null = null;
    try {
      await resolvePromptResource({
        class: 'prompt',
        stage: 'eval',
        role: 'writer' as never,
      });
    } catch (err) {
      caught = err as Error;
    }
    assert.ok(caught, 'should have thrown');
    assert.match(caught.message, /stage="eval"/);
    assert.match(caught.message, /role="writer"/);
  });

  it('registers typed metadata on prompt resources', async () => {
    await resolvePromptResource({
      class: 'prompt',
      stage: 'eval',
      role: 'judge',
      repoDir: tempDir,
    });
    const resources = listResources({ type: 'prompt' }, tempDir);
    const evalJudge = resources.find((r) => r.name === 'eval-judge');
    assert.ok(evalJudge, 'eval-judge should be registered');
    assert.equal(evalJudge?.metadata?.['stage'], 'eval');
    assert.equal(evalJudge?.metadata?.['role'], 'judge');
    assert.equal(evalJudge?.metadata?.['stability'], 'stable');
  });

  it('returns a resourceRef when registry is active', async () => {
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'planning',
      role: 'phase',
      repoDir: tempDir,
    });
    assert.ok(result.resourceRef !== null, 'should return a resourceRef');
    assert.ok(result.resourceRef?.id);
    assert.ok(result.resourceRef?.version);
  });

  it('still returns content when registry is disabled', async () => {
    const wavemillDir = join(tempDir, '.wavemill');
    await mkdir(wavemillDir, { recursive: true });
    await writeFile(
      join(tempDir, '.wavemill-config.json'),
      JSON.stringify({ registry: { enabled: false } }),
    );
    const result = await resolvePromptResource({
      class: 'prompt',
      stage: 'planning',
      role: 'phase',
      repoDir: tempDir,
    });
    assert.ok(result.content.length > 0, 'content should be returned even when registry disabled');
    assert.equal(result.resourceRef, null);
  });
});

describe('resolveMemoryResource', () => {
  it('returns null when hot memory file does not exist', async () => {
    const result = await resolveMemoryResource({
      class: 'memory',
      tier: 'hot',
      repoDir: tempDir,
    });
    assert.equal(result, null);
  });

  it('resolves hot project memory from a temp repo', async () => {
    const wavemillDir = join(tempDir, '.wavemill');
    await mkdir(wavemillDir, { recursive: true });
    await writeFile(join(wavemillDir, 'project-context.md'), '# Project Context\n\nTest content.');

    const result = await resolveMemoryResource({
      class: 'memory',
      tier: 'hot',
      repoDir: tempDir,
    });
    assert.ok(result, 'should resolve');
    assert.match(result!.path, /project-context\.md$/);
    assert.equal(result!.content, '# Project Context\n\nTest content.');
    assert.equal(result!.metadata['tier'], 'hot');
    assert.equal(result!.selectedStability, 'stable');
  });

  it('resolves cold subsystem memory', async () => {
    const contextDir = join(tempDir, '.wavemill', 'context');
    await mkdir(contextDir, { recursive: true });
    await writeFile(join(contextDir, 'linear-api.md'), '# Subsystem: linear-api');

    const result = await resolveMemoryResource({
      class: 'memory',
      tier: 'cold',
      repoDir: tempDir,
      subsystemId: 'linear-api',
    });
    assert.ok(result, 'should resolve');
    assert.match(result!.path, /linear-api\.md$/);
    assert.equal(result!.metadata['subsystemId'], 'linear-api');
    assert.equal(result!.metadata['tier'], 'cold');
  });

  it('resolves concept memory', async () => {
    const conceptsDir = join(tempDir, '.wavemill', 'context', 'concepts');
    await mkdir(conceptsDir, { recursive: true });
    await writeFile(join(conceptsDir, 'progressive-disclosure.md'), '# Concept: progressive-disclosure');

    const result = await resolveMemoryResource({
      class: 'memory',
      tier: 'concept',
      repoDir: tempDir,
      conceptId: 'progressive-disclosure',
    });
    assert.ok(result, 'should resolve');
    assert.match(result!.path, /progressive-disclosure\.md$/);
    assert.equal(result!.metadata['conceptId'], 'progressive-disclosure');
    assert.equal(result!.metadata['tier'], 'concept');
  });

  it('returns null when cold subsystem file is missing', async () => {
    const result = await resolveMemoryResource({
      class: 'memory',
      tier: 'cold',
      repoDir: tempDir,
      subsystemId: 'nonexistent',
    });
    assert.equal(result, null);
  });

  it('returns null when concept file is missing', async () => {
    const result = await resolveMemoryResource({
      class: 'memory',
      tier: 'concept',
      repoDir: tempDir,
      conceptId: 'nonexistent',
    });
    assert.equal(result, null);
  });

  it('throws when tier is cold and subsystemId is missing', async () => {
    await assert.rejects(
      () => resolveMemoryResource({
        class: 'memory',
        tier: 'cold',
        repoDir: tempDir,
      }),
      /subsystemId is required/,
    );
  });

  it('throws when tier is concept and conceptId is missing', async () => {
    await assert.rejects(
      () => resolveMemoryResource({
        class: 'memory',
        tier: 'concept',
        repoDir: tempDir,
      }),
      /conceptId is required/,
    );
  });

  it('registers hot memory resource in registry', async () => {
    const wavemillDir = join(tempDir, '.wavemill');
    await mkdir(wavemillDir, { recursive: true });
    await writeFile(join(wavemillDir, 'project-context.md'), '# Test');

    await resolveMemoryResource({
      class: 'memory',
      tier: 'hot',
      repoDir: tempDir,
    });

    const resources = listResources({ type: 'memory' }, tempDir);
    const hot = resources.find((r) => r.name.includes('project-context'));
    assert.ok(hot, 'project-context should be registered');
    assert.equal(hot?.metadata?.['tier'], 'hot');
  });
});

describe('resolvePolicyResource', () => {
  it('resolves wavemill config policy', async () => {
    const config = { registry: { enabled: true } };
    await writeFile(join(tempDir, '.wavemill-config.json'), JSON.stringify(config));

    const result = await resolvePolicyResource({
      class: 'policy',
      name: 'config',
      repoDir: tempDir,
    });
    assert.ok(result.content.includes('"registry"'));
    assert.match(result.path, /\.wavemill-config\.json$/);
    assert.equal(result.metadata['policyName'], 'config');
  });

  it('throws when policy file does not exist', async () => {
    await assert.rejects(
      () => resolvePolicyResource({
        class: 'policy',
        name: 'config',
        repoDir: tempDir,
      }),
      /Policy resource "config" not found/,
    );
  });

  it('registers policy as agent-config type in registry', async () => {
    await writeFile(join(tempDir, '.wavemill-config.json'), '{}');

    await resolvePolicyResource({
      class: 'policy',
      name: 'config',
      repoDir: tempDir,
    });

    const resources = listResources({ type: 'agent-config' }, tempDir);
    const policy = resources.find((r) => r.name === 'policy:config');
    assert.ok(policy, 'policy should be registered as agent-config');
    assert.equal(policy?.metadata?.['policyName'], 'config');
  });
});

describe('resolveResource dispatcher', () => {
  it('dispatches to resolvePromptResource', async () => {
    const result = await resolveResource({
      class: 'prompt',
      stage: 'eval',
      role: 'judge',
    });
    assert.ok(result);
    assert.match(result!.path, /eval-judge\.md$/);
  });

  it('dispatches to resolveMemoryResource and returns null when missing', async () => {
    const result = await resolveResource({
      class: 'memory',
      tier: 'hot',
      repoDir: tempDir,
    });
    assert.equal(result, null);
  });

  it('dispatches to resolvePolicyResource', async () => {
    await writeFile(join(tempDir, '.wavemill-config.json'), '{}');
    const result = await resolveResource({
      class: 'policy',
      name: 'config',
      repoDir: tempDir,
    });
    assert.ok(result);
    assert.match(result!.path, /\.wavemill-config\.json$/);
  });
});

describe('resolvePromptPath', () => {
  it('returns absolute path for known stage/role', () => {
    const p = resolvePromptPath({ class: 'prompt', stage: 'planning', role: 'phase' });
    assert.ok(p);
    assert.match(p!, /planning-phase\.md$/);
  });

  it('returns undefined for unknown stage/role', () => {
    const p = resolvePromptPath({ class: 'prompt', stage: 'eval', role: 'writer' as never });
    assert.equal(p, undefined);
  });

  it('accounts for operatingMode in path selection', () => {
    const normal = resolvePromptPath({
      class: 'prompt',
      stage: 'review',
      role: 'reviewer',
      operatingMode: 'normal',
      persona: 'general',
    });
    const constrained = resolvePromptPath({
      class: 'prompt',
      stage: 'review',
      role: 'reviewer',
      operatingMode: 'constrained',
      persona: 'general',
    });
    assert.ok(normal);
    assert.ok(constrained);
    assert.notEqual(normal, constrained);
    assert.match(normal!, /review-general\.md$/);
    assert.match(constrained!, /review-general-scoped\.md$/);
  });
});
