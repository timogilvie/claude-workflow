import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  createRunCommandTool,
  createRunTestsTool,
  createCommandTools,
  type CommandDetails,
} from './command-tool.ts';

// ---------------------------------------------------------------------------
// Helpers
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
// Factory shape
// ---------------------------------------------------------------------------

describe('createCommandTools', () => {
  it('creates both run_command and run_tests tools', () => {
    const tools = createCommandTools('/worktree');
    assert.equal(tools.length, 2);
    assert.equal(tools[0].metadata.name, 'run_command');
    assert.equal(tools[1].metadata.name, 'run_tests');
  });

  it('both tools are mutation class with sequential execution', () => {
    const tools = createCommandTools('/worktree');
    for (const tool of tools) {
      assert.equal(tool.metadata.class, 'mutation');
      assert.equal(tool.metadata.executionMode, 'sequential');
      assert.equal(tool.metadata.outputCapPolicy.strategy, 'truncate');
    }
  });

  it('both tools default to coding phase', () => {
    const tools = createCommandTools('/worktree');
    for (const tool of tools) {
      assert.ok(tool.metadata.allowedPhases.includes('coding'));
    }
  });

  it('phase override is respected for run_command', () => {
    const tool = createRunCommandTool('/worktree', { phase: 'review' });
    assert.ok(tool.metadata.allowedPhases.includes('review'));
  });

  it('phase override is respected for run_tests', () => {
    const tool = createRunTestsTool('/worktree', { phase: 'review' });
    assert.ok(tool.metadata.allowedPhases.includes('review'));
  });
});

// ---------------------------------------------------------------------------
// Successful command — approval and classification metadata
// ---------------------------------------------------------------------------

describe('successful command execution', () => {
  it('details include commandClass=safe, approval=approved, and exitCode=0', async () => {
    const worktree = makeTempDir('cmd-tool-success-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-1', { command: 'echo hello' });

    const details = result.details as CommandDetails;
    assert.equal(details.commandClass, 'safe');
    assert.equal(details.approval, 'approved');
    assert.equal(details.rejectionReason, undefined);
    assert.equal(details.exitCode, 0);
    assert.equal(details.timedOut, false);
    assert.ok(typeof details.durationMs === 'number' && details.durationMs >= 0);
  });

  it('details include cwd matching the worktree root by default', async () => {
    const worktree = makeTempDir('cmd-tool-cwd-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-2', { command: 'echo hello' });

    const details = result.details as CommandDetails;
    assert.equal(details.cwd, worktree);
  });

  it('details include cwd when explicit cwd is provided', async () => {
    const worktree = makeTempDir('cmd-tool-explicit-cwd-');
    const sub = path.join(worktree, 'sub');
    mkdirSync(sub);
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-3', { command: 'echo hello', cwd: sub });

    const details = result.details as CommandDetails;
    assert.equal(details.cwd, sub);
  });

  it('stdout is captured in details', async () => {
    const worktree = makeTempDir('cmd-tool-stdout-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-4', { command: 'echo world' });

    const details = result.details as CommandDetails;
    assert.ok(details.stdout.includes('world'));
  });

  it('content text contains the command output', async () => {
    const worktree = makeTempDir('cmd-tool-content-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-5', { command: 'echo greetings' });

    const text = result.content.find((b) => b.type === 'text')?.text ?? '';
    assert.ok(text.includes('greetings'));
  });

  it('retainedBytes reflects captured output byte length', async () => {
    const worktree = makeTempDir('cmd-tool-bytes-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-6', { command: 'echo hello' });

    const details = result.details as CommandDetails;
    assert.ok(typeof details.retainedBytes === 'number');
    const expectedBytes =
      Buffer.byteLength(details.stdout, 'utf8') + Buffer.byteLength(details.stderr, 'utf8');
    assert.equal(details.retainedBytes, expectedBytes);
  });
});

// ---------------------------------------------------------------------------
// Rejected command — dangerous pattern
// ---------------------------------------------------------------------------

