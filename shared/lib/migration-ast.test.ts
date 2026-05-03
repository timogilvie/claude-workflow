import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyDowngradeBody,
  extractOperationCalls,
  getMigrationFunction,
  parseMigrationFile,
  type ParsedStatement,
} from './migration-ast.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'migrations');

function fixture(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

describe('migration-ast', () => {
  describe('parseMigrationFile', () => {
    it('parses a healthy migration with upgrade and downgrade', () => {
      const parsed = parseMigrationFile(fixture('non_trivial_downgrade.py'));
      assert.equal(parsed.parseError, null);
      const fnNames = parsed.functions.map(fn => fn.name).sort();
      assert.deepEqual(fnNames, ['downgrade', 'upgrade']);
    });

    it('returns a structured parse error when python rejects the file', () => {
      const parsed = parseMigrationFile(fixture('malformed_syntax.py'));
      assert.ok(parsed.parseError, 'expected a parse error for malformed input');
      assert.equal(parsed.parseError.kind, 'syntax-error');
      assert.equal(parsed.functions.length, 0);
    });

    it('returns a file-not-found parse error rather than throwing', () => {
      const parsed = parseMigrationFile('/definitely/does/not/exist/migration.py');
      assert.ok(parsed.parseError);
      assert.equal(parsed.parseError.kind, 'file-not-found');
    });
  });

  describe('classifyDowngradeBody', () => {
    it('returns missing for an undefined body', () => {
      assert.equal(classifyDowngradeBody(undefined), 'missing');
    });

    it('returns empty-pass for pass-only', () => {
      const body: ParsedStatement[] = [{ type: 'Pass' }];
      assert.equal(classifyDowngradeBody(body), 'empty-pass');
    });

    it('returns empty-docstring for docstring-only', () => {
      const body: ParsedStatement[] = [{ type: 'Docstring' }];
      assert.equal(classifyDowngradeBody(body), 'empty-docstring');
    });

    it('returns empty-pass for docstring + pass', () => {
      const body: ParsedStatement[] = [{ type: 'Docstring' }, { type: 'Pass' }];
      assert.equal(classifyDowngradeBody(body), 'empty-pass');
    });

    it('returns not-implemented for bare raise', () => {
      const body: ParsedStatement[] = [
        { type: 'Raise', exceptionName: 'NotImplementedError', isCall: false },
      ];
      assert.equal(classifyDowngradeBody(body), 'not-implemented');
    });

    it('returns not-implemented for raise with parens', () => {
      const body: ParsedStatement[] = [
        { type: 'Raise', exceptionName: 'NotImplementedError', isCall: true },
      ];
      assert.equal(classifyDowngradeBody(body), 'not-implemented');
    });

    it('returns not-implemented for docstring + raise', () => {
      const body: ParsedStatement[] = [
        { type: 'Docstring' },
        { type: 'Raise', exceptionName: 'NotImplementedError', isCall: true },
      ];
      assert.equal(classifyDowngradeBody(body), 'not-implemented');
    });

    it('treats other raise types as non-trivial', () => {
      const body: ParsedStatement[] = [
        { type: 'Raise', exceptionName: 'ValueError', isCall: true },
      ];
      assert.equal(classifyDowngradeBody(body), 'non-trivial');
    });

    it('returns non-trivial for an executable body', () => {
      const body: ParsedStatement[] = [
        {
          type: 'ExprCall',
          call: { type: 'AttributeCall', objectName: 'op', attrName: 'drop_column' },
        },
      ];
      assert.equal(classifyDowngradeBody(body), 'non-trivial');
    });
  });

  describe('classifyDowngradeBody via fixtures', () => {
    const cases: Array<{ fixture: string; expected: string }> = [
      { fixture: 'empty_pass_downgrade.py', expected: 'empty-pass' },
      { fixture: 'docstring_only_downgrade.py', expected: 'empty-docstring' },
      { fixture: 'docstring_pass_downgrade.py', expected: 'empty-pass' },
      { fixture: 'not_implemented_bare_downgrade.py', expected: 'not-implemented' },
      { fixture: 'not_implemented_called_downgrade.py', expected: 'not-implemented' },
      { fixture: 'non_trivial_downgrade.py', expected: 'non-trivial' },
      { fixture: 'destructive_upgrade.py', expected: 'non-trivial' },
    ];

    for (const c of cases) {
      it(`classifies ${c.fixture} as ${c.expected}`, () => {
        const parsed = parseMigrationFile(fixture(c.fixture));
        assert.equal(parsed.parseError, null, `unexpected parse error for ${c.fixture}`);
        const downgrade = getMigrationFunction(parsed, 'downgrade');
        const classification = downgrade ? classifyDowngradeBody(downgrade.body) : 'missing';
        assert.equal(classification, c.expected);
      });
    }

    it('classifies missing_downgrade.py as missing', () => {
      const parsed = parseMigrationFile(fixture('missing_downgrade.py'));
      assert.equal(parsed.parseError, null);
      const downgrade = getMigrationFunction(parsed, 'downgrade');
      assert.equal(downgrade, undefined);
      assert.equal(classifyDowngradeBody(downgrade?.body), 'missing');
    });
  });

  describe('extractOperationCalls', () => {
    it('returns the destructive op calls present in upgrade()', () => {
      const parsed = parseMigrationFile(fixture('destructive_upgrade.py'));
      const upgrade = getMigrationFunction(parsed, 'upgrade');
      const calls = extractOperationCalls(upgrade);
      assert.deepEqual(
        new Set(calls),
        new Set(['op.drop_column', 'op.drop_table'])
      );
    });

    it('returns empty array for an undefined function', () => {
      assert.deepEqual(extractOperationCalls(undefined), []);
    });

    it('filters by object name', () => {
      const parsed = parseMigrationFile(fixture('non_trivial_downgrade.py'));
      const upgrade = getMigrationFunction(parsed, 'upgrade');
      const opCalls = extractOperationCalls(upgrade, 'op');
      const otherCalls = extractOperationCalls(upgrade, 'sa');
      assert.ok(opCalls.length > 0);
      assert.deepEqual(otherCalls, []);
    });
  });
});
