import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { locateOperations, matchEditOperation } from './patch-matcher.ts';
import { NATIVE_PATCH_VERSION } from './patch-contract.ts';
import type { NativePatch, NativePatchEditOperation } from './patch-contract.ts';

function editOp(overrides: Partial<NativePatchEditOperation> & { oldText: string; newText: string }): NativePatchEditOperation {
  return {
    op: 'edit',
    path: 'src/test.ts',
    oldText: overrides.oldText,
    newText: overrides.newText,
    ...overrides,
  };
}

describe('patch-matcher', () => {
  describe('matchEditOperation', () => {
    it('exact match — unique oldText returns exact strategy and correct offsets', () => {
      const content = 'line one\nline two\nline three\n';
      const op = editOp({ oldText: 'line two', newText: 'line 2' });
      const result = matchEditOperation(op, content);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.match.strategy, 'exact');
      assert.equal(result.match.startLine, 2);
      assert.equal(result.match.endLine, 2);
      assert.equal(content.slice(result.match.startOffset, result.match.endOffset), 'line two');
    });

    it('exact match — single-line content at start of file', () => {
      const content = 'hello world\nsecond line\n';
      const op = editOp({ oldText: 'hello world', newText: 'hi world' });
      const result = matchEditOperation(op, content);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.match.strategy, 'exact');
      assert.equal(result.match.startLine, 1);
      assert.equal(content.slice(result.match.startOffset, result.match.endOffset), 'hello world');
    });

    it('anchored match — anchorBefore selects the correct occurrence', () => {
      const content = 'section A\nfoo\nend A\nsection B\nfoo\nend B\n';
      const op = editOp({
        oldText: 'foo',
        newText: 'bar',
        anchorBefore: 'section B\n',
      });
      const result = matchEditOperation(op, content);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.match.strategy, 'anchored');
      // Should match the second 'foo' (line 5)
      assert.equal(result.match.startLine, 5);
    });

    it('anchored match — anchorAfter selects the correct occurrence', () => {
      const content = 'foo\nend A\nfoo\nend B\n';
      const op = editOp({
        oldText: 'foo',
        newText: 'bar',
        anchorAfter: '\nend B',
      });
      const result = matchEditOperation(op, content);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.match.strategy, 'anchored');
      assert.equal(result.match.startLine, 3);
    });

    it('anchor_mismatch — oldText found but anchors do not match any occurrence', () => {
      const content = 'section A\nfoo\nend A\n';
      const op = editOp({
        oldText: 'foo',
        newText: 'bar',
        anchorBefore: 'section Z\n',
      });
      const result = matchEditOperation(op, content);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.code, 'anchor_mismatch');
      assert.ok(result.rejection.requestedContext.anchorBefore === 'section Z\n');
      assert.ok(result.rejection.hint.includes('oldText was found'));
    });

    it('ambiguous_anchor — two occurrences survive anchor filter', () => {
      // Both occurrences have the same anchorBefore
      const content = 'PREFIX\nfoo\nPREFIX\nfoo\n';
      const op = editOp({
        oldText: 'foo',
        newText: 'bar',
        anchorBefore: 'PREFIX\n',
      });
      const result = matchEditOperation(op, content);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.code, 'ambiguous_anchor');
      assert.ok(result.rejection.message.includes('2'));
    });

    it('ambiguous_anchor — expectedOccurrences mismatch', () => {
      const content = 'foo\nfoo\nfoo\n';
      const op = editOp({ oldText: 'foo', newText: 'bar', expectedOccurrences: 2 });
      const result = matchEditOperation(op, content);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.code, 'ambiguous_anchor');
      assert.ok(result.rejection.message.includes('3'));
      assert.ok(result.rejection.message.includes('2'));
    });

    it('old_text_not_found — no occurrences and no fuzzy config', () => {
      const content = 'alpha\nbeta\ngamma\n';
      const op = editOp({ oldText: 'delta', newText: 'epsilon' });
      const result = matchEditOperation(op, content);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.code, 'old_text_not_found');
      assert.ok(result.rejection.hint.includes('Re-read'));
    });

    it('fuzzy match — minor whitespace difference within threshold', () => {
      const content = 'function hello() {\n  return  42;\n}\n';
      const op = editOp({ oldText: 'function hello() {\n  return 42;\n}', newText: 'function hello() {\n  return 43;\n}' });
      const result = matchEditOperation(op, content, {
        minSimilarity: 0.7,
        ignoreWhitespace: true,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.match.strategy, 'fuzzy');
      assert.ok(typeof result.match.similarity === 'number');
      assert.ok(result.match.similarity >= 0.7);
    });

    it('fuzzy match — clearly best candidate returned', () => {
      const content = [
        'const CONFIG = { timeout: 30000, retries: 3, debug: false };',
        '',
        'function beta() {',
        '  return 99;',
        '}',
      ].join('\n') + '\n';

      const op = editOp({
        oldText: 'function beta() {\n  return 100;\n}',
        newText: 'function beta() {\n  return 200;\n}',
      });
      const result = matchEditOperation(op, content, { minSimilarity: 0.6 });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.match.strategy, 'fuzzy');
      assert.ok(result.match.startLine >= 3, `Expected startLine >= 3, got ${result.match.startLine}`);
    });

    it('fuzzy ambiguous — two near-equal candidates triggers ambiguous_anchor', () => {
      const content = [
        'function foo() {',
        '  return 1;',
        '}',
        'function foo() {',
        '  return 2;',
        '}',
      ].join('\n') + '\n';

      const op = editOp({
        oldText: 'function foo() {\n  return 0;\n}',
        newText: 'function foo() {\n  return 3;\n}',
      });
      const result = matchEditOperation(op, content, { minSimilarity: 0.5 });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.code, 'ambiguous_anchor');
    });

    it('old_text_not_found below fuzzy threshold', () => {
      const content = 'completely\ndifferent\ncontent\n';
      const op = editOp({ oldText: 'function hello() {\n  return 42;\n}', newText: 'updated' });
      const result = matchEditOperation(op, content, { minSimilarity: 0.9 });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.code, 'old_text_not_found');
    });

    describe('diagnostics', () => {
      it('liveContext excerpt is bounded by maxContextLines', () => {
        const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
        const op = editOp({ oldText: 'nonexistent text', newText: 'replacement' });
        const result = matchEditOperation(op, content, {
          minSimilarity: 0.99, // nothing will pass
          maxContextLines: 3,
        });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.rejection.code, 'old_text_not_found');

        const liveCtx = result.rejection.liveContext;
        assert.ok(liveCtx !== undefined, 'liveContext should be provided');
        const excerptLines = liveCtx!.excerpt.split('\n').filter((l) => l !== '…');
        assert.ok(excerptLines.length <= 3, `Excerpt should have at most 3 lines, got ${excerptLines.length}`);
      });

      it('requestedContext carries normalized oldText and anchors', () => {
        const content = 'foo\nfoo\n';
        const op = editOp({
          oldText: 'foo',
          newText: 'bar',
          anchorBefore: 'PREFIX\n',
        });
        const result = matchEditOperation(op, content);

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.ok(result.rejection.requestedContext.oldText !== undefined);
        assert.equal(result.rejection.requestedContext.anchorBefore, 'PREFIX\n');
      });

      it('no full-file dump in liveContext for small file', () => {
        const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
        const op = editOp({ oldText: 'line 999', newText: 'x' });
        const result = matchEditOperation(op, content, { minSimilarity: 0.99, maxContextLines: 4 });

        assert.equal(result.ok, false);
        if (result.ok) return;
        const liveCtx = result.rejection.liveContext;
        if (liveCtx) {
          const lines = liveCtx.excerpt.split('\n');
          assert.ok(lines.length <= 6, `Excerpt too long: ${lines.length} lines`);
        }
      });
    });
  });

  describe('locateOperations', () => {
    it('all operations match — returns ordered matches', async () => {
      const files: Record<string, string> = {
        'src/a.ts': 'const x = 1;\nconst y = 2;\n',
        'src/b.ts': 'export function foo() {}\n',
      };
      const patch: NativePatch = {
        version: NATIVE_PATCH_VERSION,
        atomic: true,
        operations: [
          { op: 'edit', path: 'src/a.ts', oldText: 'const x = 1;', newText: 'const x = 10;' },
          { op: 'edit', path: 'src/b.ts', oldText: 'export function foo() {}', newText: 'export function foo() { return 1; }' },
        ],
      };

      const result = await locateOperations(patch, (p) => files[p] ?? null);

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.matches.length, 2);
      assert.equal(result.matches[0]?.strategy, 'exact');
      assert.equal(result.matches[1]?.strategy, 'exact');
    });

    it('first operation fails — returns rejection with correct operationIndex', async () => {
      const files: Record<string, string> = {
        'src/a.ts': 'const x = 1;\n',
        'src/b.ts': 'export function foo() {}\n',
      };
      const patch: NativePatch = {
        version: NATIVE_PATCH_VERSION,
        atomic: true,
        operations: [
          { op: 'edit', path: 'src/a.ts', oldText: 'const z = 999;', newText: 'const z = 0;' },
          { op: 'edit', path: 'src/b.ts', oldText: 'export function foo() {}', newText: 'updated' },
        ],
      };

      const result = await locateOperations(patch, (p) => files[p] ?? null);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.operationIndex, 0);
      assert.equal(result.rejection.code, 'old_text_not_found');
    });

    it('atomicity — later op failure returns that op index (earlier matched)', async () => {
      const files: Record<string, string> = {
        'src/a.ts': 'const x = 1;\n',
        'src/b.ts': 'export function foo() {}\n',
      };
      const patch: NativePatch = {
        version: NATIVE_PATCH_VERSION,
        atomic: true,
        operations: [
          { op: 'edit', path: 'src/a.ts', oldText: 'const x = 1;', newText: 'const x = 2;' },
          { op: 'edit', path: 'src/b.ts', oldText: 'nonexistent', newText: 'updated' },
        ],
      };

      const result = await locateOperations(patch, (p) => files[p] ?? null);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.operationIndex, 1);
      assert.equal(result.rejection.code, 'old_text_not_found');
    });

    it('file not found — returns old_text_not_found rejection', async () => {
      const patch: NativePatch = {
        version: NATIVE_PATCH_VERSION,
        atomic: true,
        operations: [
          { op: 'edit', path: 'src/missing.ts', oldText: 'foo', newText: 'bar' },
        ],
      };

      const result = await locateOperations(patch, () => null);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.operationIndex, 0);
      assert.equal(result.rejection.code, 'old_text_not_found');
      assert.ok(result.rejection.message.includes('src/missing.ts'));
    });

    it('edit-diff operation returns unsupported rejection', async () => {
      const patch: NativePatch = {
        version: NATIVE_PATCH_VERSION,
        atomic: true,
        operations: [
          { op: 'edit-diff', path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' },
        ],
      };

      const result = await locateOperations(patch, () => 'some content\n');

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.rejection.operationIndex, 0);
      assert.equal(result.rejection.code, 'old_text_not_found');
      assert.ok(result.rejection.message.includes('edit-diff'));
    });
  });
});
