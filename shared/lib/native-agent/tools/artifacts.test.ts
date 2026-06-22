import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  createArtifactTools,
  createReadTaskPacketTool,
  createReadPlanTool,
  artifactAfterToolCall,
  type ArtifactToolErrorDetails,
  type ReadTaskPacketDetails,
  type ReadPlanDetails,
} from './artifacts.ts';
import { createToolRegistry } from './registry.ts';
import { createReadOnlyTools } from './read-only.ts';
import { createGitTools, gitAfterToolCall } from './git.ts';
import { evaluateBeforeToolCallPolicy } from './policies.ts';
import { toPiAgentTool } from './pi-adapter.ts';
import { runWavemillLoop } from '../loop.ts';

// ---------------------------------------------------------------------------
// Minimal valid task packet content (passes isTaskPacketContent)
// ---------------------------------------------------------------------------

const VALID_TASK_PACKET = `# Task Packet: Demo Feature

## Quick Reference

- Objective: Do something useful

## 1. Objective

Complete the demo feature.

## Success Criteria

- Feature works
`;

const VALID_PLAN = `# Demo Feature Plan

## Phase 1

Do the first thing.

## Phase 2

Do the second thing.
`;

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorktree(): string {
  return makeTempDir('artifact-tools-test-');
}

function writeFeatureFile(worktree: string, slug: string, filename: string, content: string): void {
  const dir = path.join(worktree, 'features', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), content);
}

// ---------------------------------------------------------------------------
// Descriptor metadata
// ---------------------------------------------------------------------------

describe('artifact tools — descriptor metadata', () => {
  it('exposes read_task_packet and read_plan with correct metadata', () => {
    const tools = createArtifactTools('/repo');
    const registry = createToolRegistry(tools);
    const metadata = registry.list();

    assert.deepEqual(
      metadata.map((m) => m.name),
      ['read_task_packet', 'read_plan'],
    );

    for (const meta of metadata) {
      assert.equal(meta.class, 'read-only');
      assert.equal(meta.executionMode, 'parallel');
      assert.deepEqual(meta.allowedPhases, ['planning', 'coding', 'review']);
      assert.equal(meta.outputCapPolicy.strategy, 'truncate');
      assert.equal(meta.outputCapPolicy.maxBytes, 256 * 1024);
    }
  });

  it('registering with read-only and git tools does not conflict', () => {
    const worktree = makeWorktree();
    const registry = createToolRegistry([
      ...createReadOnlyTools(worktree),
      ...createGitTools(worktree),
      ...createArtifactTools(worktree),
    ]);

    assert.equal(registry.has('read_file'), true);
    assert.equal(registry.has('git_status'), true);
    assert.equal(registry.has('read_task_packet'), true);
    assert.equal(registry.has('read_plan'), true);
  });
});

// ---------------------------------------------------------------------------
// read_task_packet — success cases
// ---------------------------------------------------------------------------

describe('read_task_packet — success', () => {
  it('returns canonical full packet when task-packet.md is valid', async () => {
    const worktree = makeWorktree();
    writeFeatureFile(worktree, 'demo', 'task-packet.md', VALID_TASK_PACKET);

    const tool = createReadTaskPacketTool(worktree);
    const result = await tool.execute('call-1', { slug: 'demo' });
    const details = result.details as ReadTaskPacketDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.tool, 'read_task_packet');
      assert.equal(details.slug, 'demo');
      assert.equal(details.artifact, 'full');
      assert.match(details.path, /features[/\\]demo[/\\]task-packet\.md/);
    }
    assert.ok(result.content[0]!.text.includes('Objective'));
  });

  it('falls back to header when canonical is absent and header is valid', async () => {
    const worktree = makeWorktree();
    writeFeatureFile(worktree, 'demo', 'task-packet-header.md', VALID_TASK_PACKET);

    const tool = createReadTaskPacketTool(worktree);
    const result = await tool.execute('call-2', { slug: 'demo' });
    const details = result.details as ReadTaskPacketDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.artifact, 'header');
      assert.match(details.path, /task-packet-header\.md/);
      assert.equal(details.detailsExists, false);
      assert.equal(details.detailsPath, undefined);
    }
  });

  it('header with details present marks detailsExists true and provides detailsPath', async () => {
    const worktree = makeWorktree();
    writeFeatureFile(worktree, 'demo', 'task-packet-header.md', VALID_TASK_PACKET);
    writeFeatureFile(worktree, 'demo', 'task-packet-details.md', '## Details\n\nFull content here.\n');

    const tool = createReadTaskPacketTool(worktree);
    const result = await tool.execute('call-3', { slug: 'demo' });
    const details = result.details as ReadTaskPacketDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.artifact, 'header');
      assert.equal(details.detailsExists, true);
      assert.ok(details.detailsPath !== undefined);
      assert.match(details.detailsPath!, /task-packet-details\.md/);
    }
  });

  it('canonical full packet takes precedence over header when both exist', async () => {
    const worktree = makeWorktree();
    writeFeatureFile(worktree, 'demo', 'task-packet.md', VALID_TASK_PACKET);
    writeFeatureFile(worktree, 'demo', 'task-packet-header.md', '## Header only content\nQuick Reference\n');

    const tool = createReadTaskPacketTool(worktree);
    const result = await tool.execute('call-4', { slug: 'demo' });
    const details = result.details as ReadTaskPacketDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.artifact, 'full');
    }
  });
});

