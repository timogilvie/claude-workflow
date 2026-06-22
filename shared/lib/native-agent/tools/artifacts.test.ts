import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  createArtifactTools,
  createReadTaskPacketTool,
  createReadPlanTool,
  ARTIFACT_TOOL_NAMES,
} from './artifacts.ts';
import type { ToolErrorDetails, ReadTaskPacketDetails, ReadPlanDetails } from './artifacts.ts';

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

// ---------------------------------------------------------------------------
// Valid task packet content (passes isTaskPacketContent)
// ---------------------------------------------------------------------------

const VALID_TASK_PACKET = `## Objective
Implement a new feature for the system.

## Technical Context
This uses the existing infrastructure.

## Success Criteria
- Feature is complete
- Tests pass
`;

const VALID_PLAN = `# Implementation Plan

This plan covers the implementation steps.

## Phase 1
Do some work.

## Phase 2
Do more work.
`;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeWorktree(): string {
  return makeTempDir('artifact-tools-test-');
}

function makeFeatureDir(worktree: string, slug: string, root: 'features' | 'bugs' = 'features'): string {
  const featureDir = path.join(worktree, root, slug);
  mkdirSync(featureDir, { recursive: true });
  return featureDir;
}

// ---------------------------------------------------------------------------
// Factory / metadata tests
// ---------------------------------------------------------------------------

describe('createArtifactTools — factory and metadata', () => {
  it('returns exactly two descriptors', () => {
    const wt = makeWorktree();
    const tools = createArtifactTools(wt);
    assert.equal(tools.length, 2);
  });

  it('descriptors are named read_task_packet and read_plan', () => {
    const wt = makeWorktree();
    const tools = createArtifactTools(wt);
    const names = tools.map(t => t.metadata.name);
    assert.deepEqual(names, ['read_task_packet', 'read_plan']);
  });

  it('both tools have class read-only', () => {
    const wt = makeWorktree();
    const tools = createArtifactTools(wt);
    for (const tool of tools) {
      assert.equal(tool.metadata.class, 'read-only');
    }
  });

  it('both tools allow planning phase', () => {
    const wt = makeWorktree();
    const tools = createArtifactTools(wt);
    for (const tool of tools) {
      assert.ok(tool.metadata.allowedPhases.includes('planning'));
    }
  });

  it('both tools have executionMode parallel', () => {
    const wt = makeWorktree();
    const tools = createArtifactTools(wt);
    for (const tool of tools) {
      assert.equal(tool.metadata.executionMode, 'parallel');
    }
  });

  it('ARTIFACT_TOOL_NAMES matches descriptor names', () => {
    const wt = makeWorktree();
    const tools = createArtifactTools(wt);
    for (const name of ARTIFACT_TOOL_NAMES) {
      assert.ok(tools.some(t => t.metadata.name === name));
    }
  });
});

// ---------------------------------------------------------------------------
// read_task_packet — success cases
// ---------------------------------------------------------------------------

describe('read_task_packet — full task-packet.md', () => {
  it('returns content and details.format === full', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'my-feature');
    writeFileSync(path.join(featureDir, 'task-packet.md'), VALID_TASK_PACKET);

    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'my-feature' });
    const details = result.details as ReadTaskPacketDetails;

    assert.ok(result.content[0]!.text.includes('Objective'));
    assert.equal(details.format, 'full');
    assert.equal(details.truncated, false);
    assert.ok(details.resolvedPath.includes('task-packet.md'));
  });
});

describe('read_task_packet — split header+details format', () => {
  it('joins header and details with separator, format === split', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'split-feature');
    writeFileSync(path.join(featureDir, 'task-packet-header.md'), VALID_TASK_PACKET);
    writeFileSync(path.join(featureDir, 'task-packet-details.md'), '## Technical Context\nMore details here.');

    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'split-feature' });
    const details = result.details as ReadTaskPacketDetails;

    assert.equal(details.format, 'split');
    assert.ok(result.content[0]!.text.includes('\n\n---\n\n'));
    assert.ok(result.content[0]!.text.includes('Objective'));
    assert.ok(result.content[0]!.text.includes('More details here.'));
    assert.equal(details.truncated, false);
  });
});

describe('read_task_packet — header-only format', () => {
  it('returns header content, format === header-only', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'header-only-feature');
    writeFileSync(path.join(featureDir, 'task-packet-header.md'), VALID_TASK_PACKET);

    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'header-only-feature' });
    const details = result.details as ReadTaskPacketDetails;

    assert.equal(details.format, 'header-only');
    assert.ok(result.content[0]!.text.includes('Objective'));
    assert.equal(details.truncated, false);
  });
});

