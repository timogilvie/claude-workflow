import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { evaluateBeforeToolCallPolicy } from './policies.ts';
import { createToolRegistry } from './registry.ts';
import {
  CODING_TOOL_NAMES,
  codingAfterToolCall,
  codingToolPolicyConfig,
  createApplyPatchTool,
  createCodingTools,
  createCreateMarkerTool,
  createUpdateStatusTool,
  createWriteArtifactTool,
  type ApplyPatchDetails,
  type CreateMarkerDetails,
  type UpdateStatusDetails,
  type WriteArtifactDetails,
} from './coding.ts';

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
  return makeTempDir('coding-tools-test-');
}

describe('native-agent coding tools metadata', () => {
  it('exposes four coding-only mutation tools and policy metadata', () => {
    const registry = createToolRegistry(createCodingTools('/repo'));
    const metadata = registry.list();

    assert.deepEqual(metadata.map((tool) => tool.name), [...CODING_TOOL_NAMES]);
    assert.deepEqual(codingToolPolicyConfig, {
      pathFieldsByTool: {
        write_artifact: ['path'],
        create_marker: ['path'],
      },
    });

    for (const tool of metadata) {
      assert.equal(tool.class, 'mutation');
      assert.deepEqual(tool.allowedPhases, ['coding']);
      assert.equal(tool.executionMode, 'sequential');
      assert.deepEqual(tool.outputCapPolicy, { strategy: 'none' });
    }
  });
});

describe('apply_patch', () => {
  it('applies a valid edit and returns changed-file summaries', async () => {
    const wt = makeWorktree();
    writeFileSync(path.join(wt, 'src.txt'), 'alpha\nbeta\n');

    const tool = createApplyPatchTool(wt);
    const result = await tool.execute('call-1', {
      version: 1,
      atomic: true,
      operations: [
        {
          op: 'edit',
          path: 'src.txt',
          oldText: 'beta\n',
          newText: 'gamma\n',
        },
      ],
    });
    const details = result.details as ApplyPatchDetails;

    assert.equal(readFileSync(path.join(wt, 'src.txt'), 'utf8'), 'alpha\ngamma\n');
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.appliedOperations, 1);
      assert.deepEqual(details.changedFiles, [{ path: 'src.txt', linesAdded: 1, linesRemoved: 1 }]);
      assert.equal(details.linesAdded, 1);
      assert.equal(details.linesRemoved, 1);
    }
  });

  it('applies multiple operations across two files', async () => {
    const wt = makeWorktree();
    writeFileSync(path.join(wt, 'one.txt'), 'one\n');
    writeFileSync(path.join(wt, 'two.txt'), 'two\n');

    const tool = createApplyPatchTool(wt);
    const result = await tool.execute('call-2', {
      version: 1,
      atomic: true,
      operations: [
        { op: 'edit', path: 'one.txt', oldText: 'one\n', newText: 'one updated\n' },
        { op: 'edit', path: 'two.txt', oldText: 'two\n', newText: 'two updated\n' },
      ],
    });
    const details = result.details as ApplyPatchDetails;

    assert.equal(readFileSync(path.join(wt, 'one.txt'), 'utf8'), 'one updated\n');
    assert.equal(readFileSync(path.join(wt, 'two.txt'), 'utf8'), 'two updated\n');
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.appliedOperations, 2);
      assert.deepEqual(details.changedFiles.map((file) => file.path), ['one.txt', 'two.txt']);
    }
  });

  it('returns structured rejections with retry hints and leaves files unchanged', async () => {
    const wt = makeWorktree();
    writeFileSync(path.join(wt, 'src.txt'), 'alpha\nbeta\n');

    const tool = createApplyPatchTool(wt);
    const result = await tool.execute('call-3', {
      version: 1,
      atomic: true,
      operations: [
        {
          op: 'edit',
          path: 'src.txt',
          oldText: 'missing\n',
          newText: 'gamma\n',
        },
      ],
    });
    const details = result.details as ApplyPatchDetails;

    assert.equal(readFileSync(path.join(wt, 'src.txt'), 'utf8'), 'alpha\nbeta\n');
    assert.equal(details.ok, false);
    if (!details.ok && 'rejection' in details) {
      assert.equal(details.rejection.code, 'old_text_not_found');
      assert.equal(typeof details.retryHint, 'string');
      assert.notEqual(details.retryHint.length, 0);
    } else {
      assert.fail('expected rejection details');
    }
  });

  it('preserves atomicity when a later operation fails', async () => {
    const wt = makeWorktree();
    writeFileSync(path.join(wt, 'one.txt'), 'one\n');
    writeFileSync(path.join(wt, 'two.txt'), 'two\n');

    const tool = createApplyPatchTool(wt);
    const result = await tool.execute('call-4', {
      version: 1,
      atomic: true,
      operations: [
        { op: 'edit', path: 'one.txt', oldText: 'one\n', newText: 'one updated\n' },
        { op: 'edit', path: 'two.txt', oldText: 'missing\n', newText: 'two updated\n' },
      ],
    });
    const details = result.details as ApplyPatchDetails;

    assert.equal(readFileSync(path.join(wt, 'one.txt'), 'utf8'), 'one\n');
    assert.equal(readFileSync(path.join(wt, 'two.txt'), 'utf8'), 'two\n');
    assert.equal(details.ok, false);
  });

  it('returns invalid_patch for malformed input', async () => {
    const wt = makeWorktree();
    const tool = createApplyPatchTool(wt);
    const result = await tool.execute('call-5', { version: 1, atomic: false, operations: [] });
    const details = result.details as ApplyPatchDetails;

    assert.equal(details.ok, false);
    if (!details.ok && 'code' in details) {
      assert.equal(details.code, 'invalid_patch');
      assert.ok(details.errors.length > 0);
    } else {
      assert.fail('expected invalid_patch details');
    }
  });
});