// ---------------------------------------------------------------------------
// read_task_packet — error cases
// ---------------------------------------------------------------------------

describe('read_task_packet — errors', () => {
  it('returns absent when no candidate files exist', async () => {
    const worktree = makeWorktree();
    const tool = createReadTaskPacketTool(worktree);
    const result = await tool.execute('call-5', { slug: 'demo' });
    const details = result.details as ArtifactToolErrorDetails;

    assert.equal(details.ok, false);
    assert.equal(details.error.kind, 'absent');
    assert.ok(Array.isArray(details.error.candidates));
    assert.ok(details.error.candidates!.some((c) => c.includes('task-packet.md')));
  });

  it('returns malformed when canonical exists but fails validation', async () => {
    const worktree = makeWorktree();
    writeFeatureFile(worktree, 'demo', 'task-packet.md', 'This is not a valid task packet.\n');

    const tool = createReadTaskPacketTool(worktree);
    const result = await tool.execute('call-6', { slug: 'demo' });
    const details = result.details as ArtifactToolErrorDetails;

    assert.equal(details.ok, false);
    assert.equal(details.error.kind, 'malformed');
    assert.match(details.error.message, /task-packet\.md/);
  });

  it('does not fall through to header when canonical exists but is malformed', async () => {
    const worktree = makeWorktree();
    writeFeatureFile(worktree, 'demo', 'task-packet.md', 'Not a valid packet.\n');
    writeFeatureFile(worktree, 'demo', 'task-packet-header.md', VALID_TASK_PACKET);

    const tool = createReadTaskPacketTool(worktree);
    const result = await tool.execute('call-7', { slug: 'demo' });
    const details = result.details as ArtifactToolErrorDetails;

    assert.equal(details.ok, false);
    assert.equal(details.error.kind, 'malformed');
  });
});

// ---------------------------------------------------------------------------
// read_task_packet — slug validation
// ---------------------------------------------------------------------------

describe('read_task_packet — slug validation', () => {
  const DENIED_SLUGS = [
    '',
    ' ',
    '.',
    '..',
    '../outside',
    'demo/../outside',
    'demo\\..\\outside',
    '/tmp/x',
    'C:\\tmp\\x',
  ];

  for (const slug of DENIED_SLUGS) {
    it(`rejects slug '${slug}' with path-denied`, async () => {
      const worktree = makeWorktree();
      const tool = createReadTaskPacketTool(worktree);
      const result = await tool.execute('slug-deny', { slug });
      const details = result.details as ArtifactToolErrorDetails;

      assert.equal(details.ok, false, `Expected path-denied for slug '${slug}'`);
      assert.equal(details.error.kind, 'path-denied', `Expected kind=path-denied for slug '${slug}'`);
    });
  }
});

// ---------------------------------------------------------------------------
// read_plan — success cases
// ---------------------------------------------------------------------------

describe('read_plan — success', () => {
  it('returns plan content for a valid plan.md', async () => {
    const worktree = makeWorktree();
    writeFeatureFile(worktree, 'demo', 'plan.md', VALID_PLAN);

    const tool = createReadPlanTool(worktree);
    const result = await tool.execute('call-10', { slug: 'demo' });
    const details = result.details as ReadPlanDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.tool, 'read_plan');
      assert.equal(details.slug, 'demo');
      assert.equal(details.artifact, 'plan');
      assert.match(details.path, /features[/\\]demo[/\\]plan\.md/);
    }
    assert.ok(result.content[0]!.text.includes('Phase 1'));
  });
});

// ---------------------------------------------------------------------------
// read_plan — error cases
// ---------------------------------------------------------------------------

