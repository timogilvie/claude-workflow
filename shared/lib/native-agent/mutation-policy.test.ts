import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateMutationWritePolicy } from './mutation-policy.ts';

describe('mutation-policy', () => {
  it('denies writes outside the active worktree', () => {
    const decision = evaluateMutationWritePolicy({
      worktreePath: '/repo/wt',
      targetPath: '../other/file.ts',
      writeKind: 'patch',
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'path_denied',
      message: "path_denied: '../other/file.ts' resolves outside the active worktree",
      resolvedPath: '../other/file.ts',
    });
  });

  it('denies sibling-prefix false positives', () => {
    const decision = evaluateMutationWritePolicy({
      worktreePath: '/repo/wt',
      targetPath: '/repo/wtx/src/file.ts',
      writeKind: 'patch',
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'path_denied',
      message: "path_denied: '/repo/wtx/src/file.ts' resolves outside the active worktree",
      resolvedPath: '/repo/wtx/src/file.ts',
    });
  });

  it('allows patch writes inside the active worktree', () => {
    const decision = evaluateMutationWritePolicy({
      worktreePath: '/repo/wt',
      targetPath: './src/file.ts',
      writeKind: 'patch',
    });

    assert.deepEqual(decision, {
      kind: 'allow',
      resolvedPath: 'src/file.ts',
    });
  });

  it('allows whole-file writes to generated paths', () => {
    const decision = evaluateMutationWritePolicy({
      worktreePath: '/repo/wt',
      targetPath: 'dist/output.json',
      writeKind: 'whole-file',
      wholeFileAllowlist: {
        generatedPaths: ['./dist/output.json'],
      },
    });

    assert.deepEqual(decision, {
      kind: 'allow',
      resolvedPath: 'dist/output.json',
    });
  });

  it('allows whole-file writes to Wavemill-owned paths', () => {
    const decision = evaluateMutationWritePolicy({
      worktreePath: '/repo/wt',
      targetPath: 'features/task/.coding-complete',
      writeKind: 'whole-file',
      wholeFileAllowlist: {
        wavemillOwnedPaths: ['features/task/.coding-complete'],
      },
    });

    assert.deepEqual(decision, {
      kind: 'allow',
      resolvedPath: 'features/task/.coding-complete',
    });
  });

  it('rejects whole-file source writes by default', () => {
    const decision = evaluateMutationWritePolicy({
      worktreePath: '/repo/wt',
      targetPath: 'src/app.ts',
      writeKind: 'whole-file',
      wholeFileAllowlist: {
        generatedPaths: ['dist/output.json'],
      },
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'whole_file_source_write_denied',
      message: "whole_file_source_write_denied: 'src/app.ts' is not generated or Wavemill-owned",
      resolvedPath: 'src/app.ts',
    });
  });
});