describe('write_artifact', () => {
  it('writes allowlisted artifact content', async () => {
    const wt = makeWorktree();
    const tool = createWriteArtifactTool(wt, { generatedPaths: ['dist/**'] });
    const result = await tool.execute('call-1', { path: 'dist/output.json', content: '{"ok":true}\n' });
    const details = result.details as WriteArtifactDetails;

    assert.equal(readFileSync(path.join(wt, 'dist/output.json'), 'utf8'), '{"ok":true}\n');
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.path, 'dist/output.json');
      assert.equal(details.bytesWritten, Buffer.byteLength('{"ok":true}\n', 'utf8'));
    }
  });

  it('rejects non-allowlisted source writes by default', async () => {
    const wt = makeWorktree();
    const tool = createWriteArtifactTool(wt);
    const result = await tool.execute('call-2', { path: 'src/app.ts', content: 'export {};\n' });
    const details = result.details as WriteArtifactDetails;

    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.code, 'whole_file_source_write_denied');
    }
    assert.equal(statExists(path.join(wt, 'src/app.ts')), false);
  });

  it('rejects traversal paths', async () => {
    const wt = makeWorktree();
    const tool = createWriteArtifactTool(wt, { generatedPaths: ['dist/**'] });
    const result = await tool.execute('call-3', { path: '../escape.txt', content: 'nope' });
    const details = result.details as WriteArtifactDetails;

    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.code, 'path_denied');
    }
  });
});

describe('create_marker', () => {
  it('creates a marker file with content', async () => {
    const wt = makeWorktree();
    const tool = createCreateMarkerTool(wt, { wavemillOwnedPaths: ['features/task/.coding-complete'] });
    const result = await tool.execute('call-1', {
      path: 'features/task/.coding-complete',
      content: 'confidence=high\n',
    });
    const details = result.details as CreateMarkerDetails;

    assert.equal(readFileSync(path.join(wt, 'features/task/.coding-complete'), 'utf8'), 'confidence=high\n');
    assert.equal(details.ok, true);
  });

  it('creates an empty marker when content is omitted', async () => {
    const wt = makeWorktree();
    const tool = createCreateMarkerTool(wt, { wavemillOwnedPaths: ['features/task/.marker'] });
    const result = await tool.execute('call-2', { path: 'features/task/.marker' });
    const details = result.details as CreateMarkerDetails;

    assert.equal(readFileSync(path.join(wt, 'features/task/.marker'), 'utf8'), '');
    assert.equal(details.ok, true);
  });

  it('rejects paths outside the worktree', async () => {
    const wt = makeWorktree();
    const tool = createCreateMarkerTool(wt, { wavemillOwnedPaths: ['features/task/.marker'] });
    const result = await tool.execute('call-3', { path: '../outside.marker' });
    const details = result.details as CreateMarkerDetails;

    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.code, 'path_denied');
    }
  });
});

