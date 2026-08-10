import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildNativePatchGuidance,
  NATIVE_PATCH_EXAMPLE,
  NATIVE_PATCH_VERSION,
  normalizePatchPath,
  validateNativePatch,
} from './patch-contract.ts';

describe('patch-contract', () => {
  it('keeps the documented NativePatch example valid and parseable', () => {
    const exampleResult = validateNativePatch(NATIVE_PATCH_EXAMPLE);
    assert.equal(exampleResult.ok, true);

    const guidance = buildNativePatchGuidance();
    assert.match(guidance, /version/);
    assert.match(guidance, /atomic/);
    assert.match(guidance, /operations/);
    assert.match(guidance, /edit-diff/);
    assert.match(guidance, /\bedit\b/);

    const jsonMatch = guidance.match(/```json\n([\s\S]+?)\n```/);
    assert.ok(jsonMatch);
    const parsed = JSON.parse(jsonMatch[1]!);
    const parsedResult = validateNativePatch(parsed);
    assert.equal(parsedResult.ok, true);
  });

  describe('normalizePatchPath', () => {
    it('normalizes repo-relative POSIX paths', () => {
      assert.equal(normalizePatchPath('./src//native-agent/../native-agent/patch.ts'), null);
      assert.equal(normalizePatchPath('./src//native-agent/patch.ts'), 'src/native-agent/patch.ts');
    });

    it('rejects absolute, traversal, and windows-style paths', () => {
      assert.equal(normalizePatchPath('/tmp/file.ts'), null);
      assert.equal(normalizePatchPath('../file.ts'), null);
      assert.equal(normalizePatchPath('src\\file.ts'), null);
    });
  });

  it('accepts a valid edit envelope', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      fuzzyMatch: {
        minSimilarity: 0.8,
        maxMatchCandidates: 2,
        maxContextLines: 4,
        ignoreWhitespace: true,
      },
      operations: [
        {
          op: 'edit',
          path: './shared/lib/stage-result.ts',
          oldText: 'before',
          newText: 'after',
          anchorBefore: 'leading context',
        },
      ],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      version: 1,
      atomic: true,
      fuzzyMatch: {
        minSimilarity: 0.8,
        maxMatchCandidates: 2,
        maxContextLines: 4,
        ignoreWhitespace: true,
      },
      operations: [
        {
          op: 'edit',
          path: 'shared/lib/stage-result.ts',
          oldText: 'before',
          newText: 'after',
          anchorBefore: 'leading context',
        },
      ],
    });
  });

  it('accepts a valid edit-diff envelope', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        {
          op: 'edit-diff',
          path: 'shared/lib/native-agent/patch-contract.ts',
          diff: '@@ -1 +1 @@\n-before\n+after',
          anchorAfter: 'trailing context',
        },
      ],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.operations[0]?.op, 'edit-diff');
  });

  it('rejects invalid versions', () => {
    const result = validateNativePatch({
      version: 2,
      atomic: true,
      operations: [{ op: 'edit', path: 'file.ts', oldText: 'a', newText: 'b' }],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.errors, [
      {
        code: 'invalid_version',
        path: '$.version',
        message: 'NativePatch version must be 1.',
      },
    ]);
  });

  it('rejects non-atomic envelopes', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: false,
      operations: [{ op: 'edit', path: 'file.ts', oldText: 'a', newText: 'b' }],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]?.code, 'non_atomic_patch');
  });

  it('rejects empty operations', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]?.code, 'empty_operations');
  });

  it('rejects invalid path normalization inputs', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        { op: 'edit', path: '../file.ts', oldText: 'a', newText: 'b' },
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.errors, [
      {
        code: 'invalid_path',
        path: '$.operations[0].path',
        message: 'NativePatch operation path must be a repo-relative POSIX path without traversal.',
        operationIndex: 0,
      },
    ]);
  });

  it('rejects invalid context and fuzzy settings', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      fuzzyMatch: {
        minSimilarity: 1.1,
        maxMatchCandidates: 0,
        ignoreWhitespace: 'yes',
      },
      operations: [
        {
          op: 'edit',
          path: 'file.ts',
          oldText: 'a',
          newText: 'b',
          anchorBefore: '',
        },
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.errors.map((error) => error.path),
      [
        '$.fuzzyMatch.minSimilarity',
        '$.fuzzyMatch.maxMatchCandidates',
        '$.fuzzyMatch.ignoreWhitespace',
        '$.operations[0].anchorBefore',
      ],
    );
  });

  it('rejects edit operations whose oldText equals newText', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        { op: 'edit', path: 'src/a.ts', oldText: 'x', newText: 'x' },
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.errors.map((error) => ({ code: error.code, operationIndex: error.operationIndex })),
      [{ code: 'identical_old_new', operationIndex: 0 }],
    );
  });

  it('accepts and validates expectedOccurrences', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        {
          op: 'edit',
          path: 'src/a.ts',
          oldText: 'foo',
          newText: 'bar',
          expectedOccurrences: 3,
        },
      ],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.operations[0]?.expectedOccurrences, 3);
  });

  it('rejects negative or non-integer expectedOccurrences', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        {
          op: 'edit',
          path: 'src/a.ts',
          oldText: 'foo',
          newText: 'bar',
          expectedOccurrences: 0,
        },
        {
          op: 'edit',
          path: 'src/b.ts',
          oldText: 'foo',
          newText: 'bar',
          expectedOccurrences: 1.5,
        },
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.errors.map((error) => ({ code: error.code, operationIndex: error.operationIndex })),
      [
        { code: 'invalid_expected_occurrences', operationIndex: 0 },
        { code: 'invalid_expected_occurrences', operationIndex: 1 },
      ],
    );
  });

  it('returns deterministic error ordering', () => {
    const result = validateNativePatch({
      version: 3,
      atomic: false,
      fuzzyMatch: {
        requireAnchorOverlap: 'strict',
      },
      operations: [
        {
          op: 'edit',
          path: '/tmp/file.ts',
          oldText: '',
          newText: 42,
          anchorAfter: '',
        },
        {
          op: 'rename',
          path: '../other.ts',
        },
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.errors.map((error) => [error.code, error.path]),
      [
        ['invalid_version', '$.version'],
        ['non_atomic_patch', '$.atomic'],
        ['invalid_fuzzy_match', '$.fuzzyMatch.requireAnchorOverlap'],
        ['invalid_path', '$.operations[0].path'],
        ['invalid_context', '$.operations[0].anchorAfter'],
        ['invalid_text', '$.operations[0].oldText'],
        ['invalid_text', '$.operations[0].newText'],
        ['invalid_path', '$.operations[1].path'],
        ['unsupported_operation', '$.operations[1].op'],
      ],
    );
  });
});
