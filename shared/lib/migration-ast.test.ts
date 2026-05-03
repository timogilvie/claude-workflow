import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseMigrationFile } from './migration-ast.ts';

const fixturesDir = path.resolve(process.cwd(), 'tests/fixtures/migrations');

function fixturePath(name: string): string {
  return path.join(fixturesDir, name);
}

describe('parseMigrationFile', () => {
  it('parses module-level alembic functions', async () => {
    const parsed = await parseMigrationFile(fixturePath('downgrade_real.py'));

    assert.ok(parsed);
    assert.equal(parsed.upgrade.name, 'upgrade');
    assert.equal(parsed.downgrade.name, 'downgrade');
    assert.deepEqual(parsed.upgrade.opCalls.map(opCall => opCall.functionName), ['add_column']);
    assert.deepEqual(parsed.downgrade.opCalls.map(opCall => opCall.functionName), ['drop_column']);
  });

  it('parses class-style upgrade and downgrade methods', async () => {
    const parsed = await parseMigrationFile(fixturePath('class_style_downgrade_pass.py'));

    assert.ok(parsed);
    assert.deepEqual(parsed.downgrade.statements, ['pass']);
  });

  it('normalizes pass-only downgrade bodies', async () => {
    const parsed = await parseMigrationFile(fixturePath('downgrade_pass.py'));

    assert.ok(parsed);
    assert.deepEqual(parsed.downgrade.statements, ['pass']);
  });

  it('normalizes docstring-only downgrade bodies', async () => {
    const parsed = await parseMigrationFile(fixturePath('downgrade_docstring_only.py'));

    assert.ok(parsed);
    assert.deepEqual(parsed.downgrade.statements, ['docstring']);
  });

  it('normalizes raise NotImplementedError variants', async () => {
    const nameForm = await parseMigrationFile(fixturePath('downgrade_not_implemented_name.py'));
    const callForm = await parseMigrationFile(fixturePath('downgrade_not_implemented_call.py'));

    assert.ok(nameForm);
    assert.ok(callForm);
    assert.deepEqual(nameForm.downgrade.statements, ['raise-not-implemented']);
    assert.deepEqual(callForm.downgrade.statements, ['raise-not-implemented']);
  });

  it('captures destructive and restorative op calls', async () => {
    const dropColumn = await parseMigrationFile(fixturePath('upgrade_drops_column.py'));
    const dropTable = await parseMigrationFile(fixturePath('upgrade_drops_table.py'));

    assert.ok(dropColumn);
    assert.ok(dropTable);
    assert.deepEqual(dropColumn.upgrade.opCalls.map(opCall => opCall.functionName), ['drop_column']);
    assert.deepEqual(dropColumn.downgrade.opCalls.map(opCall => opCall.functionName), ['add_column']);
    assert.deepEqual(dropTable.upgrade.opCalls.map(opCall => opCall.functionName), ['drop_table']);
    assert.deepEqual(dropTable.downgrade.opCalls.map(opCall => opCall.functionName), ['create_table']);
  });

  it('returns null for files missing downgrade', async () => {
    const parsed = await parseMigrationFile(fixturePath('not_a_migration.py'));
    assert.equal(parsed, null);
  });

  it('returns null for invalid python', async () => {
    const parsed = await parseMigrationFile(fixturePath('invalid_python.py'));
    assert.equal(parsed, null);
  });
});