describe('update_status', () => {
  it('appends durable JSONL status records', async () => {
    const wt = makeWorktree();
    const tool = createUpdateStatusTool(wt);
    const result = await tool.execute('call-1', { status: 'running', detail: 'editing files' });
    const details = result.details as UpdateStatusDetails;
    const statusPath = path.join(wt, '.wavemill', 'native-coding-status.jsonl');

    assert.equal(details.ok, true);
    const lines = readFileSync(statusPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]!);
    assert.equal(record.status, 'running');
    assert.equal(record.detail, 'editing files');
    assert.equal(typeof record.timestamp, 'number');
  });

  it('appends multiple records across multiple calls', async () => {
    const wt = makeWorktree();
    const tool = createUpdateStatusTool(wt);

    await tool.execute('call-1', { status: 'running' });
    await tool.execute('call-2', { status: 'done' });

    const lines = readFileSync(path.join(wt, '.wavemill', 'native-coding-status.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).status), ['running', 'done']);
  });

  it('redacts secrets before persisting detail', async () => {
    const wt = makeWorktree();
    const tool = createUpdateStatusTool(wt);

    await tool.execute('call-1', { status: 'running', detail: 'token sk-abcdefghijklmnopqrstuvwxyz123456' });

    const persisted = readFileSync(path.join(wt, '.wavemill', 'native-coding-status.jsonl'), 'utf8');
    assert.match(persisted, /\[REDACTED\]/);
    assert.doesNotMatch(persisted, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  });
});

describe('coding tool phase gating', () => {
  it('denies coding tools in review phase', () => {
    const registry = createToolRegistry(createCodingTools('/repo')).list();

    for (const name of CODING_TOOL_NAMES) {
      const decision = evaluateBeforeToolCallPolicy({
        phase: 'review',
        worktreePath: '/repo',
        registry,
        config: codingToolPolicyConfig,
        toolCall: { name, arguments: {} },
      });

      assert.deepEqual(decision, {
        kind: 'deny',
        reason: 'phase_denied',
        message: `phase_denied: tool "${name}" is not allowed in review`,
      });
    }
  });

  it('allows coding tools in coding phase', () => {
    const registry = createToolRegistry(createCodingTools('/repo')).list();

    for (const name of CODING_TOOL_NAMES) {
      const argumentsByTool: Record<string, Record<string, unknown>> = {
        apply_patch: {},
        write_artifact: { path: 'dist/out.txt' },
        create_marker: { path: 'features/task/.marker' },
        update_status: {},
      };
      const decision = evaluateBeforeToolCallPolicy({
        phase: 'coding',
        worktreePath: '/repo',
        registry,
        config: codingToolPolicyConfig,
        toolCall: { name, arguments: argumentsByTool[name] ?? {} },
      });

      assert.deepEqual(decision, { kind: 'allow' });
    }
  });
});

describe('codingAfterToolCall', () => {
  it('marks failed coding tool results as errors', async () => {
    const result = await codingAfterToolCall({
      toolCall: { name: 'write_artifact' },
      result: { details: { ok: false, code: 'path_denied', message: 'denied' } },
    });

    assert.deepEqual(result, { isError: true });
  });

  it('ignores successful coding tool results', async () => {
    const result = await codingAfterToolCall({
      toolCall: { name: 'update_status' },
      result: { details: { ok: true, status: 'running', timestamp: 1 } },
    });

    assert.equal(result, undefined);
  });

  it('ignores unknown tools', async () => {
    const result = await codingAfterToolCall({
      toolCall: { name: 'read_file' },
      result: { details: { ok: false } },
    });

    assert.equal(result, undefined);
  });
});

function statExists(targetPath: string): boolean {
  try {
    statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}