describe('rejected command — dangerous pattern', () => {
  it('details include approval=rejected and a rejectionReason', async () => {
    const worktree = makeTempDir('cmd-tool-reject-danger-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-7', { command: 'rm -rf /' });

    const details = result.details as CommandDetails;
    assert.equal(details.approval, 'rejected');
    assert.ok(typeof details.rejectionReason === 'string' && details.rejectionReason.length > 0);
  });

  it('details include commandClass for rejected commands', async () => {
    const worktree = makeTempDir('cmd-tool-reject-class-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-8', { command: 'rm -rf /' });

    const details = result.details as CommandDetails;
    assert.equal(details.commandClass, 'dangerous');
  });

  it('rejected details include cwd and durationMs even without process spawn', async () => {
    const worktree = makeTempDir('cmd-tool-reject-meta-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-9', { command: 'sudo ls' });

    const details = result.details as CommandDetails;
    assert.equal(details.approval, 'rejected');
    assert.equal(details.cwd, worktree);
    assert.ok(typeof details.durationMs === 'number');
    assert.equal(details.exitCode, null);
    assert.equal(details.stdout, '');
    assert.equal(details.stderr, '');
    assert.equal(details.truncated, false);
    assert.equal(details.retainedBytes, 0);
  });

  it('content text indicates rejection reason', async () => {
    const worktree = makeTempDir('cmd-tool-reject-content-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-10', { command: 'rm -rf /' });

    const text = result.content.find((b) => b.type === 'text')?.text ?? '';
    assert.ok(text.includes('rejected'));
  });
});

// ---------------------------------------------------------------------------
// Rejected command — cwd outside allowed roots
// ---------------------------------------------------------------------------

describe('rejected command — cwd outside allowed roots', () => {
  it('details include approval=rejected and cwd-outside-allowed-roots reason', async () => {
    const worktree = makeTempDir('cmd-tool-reject-cwd-allowed-');
    const outside = makeTempDir('cmd-tool-reject-cwd-outside-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-11', { command: 'echo hello', cwd: outside });

    const details = result.details as CommandDetails;
    assert.equal(details.approval, 'rejected');
    assert.equal(details.rejectionReason, 'cwd-outside-allowed-roots');
    assert.equal(details.cwd, outside);
  });
});

// ---------------------------------------------------------------------------
// Truncation metadata
// ---------------------------------------------------------------------------

describe('truncation metadata', () => {
  it('truncated=true and bounded retainedBytes when output exceeds cap', async () => {
    const worktree = makeTempDir('cmd-tool-truncate-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-12', {
      command: `node -e "process.stdout.write('x'.repeat(200000))"`,
      maxOutputBytes: 1024,
    });

    const details = result.details as CommandDetails;
    assert.equal(details.truncated, true);
    assert.ok(details.retainedBytes > 0);
    assert.ok(details.retainedBytes <= 2048, `retainedBytes (${details.retainedBytes}) should be near cap`);
  });

  it('truncated=false when output fits within cap', async () => {
    const worktree = makeTempDir('cmd-tool-no-truncate-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-13', {
      command: 'echo small output',
      maxOutputBytes: 65536,
    });

    const details = result.details as CommandDetails;
    assert.equal(details.truncated, false);
  });

  it('retainedBytes is zero for rejected commands', async () => {
    const worktree = makeTempDir('cmd-tool-truncate-rejected-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-14', { command: 'rm -rf /' });

    const details = result.details as CommandDetails;
    assert.equal(details.retainedBytes, 0);
  });
});

// ---------------------------------------------------------------------------
// run_tests tool has same behavior
// ---------------------------------------------------------------------------

describe('run_tests tool', () => {
  it('details include commandClass and approval for successful test run', async () => {
    const worktree = makeTempDir('run-tests-success-');
    const tool = createRunTestsTool(worktree);

    const result = await tool.execute('tc-15', { command: 'echo tests passed' });

    const details = result.details as CommandDetails;
    assert.equal(details.commandClass, 'safe');
    assert.equal(details.approval, 'approved');
    assert.equal(details.exitCode, 0);
  });

  it('rejected test command includes rejectionReason', async () => {
    const worktree = makeTempDir('run-tests-reject-');
    const tool = createRunTestsTool(worktree);

    const result = await tool.execute('tc-16', { command: 'rm -rf /' });

    const details = result.details as CommandDetails;
    assert.equal(details.approval, 'rejected');
    assert.ok(typeof details.rejectionReason === 'string');
  });
});

// ---------------------------------------------------------------------------
// Empty command handling
// ---------------------------------------------------------------------------

describe('empty command', () => {
  it('empty command string returns rejected details with empty-command reason', async () => {
    const worktree = makeTempDir('cmd-tool-empty-');
    const tool = createRunCommandTool(worktree);

    const result = await tool.execute('tc-17', { command: '   ' });

    const details = result.details as CommandDetails;
    assert.equal(details.approval, 'rejected');
    assert.equal(details.rejectionReason, 'empty-command');
    assert.equal(details.exitCode, null);
  });
});
