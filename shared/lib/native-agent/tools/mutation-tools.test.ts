import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  codingMutationAfterToolCall,
  codingMutationPolicyConfig,
  createCodingMutationTools,
  createCreateMarkerTool,
  createUpdateStatusTool,
  createWriteArtifactTool,
  type CreateMarkerDetails,
  type UpdateStatusDetails,
  type WriteArtifactDetails,
} from './mutation-tools.ts';

const dirsToClean = new Set<string>();

after(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-agent mutation tools', () => {
  it('exposes all coding mutation tools and path policy metadata', () => {
    const tools = createCodingMutationTools('/repo');
    assert.deepEqual(tools.map((tool) => tool.metadata.name), [
      'apply_patch',
      'write_artifact',
      'create_marker',
      'update_status',
    ]);
    assert.deepEqual(codingMutationPolicyConfig, {
      pathFieldsByTool: {
        write_artifact: ['path'],
        create_marker: ['path'],
      },
    });
  });

  it('writes artifacts to allowlisted paths', async () => {
    const repo = createRepo('mutation-artifact-success-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-1', {
      path: 'features/demo/output.json',
      content: '{"ok":true}\n',
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.resolvedPath, 'features/demo/output.json');
      assert.equal(details.bytesWritten, Buffer.byteLength('{"ok":true}\n', 'utf-8'));
      assert.equal(readFileSync(path.join(repo, details.resolvedPath), 'utf-8'), '{"ok":true}\n');
    }
  });

  it('rejects whole-file writes to source paths with a retry hint', async () => {
    const repo = createRepo('mutation-artifact-source-denied-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-2', {
      path: 'src/app.ts',
      content: 'export const value = 1;\n',
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'whole_file_source_write_denied');
      assert.equal(details.retryHint, 'use apply_patch for source edits');
      assert.match(details.message, /not generated or Wavemill-owned/);
    }
  });

  it('rejects artifact writes outside the worktree', async () => {
    const repo = createRepo('mutation-artifact-path-denied-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-3', {
      path: '../secret.txt',
      content: 'secret\n',
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'path_denied');
      assert.match(details.message, /outside the active worktree/);
    }

    const afterCall = await codingMutationAfterToolCall({
      toolCall: { name: 'write_artifact' },
      result,
    });
    assert.deepEqual(afterCall, { isError: true });
  });

  it('creates marker files in allowlisted locations', async () => {
    const repo = createRepo('mutation-marker-success-');
    const tool = createCreateMarkerTool(repo);

    const result = await tool.execute('call-4', {
      path: 'features/demo/.coding-complete',
    });

    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.resolvedPath, 'features/demo/.coding-complete');
      assert.equal(readFileSync(path.join(repo, details.resolvedPath), 'utf-8'), '');
    }
  });

  it('rejects markers outside the whole-file allowlist', async () => {
    const repo = createRepo('mutation-marker-denied-');
    const tool = createCreateMarkerTool(repo);

    const result = await tool.execute('call-5', {
      path: 'src/.marker',
      content: 'x',
    });

    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'whole_file_source_write_denied');
      assert.equal(details.retryHint, 'use apply_patch for source edits');
    }
  });

  it('writes durable status updates and leaves no temp files behind', async () => {
    const repo = createRepo('mutation-status-success-');
    const statusPath = path.join(repo, '.wavemill', 'status.json');
    const tool = createUpdateStatusTool(repo, { statusPath });

    const result = await tool.execute('call-6', {
      state: 'working',
      message: 'editing native tools',
      detail: 'phase 2',
    });

    const details = result.details as UpdateStatusDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.statusPath, statusPath);
      const saved = JSON.parse(readFileSync(statusPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(saved.state, 'working');
      assert.equal(saved.event, 'update_status');
      assert.equal(saved.message, 'editing native tools');
      assert.equal(saved.detail, 'phase 2');
      assert.match(result.content[0]!.text, /"tool":"update_status"/);
      assert.deepEqual(
        readdirSync(path.dirname(statusPath)).filter((entry) => entry.endsWith('.tmp')),
        [],
      );
    }
  });

  it('rejects invalid status states', async () => {
    const repo = createRepo('mutation-status-invalid-');
    const tool = createUpdateStatusTool(repo);

    const result = await tool.execute('call-7', {
      state: 'done' as any,
    });

    const details = result.details as UpdateStatusDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'invalid_input');
      assert.match(details.message, /state must be one of/);
    }
  });
});

function createRepo(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirsToClean.add(dir);
  return dir;
}