describe('read_plan — errors', () => {
  it('returns absent when plan.md does not exist', async () => {
    const worktree = makeWorktree();
    const tool = createReadPlanTool(worktree);
    const result = await tool.execute('call-11', { slug: 'demo' });
    const details = result.details as ArtifactToolErrorDetails;

    assert.equal(details.ok, false);
    assert.equal(details.error.kind, 'absent');
    assert.ok(Array.isArray(details.error.candidates));
    assert.ok(details.error.candidates!.some((c) => c.includes('plan.md')));
  });

  it('returns malformed when plan.md exists but is empty', async () => {
    const worktree = makeWorktree();
    writeFeatureFile(worktree, 'demo', 'plan.md', '   \n  \n  ');

    const tool = createReadPlanTool(worktree);
    const result = await tool.execute('call-12', { slug: 'demo' });
    const details = result.details as ArtifactToolErrorDetails;

    assert.equal(details.ok, false);
    assert.equal(details.error.kind, 'malformed');
  });
});

// ---------------------------------------------------------------------------
// read_plan — slug validation
// ---------------------------------------------------------------------------

describe('read_plan — slug validation', () => {
  const DENIED_SLUGS = [
    '',
    ' ',
    '.',
    '..',
    '../outside',
    'demo/../outside',
    'demo\\..\\outside',
    '/tmp/x',
    'C:\\tmp\\x',
  ];

  for (const slug of DENIED_SLUGS) {
    it(`rejects slug '${slug}' with path-denied`, async () => {
      const worktree = makeWorktree();
      const tool = createReadPlanTool(worktree);
      const result = await tool.execute('plan-deny', { slug });
      const details = result.details as ArtifactToolErrorDetails;

      assert.equal(details.ok, false, `Expected path-denied for slug '${slug}'`);
      assert.equal(details.error.kind, 'path-denied', `Expected kind=path-denied for slug '${slug}'`);
    });
  }
});

// ---------------------------------------------------------------------------
// Symlink escape containment
// ---------------------------------------------------------------------------

describe('artifact tools — symlink escape containment', () => {
  it('read_task_packet: symlink to outside worktree returns path-denied', async () => {
    const worktree = makeWorktree();
    const outside = makeTempDir('artifact-outside-');

    // Write real content outside the worktree
    writeFileSync(path.join(outside, 'secret.md'), VALID_TASK_PACKET);

    // Create symlink inside worktree pointing outside
    mkdirSync(path.join(worktree, 'features', 'demo'), { recursive: true });
    symlinkSync(
      path.join(outside, 'secret.md'),
      path.join(worktree, 'features', 'demo', 'task-packet.md'),
    );

    const tool = createReadTaskPacketTool(worktree);
    const result = await tool.execute('symlink-1', { slug: 'demo' });
    const details = result.details as ArtifactToolErrorDetails;

    assert.equal(details.ok, false);
    assert.equal(details.error.kind, 'path-denied');
    assert.doesNotMatch(result.content[0]!.text, /Objective/);
  });

  it('read_plan: symlink to outside worktree returns path-denied', async () => {
    const worktree = makeWorktree();
    const outside = makeTempDir('artifact-outside-plan-');

    writeFileSync(path.join(outside, 'secret-plan.md'), VALID_PLAN);

    mkdirSync(path.join(worktree, 'features', 'demo'), { recursive: true });
    symlinkSync(
      path.join(outside, 'secret-plan.md'),
      path.join(worktree, 'features', 'demo', 'plan.md'),
    );

    const tool = createReadPlanTool(worktree);
    const result = await tool.execute('symlink-2', { slug: 'demo' });
    const details = result.details as ArtifactToolErrorDetails;

    assert.equal(details.ok, false);
    assert.equal(details.error.kind, 'path-denied');
    assert.doesNotMatch(result.content[0]!.text, /Phase 1/);
  });
});

// ---------------------------------------------------------------------------
// artifactAfterToolCall hook
// ---------------------------------------------------------------------------