describe('read_task_packet — bugs/ root fallback', () => {
  it('resolves from bugs/<slug>/ when features/ is absent', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'my-bug', 'bugs');
    writeFileSync(path.join(featureDir, 'task-packet.md'), VALID_TASK_PACKET);

    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'my-bug' });
    const details = result.details as ReadTaskPacketDetails;

    assert.equal(details.format, 'full');
    assert.ok(result.content[0]!.text.includes('Objective'));
  });

  it('features/ takes precedence over bugs/ when both exist', async () => {
    const wt = makeWorktree();
    const featuresDir = makeFeatureDir(wt, 'shared-slug', 'features');
    const bugsDir = makeFeatureDir(wt, 'shared-slug', 'bugs');
    writeFileSync(path.join(featuresDir, 'task-packet.md'), '## Objective\nFrom features.');
    writeFileSync(path.join(bugsDir, 'task-packet.md'), '## Objective\nFrom bugs.');

    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'shared-slug' });

    assert.ok(result.content[0]!.text.includes('From features.'));
  });
});

// ---------------------------------------------------------------------------
// read_task_packet — error cases
// ---------------------------------------------------------------------------

describe('read_task_packet — invalid_params', () => {
  it('empty slug → invalid_params', async () => {
    const wt = makeWorktree();
    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: '' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'invalid_params');
  });

  it('missing slug → invalid_params', async () => {
    const wt = makeWorktree();
    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', {} as { slug: string });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'invalid_params');
  });

  it('non-string slug → invalid_params', async () => {
    const wt = makeWorktree();
    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 42 } as unknown as { slug: string });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'invalid_params');
  });
});

describe('read_task_packet — path_denied', () => {
  it('../escape slug → path_denied', async () => {
    const wt = makeWorktree();
    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: '../escape' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'path_denied');
  });

  it('a/b slug → path_denied', async () => {
    const wt = makeWorktree();
    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'a/b' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'path_denied');
  });

  it('.. slug → path_denied', async () => {
    const wt = makeWorktree();
    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: '..' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'path_denied');
  });

  it('. slug → path_denied', async () => {
    const wt = makeWorktree();
    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: '.' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'path_denied');
  });

  it('backslash separator in slug → path_denied', async () => {
    const wt = makeWorktree();
    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'a\\b' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'path_denied');
  });

  it('/etc/passwd slug → path_denied', async () => {
    const wt = makeWorktree();
    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: '/etc/passwd' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'path_denied');
  });

  it('features/<slug> symlinked outside worktree → path_denied', async () => {
    const wt = makeWorktree();
    const external = makeTempDir('artifact-external-');
    // Put a real task-packet.md in the external dir so realpath succeeds
    writeFileSync(path.join(external, 'task-packet.md'), VALID_TASK_PACKET);

    mkdirSync(path.join(wt, 'features'));
    symlinkSync(external, path.join(wt, 'features', 'escaped'));

    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'escaped' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'path_denied');
  });
});

describe('read_task_packet — not_found', () => {
  it('feature dir absent → not_found', async () => {
    const wt = makeWorktree();
    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'nonexistent' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'not_found');
  });

  it('feature dir present but no task-packet files → not_found', async () => {
    const wt = makeWorktree();
    makeFeatureDir(wt, 'empty-feature');

    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'empty-feature' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'not_found');
  });
});

describe('read_task_packet — malformed', () => {
  it('file present but not task-packet content → malformed', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'bad-content');
    writeFileSync(path.join(featureDir, 'task-packet.md'), 'hello world, this is not a task packet');

    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'bad-content' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'malformed');
  });

  it('binary task-packet.md (NUL byte) → malformed', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'binary-packet');
    const binaryContent = Buffer.from([0x23, 0x23, 0x00, 0x61, 0x62, 0x63]); // '##\0abc'
    writeFileSync(path.join(featureDir, 'task-packet.md'), binaryContent);

    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'binary-packet' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'malformed');
  });
});

describe('read_task_packet — truncation', () => {
  it('oversized packet → truncated=true and footer present', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'big-feature');

    // Build content larger than 256KB that still passes isTaskPacketContent
    const header = '## Objective\nThis is a large task packet.\n\n';
    const padding = 'x'.repeat(260 * 1024);
    writeFileSync(path.join(featureDir, 'task-packet.md'), header + padding);

    const tool = createReadTaskPacketTool(wt);
    const result = await tool.execute('call-1', { slug: 'big-feature' });
    const details = result.details as ReadTaskPacketDetails;

    assert.equal(details.truncated, true);
    assert.ok(result.content[0]!.text.includes('[Truncated:'));
    assert.ok(Buffer.byteLength(result.content[0]!.text, 'utf8') > 256 * 1024); // footer makes it slightly over
  });
});

// ---------------------------------------------------------------------------
// read_plan — success cases
// ---------------------------------------------------------------------------

describe('read_plan — features/ success', () => {
  it('returns plan content from features/<slug>/plan.md', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'planned-feature');
    writeFileSync(path.join(featureDir, 'plan.md'), VALID_PLAN);

    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: 'planned-feature' });
    const details = result.details as ReadPlanDetails;

    assert.ok(result.content[0]!.text.includes('Implementation Plan'));
    assert.equal(details.truncated, false);
    assert.ok(details.resolvedPath.includes('plan.md'));
  });
});

