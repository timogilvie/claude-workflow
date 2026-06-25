import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONTRACT_VERSION,
  MAX_FUZZY_EDIT_DISTANCE,
  type NativePatch,
  type WholeFileWriteAllowlistInput,
} from './patch-contract.ts';
import { normalizePath, validateNativePatch } from './patch-validator.ts';

describe('native patch validator', () => {
  it('accepts a valid edit envelope', () => {
    const patch: NativePatch = {
      version: CONTRACT_VERSION,
      operations: [
        {
          path: 'shared/lib/native-agent/messages.ts',
          mode: 'edit',
          oldString: 'before',
          newString: 'after',
          expectedOccurrences: 1,
          occurrenceIndex: 0,
          context: { before: ['alpha'], after: ['beta'] },
          fuzzy: { whitespace: true, maxEditDistance: 2 },
        },
      ],
    };

    assert.deepEqual(validateNativePatch(patch), { ok: true });
  });

  it('accepts a valid multi-operation edit-diff envelope', () => {
    const patch: NativePatch = {
      version: CONTRACT_VERSION,
      operations: [
        { path: './docs/plan.md', mode: 'edit-diff', diff: '@@ -1 +1 @@\n-a\n+b\n' },
        { path: 'shared\\lib\\native-agent\\review.ts', mode: 'edit-diff', diff: '@@ -2 +2 @@\n-c\n+d\n' },
      ],
    };

    assert.deepEqual(validateNativePatch(patch), { ok: true });
    assert.equal(normalizePath('shared\\lib\\native-agent\\review.ts'), 'shared/lib/native-agent/review.ts');
  });

  it('rejects empty operations', () => {
    const result = validateNativePatch({ version: CONTRACT_VERSION, operations: [] });
    assert.deepEqual(result, {
      ok: false,
      rejection: {
        errors: [
          {
            operationIndex: null,
            code: 'PATCH_EMPTY_OPERATIONS',
            message: 'patch.operations must contain at least one operation',
          },
        ],
      },
    });
  });

  it('rejects an unknown version', () => {
    const result = validateNativePatch({
      version: '2',
      operations: [{ path: 'file.ts', mode: 'edit', oldString: 'a', newString: 'b' }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.rejection.errors[0]?.code, 'PATCH_UNKNOWN_VERSION');
  });

  it('validates path edge cases deterministically', () => {
    const result = validateNativePatch({
      version: CONTRACT_VERSION,
      operations: [
        { path: '', mode: 'edit', oldString: 'a', newString: 'b' },
        { path: '/tmp/file.ts', mode: 'edit', oldString: 'a', newString: 'b' },
        { path: '../secrets.txt', mode: 'edit', oldString: 'a', newString: 'b' },
        { path: './src/file.ts', mode: 'edit', oldString: 'a', newString: 'b' },
      ],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.rejection.errors.map((error) => [error.operationIndex, error.code]),
      [
        [0, 'PATCH_PATH_EMPTY'],
        [1, 'PATCH_PATH_ABSOLUTE'],
        [2, 'PATCH_PATH_TRAVERSAL'],
      ],
    );
    assert.equal(normalizePath('./src/file.ts'), 'src/file.ts');
  });

  it('rejects drive-qualified Windows absolute paths after normalization', () => {
    const result = validateNativePatch({
      version: CONTRACT_VERSION,
      operations: [{ path: 'C:\\temp\\file.ts', mode: 'edit', oldString: 'a', newString: 'b' }],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.rejection.errors.map((error) => error.code), ['PATCH_PATH_ABSOLUTE']);
  });

  it('rejects edit mode without a non-empty oldString', () => {
    const result = validateNativePatch({
      version: CONTRACT_VERSION,
      operations: [{ path: 'file.ts', mode: 'edit', oldString: '', newString: 'b' }],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.rejection.errors.map((error) => error.code), ['PATCH_OLD_STRING_MISSING']);
  });

  it('rejects edit-diff mode without diff', () => {
    const result = validateNativePatch({
      version: CONTRACT_VERSION,
      operations: [{ path: 'file.ts', mode: 'edit-diff' }],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.rejection.errors.map((error) => error.code), ['PATCH_DIFF_MISSING']);
  });

  it('rejects fuzzy maxEditDistance outside the supported range', () => {
    const negative = validateNativePatch({
      version: CONTRACT_VERSION,
      operations: [{ path: 'file.ts', mode: 'edit', oldString: 'a', newString: 'b', fuzzy: { maxEditDistance: -1 } }],
    });
    const tooLarge = validateNativePatch({
      version: CONTRACT_VERSION,
      operations: [
        {
          path: 'file.ts',
          mode: 'edit',
          oldString: 'a',
          newString: 'b',
          fuzzy: { maxEditDistance: MAX_FUZZY_EDIT_DISTANCE + 1 },
        },
      ],
    });

    assert.deepEqual(negative.ok && tooLarge.ok, false);
    assert.deepEqual(negative.rejection.errors.map((error) => error.code), ['PATCH_FUZZY_OUT_OF_RANGE']);
    assert.deepEqual(tooLarge.rejection.errors.map((error) => error.code), ['PATCH_FUZZY_OUT_OF_RANGE']);
  });

  it('rejects non-boolean fuzzy whitespace', () => {
    const result = validateNativePatch({
      version: CONTRACT_VERSION,
      operations: [
        {
          path: 'file.ts',
          mode: 'edit',
          oldString: 'a',
          newString: 'b',
          fuzzy: { whitespace: 'yes' as unknown as boolean },
        },
      ],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.rejection.errors.map((error) => error.code), ['PATCH_FUZZY_INVALID']);
  });

  it('rejects the full envelope when any operation is invalid', () => {
    const result = validateNativePatch({
      version: CONTRACT_VERSION,
      operations: [
        { path: 'valid.ts', mode: 'edit', oldString: 'a', newString: 'b' },
        { path: '/abs/path.ts', mode: 'edit', oldString: 'a', newString: 'b' },
        { path: 'empty-old.ts', mode: 'edit', oldString: '', newString: 'b' },
      ],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.rejection.errors.map((error) => [error.operationIndex, error.code]),
      [
        [1, 'PATCH_PATH_ABSOLUTE'],
        [2, 'PATCH_OLD_STRING_MISSING'],
      ],
    );
  });

  it('returns byte-identical validation results for the same malformed input', () => {
    const patch = {
      version: '9',
      operations: [{ path: '', mode: 'unknown', fuzzy: { whitespace: 'nope' } }],
    };

    assert.equal(
      JSON.stringify(validateNativePatch(patch)),
      JSON.stringify(validateNativePatch(patch)),
    );
  });

  it('does not mutate the input object', () => {
    const patch = {
      version: CONTRACT_VERSION,
      operations: [{ path: 'src\\file.ts', mode: 'edit', oldString: 'a', newString: 'b' }],
    };
    const before = JSON.parse(JSON.stringify(patch));

    validateNativePatch(patch);

    assert.deepEqual(patch, before);
  });

  it('allows WholeFileWriteAllowlistInput assignments at compile time', () => {
    const allowlist: WholeFileWriteAllowlistInput = {
      generatedPathGlobs: ['dist/**', 'docs/generated/**'],
      wavemillOwnedPathMarkers: ['@generated', 'WAVEMILL_OWNED'],
    };

    assert.deepEqual(allowlist.generatedPathGlobs, ['dist/**', 'docs/generated/**']);
  });
});
