import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createApplyPatchTool, type ApplyPatchDetails } from './apply-patch-tool.ts';

const dirsToClean = new Set<string>();

after(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-agent patch recovery smoke', () => {
  it('recovers from an invalid patch payload and applies the corrected edit', async () => {
    const repo = createRepo('apply-patch-recovery-invalid-');
    writeFixture(repo, 'src/app.ts', 'export const count = 1;\n');
    const tool = createApplyPatchTool(repo);

    const invalidResult = await tool.execute('call-invalid', {
      patch: {
        version: 1,
        atomic: true,
        operations: [],
      } as any,
    });

    const invalidDetails = invalidResult.details as ApplyPatchDetails;
    assert.equal(invalidDetails.ok, false);
    if (!invalidDetails.ok) {
      assert.equal(invalidDetails.error, 'invalid_patch');
      assert.equal(invalidDetails.retryHint, 'Fix the patch schema errors and retry with the valid NativePatch example shown in the tool result.');
      assert.ok(Array.isArray(invalidDetails.diagnostics));
      assert.ok(invalidDetails.diagnostics.length > 0);
    }

    const recoveredResult = await tool.execute('call-valid', {
      patch: {
        version: 1,
        atomic: true,
        operations: [{
          op: 'edit',
          path: 'src/app.ts',
          oldText: 'export const count = 1;\n',
          newText: 'export const count = 2;\n',
        }],
      },
    });

    const recoveredDetails = recoveredResult.details as ApplyPatchDetails;
    assert.equal(recoveredDetails.ok, true);
    if (recoveredDetails.ok) {
      assert.deepEqual(recoveredDetails.changedFiles, ['src/app.ts']);
      assert.equal(recoveredDetails.linesAdded, 1);
      assert.equal(recoveredDetails.linesRemoved, 1);
      assert.equal(readFileSync(path.join(repo, 'src/app.ts'), 'utf-8'), 'export const count = 2;\n');
    }
  });

  it('recovers from stale oldText diagnostics by retrying with live file contents', async () => {
    const repo = createRepo('apply-patch-recovery-stale-');
    writeFixture(repo, 'src/app.ts', "export const message = 'before';\n");
    const tool = createApplyPatchTool(repo);

    const rejectedResult = await tool.execute('call-stale', {
      patch: {
        version: 1,
        atomic: true,
        operations: [{
          op: 'edit',
          path: 'src/app.ts',
          oldText: "export const message = 'stale';\n",
          newText: "export const message = 'after';\n",
        }],
      },
    });

    const rejectedDetails = rejectedResult.details as ApplyPatchDetails;
    assert.equal(rejectedDetails.ok, false);
    if (!rejectedDetails.ok) {
      assert.equal(rejectedDetails.error, 'patch_rejected');
      assert.equal(rejectedDetails.retryHint, 'Refresh the patch against the latest file contents.');
      assert.equal(rejectedDetails.diagnostics?.code, 'old_text_not_found');
      assert.equal(rejectedDetails.diagnostics?.liveContext?.path, 'src/app.ts');
    }

    const liveContents = readFileSync(path.join(repo, 'src/app.ts'), 'utf-8');
    const recoveredResult = await tool.execute('call-refresh', {
      patch: {
        version: 1,
        atomic: true,
        operations: [{
          op: 'edit',
          path: 'src/app.ts',
          oldText: liveContents,
          newText: "export const message = 'after';\n",
        }],
      },
    });

    const recoveredDetails = recoveredResult.details as ApplyPatchDetails;
    assert.equal(recoveredDetails.ok, true);
    if (recoveredDetails.ok) {
      assert.deepEqual(recoveredDetails.changedFiles, ['src/app.ts']);
      assert.equal(recoveredDetails.linesAdded, 1);
      assert.equal(recoveredDetails.linesRemoved, 1);
      assert.equal(readFileSync(path.join(repo, 'src/app.ts'), 'utf-8'), "export const message = 'after';\n");
    }
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
