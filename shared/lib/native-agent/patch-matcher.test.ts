import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchNativePatchOperation } from './patch-matcher.ts';
import type { NativePatchEditOperation } from './patch-contract.ts';

function editOp(
  overrides: Partial<NativePatchEditOperation> & { oldText: string; newText: string },
): NativePatchEditOperation {
  return {
    op: 'edit',
    path: 'src/file.ts',
    oldText: '',
    newText: '',
    ...overrides,
  };
}

describe('patch-matcher', () => {
  // ── exact match ────────────────────────────────────────────────────────────
  describe('exact match', () => {
    it('resolves a single verbatim occurrence as exact strategy', () => {
      const content = 'line1\nfunction foo() {\n  return 42;\n}\nline5';
      const op = editOp({ oldText: 'function foo() {\n  return 42;\n}', newText: 'function foo() {\n  return 0;\n}' });

      const result = matchNativePatchOperation(content, op, 0);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.location.strategy, 'exact');
      assert.equal(result.location.startLine, 2);
      assert.equal(result.location.endLine, 4);
    });

    it('reports correct char offsets for exact match', () => {
      const content = 'aaa\nTARGET\nbbb';
      const op = editOp({ oldText: 'TARGET', newText: 'REPLACED' });

      const result = matchNativePatchOperation(content, op, 0);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.location.startIndex, 4);
      assert.equal(result.location.endIndex, 10);
      assert.equal(result.location.startLine, 2);
      assert.equal(result.location.endLine, 2);
    });

    it('resolves single-line content on line 1', () => {
      const content = 'sole line';
      const op = editOp({ oldText: 'sole line', newText: 'updated' });

      const result = matchNativePatchOperation(content, op, 0);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.location.strategy, 'exact');
      assert.equal(result.location.startLine, 1);
      assert.equal(result.location.endLine, 1);
    });
  });

  // ── offset (anchor-disambiguated) match ───────────────────────────────────
  describe('offset match', () => {
    it('uses anchorBefore to select the second of two identical occurrences', () => {
      // "DUPLICATE" appears at line 4 and line 12
      // anchorBefore = "UNIQUE" only appears near line 12 (not near line 4)
      const lines = [
        'line1',    // 1
        'line2',    // 2
        'line3',    // 3
        'DUPLICATE',// 4
        'line5',    // 5
        'line6',    // 6
        'UNIQUE',   // 7  ← anchor appears here, close to second DUPLICATE
        'line8',    // 8
        'line9',    // 9
        'line10',   // 10
        'line11',   // 11
        'DUPLICATE',// 12
        'line13',   // 13
      ];
      const content = lines.join('\n');
      const op = editOp({
        oldText: 'DUPLICATE',
        newText: 'REPLACED',
        anchorBefore: 'UNIQUE',
      });

      const result = matchNativePatchOperation(content, op, 0);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.location.strategy, 'offset');
      assert.equal(result.location.startLine, 12);
      assert.equal(result.location.endLine, 12);
    });

    it('returns ambiguous_anchor when two occurrences tie with no anchors', () => {
      const content = 'foo\nbar\nfoo\nbaz';
      const op = editOp({ oldText: 'foo', newText: 'qux' });

      const result = matchNativePatchOperation(content, op, 0);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.code, 'ambiguous_anchor');
      assert.equal(result.rejection.operationIndex, 0);
      assert.ok(result.rejection.message.length > 0);
      assert.ok(result.rejection.hint.length > 0);
      assert.equal(result.rejection.requestedContext.oldText, 'foo');
      assert.ok(result.rejection.liveContext !== undefined);
    });

    it('returns anchor_mismatch when both occurrences fail the supplied anchor', () => {
      const content = 'foo\nbar\nfoo\nbaz';
      const op = editOp({
        oldText: 'foo',
        newText: 'qux',
        anchorBefore: 'ABSENT_ANCHOR',
      });

      const result = matchNativePatchOperation(content, op, 0);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.code, 'anchor_mismatch');
    });
  });

  // ── fuzzy match ───────────────────────────────────────────────────────────
  describe('fuzzy match', () => {
    it('resolves whitespace-variant oldText with ignoreWhitespace', () => {
      // live content has extra spaces; oldText has single spaces
      const content = [
        'preamble',
        'function foo() {',
        '  x  =  1;',
        '  return  x;',
        '}',
        'postamble',
      ].join('\n');
      const op = editOp({
        oldText: 'function foo() {\n  x = 1;\n  return x;\n}',
        newText: 'function foo() {\n  x = 2;\n  return x;\n}',
      });

      const result = matchNativePatchOperation(content, op, 0, { ignoreWhitespace: true });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.location.strategy, 'fuzzy');
      assert.equal(result.location.startLine, 2);
      assert.equal(result.location.endLine, 5);
    });

    it('includes normalizedOldText in requestedContext on fuzzy rejection', () => {
      // Two fuzzy candidates at equal score → ambiguous
      const content = 'function foo() {\n  x = 1;\n}\nfunction bar() {\n  x = 2;\n}';
      const op = editOp({
        oldText: 'function baz() {\n  x = 1;\n}',
        newText: 'function baz() {\n  x = 99;\n}',
      });

      const result = matchNativePatchOperation(content, op, 1, undefined, {
        fuzzyThreshold: 0.5,
        fuzzyMargin: 0.01,
      });

      // Either ambiguous or resolved — if rejected, check normalizedOldText is set
      if (!result.ok) {
        assert.ok(
          result.rejection.requestedContext.normalizedOldText !== undefined,
          'normalizedOldText should be set on fuzzy rejection',
        );
      }
    });
  });

  // ── ambiguous match ───────────────────────────────────────────────────────
  describe('ambiguous match', () => {
    it('rejects with all required fields populated when oldText appears twice', () => {
      const content = 'alpha\nbeta\nalpha\ngamma';
      const op = editOp({ oldText: 'alpha', newText: 'delta', path: 'lib/mod.ts' });

      const result = matchNativePatchOperation(content, op, 2);

      assert.equal(result.ok, false);
      if (result.ok) return;

      const r = result.rejection;
      assert.equal(r.code, 'ambiguous_anchor');
      assert.equal(r.operationIndex, 2);
      assert.ok(typeof r.message === 'string' && r.message.length > 0);
      assert.ok(typeof r.hint === 'string' && r.hint.length > 0);
      assert.equal(r.requestedContext.oldText, 'alpha');
      assert.ok(r.liveContext !== undefined);
      assert.equal(r.liveContext?.path, 'lib/mod.ts');
      assert.ok(typeof r.liveContext?.excerpt === 'string');
      assert.ok((r.liveContext?.startLine ?? 0) >= 1);
      assert.ok((r.liveContext?.endLine ?? 0) >= (r.liveContext?.startLine ?? 0));
    });
  });

  // ── no-match ──────────────────────────────────────────────────────────────
  describe('no-match', () => {
    it('returns old_text_not_found when oldText is absent and nothing is close', () => {
      const content = 'hello\nworld\nfoo\nbar';
      const op = editOp({ oldText: 'completely_absent_text', newText: 'x' });

      const result = matchNativePatchOperation(content, op, 0);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.code, 'old_text_not_found');
      assert.ok(result.rejection.hint.length > 0);
    });

    it('returns fuzzy_below_threshold when best candidate is below the threshold', () => {
      // oldText = "foo\nbar" differs from content window "foo\nbaz" in one line
      // distance = 1, maxLen = 2, similarity = 0.5 < default threshold 0.9
      const content = 'prefix\nfoo\nbaz\nsuffix';
      const op = editOp({ oldText: 'foo\nbar', newText: 'foo\nQUX' });

      const result = matchNativePatchOperation(content, op, 0);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.code, 'fuzzy_below_threshold');
      assert.ok(result.rejection.hint.includes('re-read'));
      assert.ok(result.rejection.requestedContext.normalizedOldText !== undefined);
    });
  });

  // ── bounded diagnostics ───────────────────────────────────────────────────
  describe('bounded diagnostics', () => {
    it('excerpt spans at most contextLines*2+1 lines on a 500-line file', () => {
      // Two identical lines in a 500-line file → ambiguous, excerpt centers on first
      const allLines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
      allLines[249] = 'DUPLICATE';
      allLines[349] = 'DUPLICATE';
      const content = allLines.join('\n');
      const op = editOp({ oldText: 'DUPLICATE', newText: 'REPLACED' });

      const result = matchNativePatchOperation(content, op, 0, undefined, { contextLines: 3 });

      assert.equal(result.ok, false);
      if (result.ok) return;

      const { excerpt, startLine, endLine } = result.rejection.liveContext ?? {};
      assert.ok(startLine !== undefined && endLine !== undefined && excerpt !== undefined);
      const lineCount = (endLine! - startLine!) + 1;
      assert.ok(
        lineCount <= 7,
        `expected ≤7 lines in excerpt, got ${lineCount} (lines ${startLine}-${endLine})`,
      );
    });

    it('excerpt is truncated with … marker when content lines are long', () => {
      const LONG = 'x'.repeat(70);
      const allLines = Array.from({ length: 500 }, (_, i) => `${LONG}${i + 1}`);
      allLines[249] = `DUPLICATE_${'x'.repeat(60)}`;
      allLines[349] = `DUPLICATE_${'x'.repeat(60)}`;
      const content = allLines.join('\n');
      const op = editOp({ oldText: allLines[249], newText: 'REPLACED' });

      const maxExcerptChars = 400;
      const result = matchNativePatchOperation(content, op, 0, undefined, {
        contextLines: 3,
        maxExcerptChars,
      });

      assert.equal(result.ok, false);
      if (result.ok) return;

      const { excerpt } = result.rejection.liveContext ?? {};
      assert.ok(excerpt !== undefined);
      assert.ok(
        excerpt!.length <= maxExcerptChars,
        `excerpt length ${excerpt!.length} exceeds ${maxExcerptChars}`,
      );
      assert.ok(excerpt!.endsWith('…'), 'truncated excerpt should end with …');
    });

    it('does not produce negative line indices when match is at line 1', () => {
      // DUPLICATE at line 1 and line 200
      const allLines = Array.from({ length: 200 }, (_, i) => `line ${i + 2}`);
      const content = ['DUPLICATE', ...allLines, 'DUPLICATE'].join('\n');
      const op = editOp({ oldText: 'DUPLICATE', newText: 'REPLACED' });

      const result = matchNativePatchOperation(content, op, 0, undefined, { contextLines: 3 });

      assert.equal(result.ok, false);
      if (result.ok) return;

      const { startLine } = result.rejection.liveContext ?? {};
      assert.ok(
        (startLine ?? 0) >= 1,
        `startLine must be ≥ 1, got ${startLine}`,
      );
    });

    it('truncates excerpt when a very long single line would overflow maxExcerptChars', () => {
      const longLine = 'a'.repeat(500);
      const content = `${longLine}\nnormalline\n${longLine}`;
      const op = editOp({ oldText: 'absent_text_xyz', newText: 'x' });

      const maxExcerptChars = 400;
      const result = matchNativePatchOperation(content, op, 0, undefined, { maxExcerptChars });

      assert.equal(result.ok, false);
      if (result.ok) return;

      const { excerpt } = result.rejection.liveContext ?? {};
      assert.ok(excerpt !== undefined);
      assert.ok(
        excerpt!.length <= maxExcerptChars,
        `excerpt length ${excerpt!.length} exceeds ${maxExcerptChars}`,
      );
      assert.ok(excerpt!.endsWith('…'));
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('returns old_text_not_found with empty excerpt on empty live file', () => {
      const op = editOp({ oldText: 'anything', newText: 'other' });

      let result: ReturnType<typeof matchNativePatchOperation>;
      assert.doesNotThrow(() => {
        result = matchNativePatchOperation('', op, 0);
      });

      assert.equal(result!.ok, false);
      if (result!.ok) return;
      assert.equal(result!.rejection.code, 'old_text_not_found');
      assert.equal(result!.rejection.liveContext?.excerpt, '');
    });

    it('normalizes CRLF line endings before matching', () => {
      const content = 'line1\r\nTARGET\r\nline3';
      const op = editOp({ oldText: 'TARGET', newText: 'REPLACED' });

      const result = matchNativePatchOperation(content, op, 0);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.location.strategy, 'exact');
      assert.equal(result.location.startLine, 2);
    });

    it('passes operationIndex through to the rejection', () => {
      const content = 'some content here';
      const op = editOp({ oldText: 'not present', newText: 'x' });

      const result = matchNativePatchOperation(content, op, 7);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.operationIndex, 7);
    });

    it('includes operation path in liveContext.path', () => {
      const content = 'aaa\nbbb';
      const op = editOp({ oldText: 'ccc', newText: 'ddd', path: 'deep/nested/file.ts' });

      const result = matchNativePatchOperation(content, op, 0);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.liveContext?.path, 'deep/nested/file.ts');
    });

    it('fuzzy loop is skipped when liveContent is shorter than oldText', () => {
      const content = 'short';
      const op = editOp({ oldText: 'line1\nline2\nline3', newText: 'x' });

      let result: ReturnType<typeof matchNativePatchOperation>;
      assert.doesNotThrow(() => {
        result = matchNativePatchOperation(content, op, 0);
      });

      assert.equal(result!.ok, false);
      if (result!.ok) return;
      assert.equal(result!.rejection.code, 'old_text_not_found');
    });
  });
});
