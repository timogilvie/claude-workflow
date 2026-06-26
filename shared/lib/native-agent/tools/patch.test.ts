import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  applyPatchAfterToolCall,
  createApplyPatchTool,
  type ApplyPatchDetails,
} from './apply-patch-tool.ts';

const dirsToClean = new Set<string>();

after(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-agent patch recovery', () => {
  it('recovers from a rejected patch with diagnostics and changed-file tracking', async () => {
    const repo = createRepo('native-patch-recovery-');
    writeFixture(repo, 'src/app.ts', 'export const value = 1;\n');

    const tool = createApplyPatchTool(repo);
    const rejected = await tool.execute('call-1', {
      patch: {
        version: 1,
        atomic: true,
        operations: [
          {
            op: 'edit',
            path: 'src/app.ts',
            oldText: 'export const value = 0;\n',
            newText: 'export const value = 2;\n',
          },
        ],
      },
    });

    const rejectedDetails = rejected.details as ApplyPatchDetails;
    assert.equal(rejectedDetails.ok, false);
    if (!rejectedDetails.ok) {
      assert.equal(rejectedDetails.error, 'patch_rejected');
      assert.equal(rejectedDetails.retryHint, 'Refresh the patch against the latest file contents.');
      assert.equal(rejectedDetails.diagnostics?.code, 'old_text_not_found');
    }

    const rejectedAfterCall = await applyPatchAfterToolCall({
      toolCall: { name: 'apply_patch' },
      result: rejected,
    });
    assert.deepEqual(rejectedAfterCall, { isError: true });
    assert.equal(readFileSync(path.join(repo, 'src/app.ts'), 'utf-8'), 'export const value = 1;\n');

    const recovered = await tool.execute('call-2', {
      patch: {
        version: 1,
        atomic: true,
        operations: [
          {
            op: 'edit',
            path: 'src/app.ts',
            oldText: 'export const value = 1;\n',
            newText: 'export const value = 2;\n',
          },
        ],
      },
    });

    const recoveredDetails = recovered.details as ApplyPatchDetails;
    assert.equal(recoveredDetails.ok, true);
    if (recoveredDetails.ok) {
      assert.deepEqual(recoveredDetails.changedFiles, ['src/app.ts']);
      assert.deepEqual(recoveredDetails.fileChanges, [{ path: 'src/app.ts', linesAdded: 1, linesRemoved: 1 }]);
      assert.equal(recoveredDetails.linesAdded, 1);
      assert.equal(recoveredDetails.linesRemoved, 1);
    }
    assert.equal(readFileSync(path.join(repo, 'src/app.ts'), 'utf-8'), 'export const value = 2;\n');
  });

  it('recovers from a schema-invalid payload on retry', async () => {
    const repo = createRepo('native-patch-schema-recovery-');
    writeFixture(repo, 'src/app.ts', 'export const value = 1;\n');

    const tool = createApplyPatchTool(repo);
    const invalid = await tool.execute('call-3', {
      patch: {
        version: 1,
        atomic: true,
        operations: [],
      } as any,
    });

    const invalidDetails = invalid.details as ApplyPatchDetails;
    assert.equal(invalidDetails.ok, false);
    if (!invalidDetails.ok) {
      assert.equal(invalidDetails.error, 'invalid_patch');
      assert.equal(invalidDetails.retryHint, 'Fix the patch schema errors and retry with a valid NativePatch payload.');
      assert.ok(Array.isArray(invalidDetails.diagnostics));
    }

    const invalidAfterCall = await applyPatchAfterToolCall({
      toolCall: { name: 'apply_patch' },
      result: invalid,
    });
    assert.deepEqual(invalidAfterCall, { isError: true });

    const recovered = await tool.execute('call-4', {
      patch: {
        version: 1,
        atomic: true,
        operations: [
          {
            op: 'edit',
            path: 'src/app.ts',
            oldText: 'export const value = 1;\n',
            newText: 'export const value = 3;\n',
          },
        ],
      },
    });

    const recoveredDetails = recovered.details as ApplyPatchDetails;
    assert.equal(recoveredDetails.ok, true);
    if (recoveredDetails.ok) {
      assert.deepEqual(recoveredDetails.changedFiles, ['src/app.ts']);
      assert.equal(recoveredDetails.linesAdded, 1);
      assert.equal(recoveredDetails.linesRemoved, 1);
    }
    assert.equal(readFileSync(path.join(repo, 'src/app.ts'), 'utf-8'), 'export const value = 3;\n');
  });
});

function createRepo(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirsToClean.add(dir);
  return dir;
}

function writeFixture(repo: string, relativePath: string, contents: string): void {
  const absolutePath = path.join(repo, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf-8');
}