describe('artifactAfterToolCall', () => {
  it('returns isError: true for ok: false artifact result', async () => {
    const hookResult = await artifactAfterToolCall({
      toolCall: { name: 'read_task_packet' },
      result: {
        details: {
          ok: false,
          tool: 'read_task_packet',
          slug: 'demo',
          error: { kind: 'absent', code: 'absent', message: 'not found' },
        },
      },
    });

    assert.deepEqual(hookResult, { isError: true });
  });

  it('returns undefined for ok: true artifact result', async () => {
    const hookResult = await artifactAfterToolCall({
      toolCall: { name: 'read_plan' },
      result: {
        details: {
          ok: true,
          tool: 'read_plan',
          slug: 'demo',
          path: 'features/demo/plan.md',
          artifact: 'plan',
        },
      },
    });

    assert.equal(hookResult, undefined);
  });

  it('returns undefined for unrelated tool names', async () => {
    const hookResult = await artifactAfterToolCall({
      toolCall: { name: 'read_file' },
      result: { details: { ok: false } },
    });

    assert.equal(hookResult, undefined);
  });

  it('marks artifact error as isError in the wavemill loop', async () => {
    const worktree = makeWorktree();
    const tool = createReadTaskPacketTool(worktree);

    const { registerScriptedPiProvider } = await import('../provider.ts');
    const api = `artifact-loop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [
            {
              type: 'tool_call',
              id: 'art-1',
              name: 'read_task_packet',
              arguments: { slug: 'nonexistent' },
            },
          ],
          stopReason: 'tool_calls',
        },
        {
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
        },
      ],
    });

    const piIdentity = (messages: any[]): any[] => messages;
    const registry = createToolRegistry(createArtifactTools(worktree));

    const loopResult = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: {
        systemPrompt: 'You are a test agent.',
        messages: [{ role: 'user', content: 'Read the task packet.', timestamp: 0 }],
        tools: [toPiAgentTool(tool)],
      } as any,
      convertToLlm: piIdentity,
      afterToolCall: artifactAfterToolCall,
      toolPolicy: {
        phase: 'planning',
        worktreePath: worktree,
        registry: registry.list(),
        config: {},
      },
    });

    const toolResult = loopResult.messages.find(
      (message: any) =>
        message.role === 'toolResult' && message.toolName === 'read_task_packet',
    ) as any;

    assert.ok(toolResult, 'toolResult message should exist');
    assert.equal(toolResult.isError, true);
  });
});

// ---------------------------------------------------------------------------
// Phase policy: artifact tools allowed in planning
// ---------------------------------------------------------------------------

describe('artifact tools — phase policy', () => {
  it('planning phase allows read_task_packet and read_plan', () => {
    const worktree = makeWorktree();
    const registry = createToolRegistry(createArtifactTools(worktree));

    const taskPacketDecision = evaluateBeforeToolCallPolicy({
      phase: 'planning',
      worktreePath: worktree,
      registry: registry.list(),
      config: {},
      toolCall: { name: 'read_task_packet', arguments: { slug: 'demo' } },
    });

    const planDecision = evaluateBeforeToolCallPolicy({
      phase: 'planning',
      worktreePath: worktree,
      registry: registry.list(),
      config: {},
      toolCall: { name: 'read_plan', arguments: { slug: 'demo' } },
    });

    assert.deepEqual(taskPacketDecision, { kind: 'allow' });
    assert.deepEqual(planDecision, { kind: 'allow' });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle node-level coverage: native read-only planning artifact inspection
//
// This serves as the lifecycle fixture coverage for native read-only planning
// artifact inspection. The shell lifecycle harness does not yet invoke
// native-agent tools directly, so this node-level loop test covers the
// end-to-end scenario: tool registration → policy gate → executor → afterToolCall.
// ---------------------------------------------------------------------------

describe('lifecycle: native read-only planning artifact inspection', () => {
  it('planning session can inspect task packet and plan within feature boundaries', async () => {
    const worktree = makeWorktree();
    writeFeatureFile(worktree, 'my-feature', 'task-packet.md', VALID_TASK_PACKET);
    writeFeatureFile(worktree, 'my-feature', 'plan.md', VALID_PLAN);

    const taskPacketTool = createReadTaskPacketTool(worktree);
    const planTool = createReadPlanTool(worktree);
    const registry = createToolRegistry([...createArtifactTools(worktree)]);

    // Verify policy allows both tools in planning phase
    for (const name of ['read_task_packet', 'read_plan']) {
      const decision = evaluateBeforeToolCallPolicy({
        phase: 'planning',
        worktreePath: worktree,
        registry: registry.list(),
        config: {},
        toolCall: { name, arguments: { slug: 'my-feature' } },
      });
      assert.deepEqual(decision, { kind: 'allow' }, `Expected allow for ${name} in planning`);
    }

    // Verify executors return correct content
    const tpResult = await taskPacketTool.execute('lifecycle-tp', { slug: 'my-feature' });
    const tpDetails = tpResult.details as ReadTaskPacketDetails;
    assert.equal(tpDetails.ok, true);
    assert.ok(tpResult.content[0]!.text.includes('Objective'));

    const planResult = await planTool.execute('lifecycle-plan', { slug: 'my-feature' });
    const planDetails = planResult.details as ReadPlanDetails;
    assert.equal(planDetails.ok, true);
    assert.ok(planResult.content[0]!.text.includes('Phase 1'));

    // Verify artifact readers cannot escape feature boundaries
    const outsideResult = await taskPacketTool.execute('lifecycle-escape', {
      slug: '../outside',
    });
    const outsideDetails = outsideResult.details as ArtifactToolErrorDetails;
    assert.equal(outsideDetails.ok, false);
    assert.equal(outsideDetails.error.kind, 'path-denied');
  });
});
