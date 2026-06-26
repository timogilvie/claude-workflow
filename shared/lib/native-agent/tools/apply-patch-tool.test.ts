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

describe('native-agent apply_patch tool', () => {
  it('applies a valid patch and reports changed-file summaries', async () => {
    const repo = createRepo('apply-patch-success-');
    writeFixture(repo, 'src/app.ts', 'export const value = 1;\n');

    const tool = createApplyPatchTool(repo);
    const result = await tool.execute('call-1', {
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

    const details = result.details as ApplyPatchDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.deepEqual(details.changedFiles, ['src/app.ts']);
      assert.equal(details.linesAdded, 1);
      assert.equal(details.linesRemoved, 1);
      assert.match(result.content[0]!.text, /src\/app\.ts \(\+1 -1\)/);
      assert.equal(readFileSync(path.join(repo, 'src/app.ts'), 'utf-8'), 'export const value = 2;\n');
    }
  });

  it('returns validation diagnostics for an invalid patch payload', async () => {
    const repo = createRepo('apply-patch-invalid-');
    const tool = createApplyPatchTool(repo);

    const result = await tool.execute('call-2', {
      patch: {
        version: 1,
        atomic: true,
        operations: [],
      } as any,
    });

    const details = result.details as ApplyPatchDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'invalid_patch');
      assert.equal(details.retryHint, 'Fix the patch schema errors and retry with a valid NativePatch payload.');
      assert.ok(Array.isArray(details.diagnostics));
      assert.match(result.content[0]!.text, /NativePatch contract/);
    }

    const afterCall = await applyPatchAfterToolCall({
      toolCall: { name: 'apply_patch' },
      result,
    });
    assert.deepEqual(afterCall, { isError: true });
  });

  it('surfaces patch rejection diagnostics and retry hints', async () => {
    const repo = createRepo('apply-patch-reject-');
    writeFixture(repo, 'src/app.ts', 'export const value = 1;\n');

    const tool = createApplyPatchTool(repo);
    const result = await tool.execute('call-3', {
      patch: {
        version: 1,
        atomic: true,
        operations: [
          {
            op: 'edit',
            path: 'src/app.ts',
            oldText: 'missing line\n',
            newText: 'replacement\n',
            anchorBefore: 'export const value = 1;',
          },
        ],
      },
    });

    const details = result.details as ApplyPatchDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'patch_rejected');
      assert.equal(details.retryHint, 'Refresh the patch against the latest file contents.');
      assert.ok(details.diagnostics && !Array.isArray(details.diagnostics));
      assert.equal(details.diagnostics?.code, 'old_text_not_found');
      assert.equal(details.diagnostics?.liveContext?.path, 'src/app.ts');
      assert.match(result.content[0]!.text, /old_text_not_found/);
    }
  });

  it('surfaces phase_denied when execution is forced outside coding', async () => {
    const repo = createRepo('apply-patch-phase-');
    writeFixture(repo, 'src/app.ts', 'export const value = 1;\n');

    const tool = createApplyPatchTool(repo, { phase: 'review' });
    const result = await tool.execute('call-4', {
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

    const details = result.details as ApplyPatchDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'patch_rejected');
      assert.equal(details.diagnostics?.code, 'phase_denied');
      assert.match(details.message, /coding phase/i);
    }
    assert.equal(readFileSync(path.join(repo, 'src/app.ts'), 'utf-8'), 'export const value = 1;\n');
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