describe('read_plan — bugs/ fallback', () => {
  it('returns plan content from bugs/<slug>/plan.md when features/ absent', async () => {
    const wt = makeWorktree();
    const bugDir = makeFeatureDir(wt, 'tracked-bug', 'bugs');
    writeFileSync(path.join(bugDir, 'plan.md'), VALID_PLAN);

    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: 'tracked-bug' });
    const details = result.details as ReadPlanDetails;

    assert.ok(result.content[0]!.text.includes('Implementation Plan'));
    assert.equal(details.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// read_plan — error cases
// ---------------------------------------------------------------------------

describe('read_plan — not_found', () => {
  it('feature dir absent → not_found', async () => {
    const wt = makeWorktree();
    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: 'no-such-feature' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'not_found');
  });

  it('feature dir present but no plan.md → not_found', async () => {
    const wt = makeWorktree();
    makeFeatureDir(wt, 'no-plan');

    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: 'no-plan' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'not_found');
  });
});

describe('read_plan — malformed', () => {
  it('empty plan.md → malformed', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'empty-plan');
    writeFileSync(path.join(featureDir, 'plan.md'), '');

    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: 'empty-plan' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'malformed');
  });

  it('whitespace-only plan.md → malformed', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'whitespace-plan');
    writeFileSync(path.join(featureDir, 'plan.md'), '   \n\t\n  ');

    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: 'whitespace-plan' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'malformed');
  });

  it('binary plan.md → malformed', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'binary-plan');
    const binaryContent = Buffer.from([0x23, 0x00, 0x61, 0x62]); // '#\0ab'
    writeFileSync(path.join(featureDir, 'plan.md'), binaryContent);

    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: 'binary-plan' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'malformed');
  });
});

describe('read_plan — path_denied', () => {
  it('../escape slug → path_denied', async () => {
    const wt = makeWorktree();
    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: '../escape' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'path_denied');
  });

  it('a/b slug → path_denied', async () => {
    const wt = makeWorktree();
    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: 'a/b' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'path_denied');
  });

  it('empty slug → invalid_params', async () => {
    const wt = makeWorktree();
    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: '' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'invalid_params');
  });
});

describe('read_plan — truncation', () => {
  it('oversized plan → truncated=true and footer present', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'huge-plan');
    const bigPlan = '# Plan\n\n' + 'y'.repeat(260 * 1024);
    writeFileSync(path.join(featureDir, 'plan.md'), bigPlan);

    const tool = createReadPlanTool(wt);
    const result = await tool.execute('call-1', { slug: 'huge-plan' });
    const details = result.details as ReadPlanDetails;

    assert.equal(details.truncated, true);
    assert.ok(result.content[0]!.text.includes('[Truncated:'));
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — planning artifact inspection
// ---------------------------------------------------------------------------

describe('lifecycle — planning artifact inspection', () => {
  it('planning session can read both task packet and plan', async () => {
    const wt = makeWorktree();
    const featureDir = makeFeatureDir(wt, 'lifecycle-feature');
    writeFileSync(path.join(featureDir, 'task-packet.md'), VALID_TASK_PACKET);
    writeFileSync(path.join(featureDir, 'plan.md'), VALID_PLAN);

    // Simulate a selected-task.json alongside (realistic fixture)
    writeFileSync(
      path.join(featureDir, 'selected-task.json'),
      JSON.stringify({ id: 'HOK-1234', title: 'lifecycle-feature', slug: 'lifecycle-feature' }),
    );

    const tools = createArtifactTools(wt);
    const [readTaskPacket, readPlan] = tools;
    assert.ok(readTaskPacket && readPlan);

    const packetResult = await readTaskPacket.execute('t1', { slug: 'lifecycle-feature' });
    const planResult = await readPlan.execute('t2', { slug: 'lifecycle-feature' });

    assert.ok(packetResult.content[0]!.text.includes('Objective'));
    assert.ok(planResult.content[0]!.text.includes('Implementation Plan'));

    const packetDetails = packetResult.details as ReadTaskPacketDetails;
    const planDetails = planResult.details as ReadPlanDetails;
    assert.equal(packetDetails.truncated, false);
    assert.equal(planDetails.truncated, false);
  });

  it('sibling-feature path traversal slug is denied', async () => {
    const wt = makeWorktree();
    makeFeatureDir(wt, 'feature-a');
    makeFeatureDir(wt, 'feature-b');
    writeFileSync(path.join(wt, 'features', 'feature-b', 'task-packet.md'), VALID_TASK_PACKET);

    const tools = createArtifactTools(wt);
    const [readTaskPacket] = tools;
    assert.ok(readTaskPacket);

    // Attempt to traverse from feature-a into feature-b via slug traversal
    const result = await readTaskPacket.execute('t1', { slug: '../feature-b' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.error, 'path_denied');
  });

  it('all planning phases are available on both tools', async () => {
    const wt = makeWorktree();
    const tools = createArtifactTools(wt);
    for (const tool of tools) {
      assert.ok(tool.metadata.allowedPhases.includes('planning'));
      assert.ok(tool.metadata.allowedPhases.includes('coding'));
      assert.ok(tool.metadata.allowedPhases.includes('review'));
    }
  });
});
