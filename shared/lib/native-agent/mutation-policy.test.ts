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

  it('allows whole-file writes matching a recursive glob pattern', () => {
    const decision = evaluateMutationWritePolicy({
      worktreePath: '/repo/wt',
      targetPath: 'dist/bundle.js',
      writeKind: 'whole-file',
      wholeFileAllowlist: {
        generatedPaths: ['dist/**'],
      },
    });

    assert.deepEqual(decision, {
      kind: 'allow',
      resolvedPath: 'dist/bundle.js',
    });
  });

  it('allows whole-file writes matching a suffix glob pattern', () => {
    const decision = evaluateMutationWritePolicy({
      worktreePath: '/repo/wt',
      targetPath: 'src/api.generated.ts',
      writeKind: 'whole-file',
      wholeFileAllowlist: {
        generatedPaths: ['**/*.generated.ts'],
      },
    });

    assert.deepEqual(decision, {
      kind: 'allow',
      resolvedPath: 'src/api.generated.ts',
    });
  });

  it('rejects whole-file writes that do not match any glob pattern', () => {
    const decision = evaluateMutationWritePolicy({
      worktreePath: '/repo/wt',
      targetPath: 'src/handwritten.ts',
      writeKind: 'whole-file',
      wholeFileAllowlist: {
        generatedPaths: ['dist/**', '**/*.generated.ts'],
      },
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'whole_file_source_write_denied',
      message: "whole_file_source_write_denied: 'src/handwritten.ts' is not generated or Wavemill-owned",
      resolvedPath: 'src/handwritten.ts',
    });
  });

  it('does not let single-star globs cross path separators', () => {
    const decision = evaluateMutationWritePolicy({
      worktreePath: '/repo/wt',
      targetPath: 'pkg/nested/file.js',
      writeKind: 'whole-file',
      wholeFileAllowlist: {
        generatedPaths: ['pkg/*.js'],
      },
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'whole_file_source_write_denied',
      message: "whole_file_source_write_denied: 'pkg/nested/file.js' is not generated or Wavemill-owned",
      resolvedPath: 'pkg/nested/file.js',
    });
  });
});
