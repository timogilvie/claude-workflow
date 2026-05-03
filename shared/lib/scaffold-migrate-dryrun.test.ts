import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scaffoldMigrateDryrun } from './scaffold-migrate-dryrun.ts';

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeFakeWavemillRoot(templateContent = 'name: test-template\n'): string {
  const root = makeTempDir('scaffold-migrate-dryrun-wavemill-');
  mkdirSync(join(root, 'templates'), { recursive: true });
  writeFileSync(join(root, 'templates', 'migrate-dryrun.yml'), templateContent, 'utf-8');
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('scaffoldMigrateDryrun', () => {
  it('writes both files into a fresh target repo', async () => {
    const wavemillRoot = makeFakeWavemillRoot('name: reusable\n');
    const targetDir = makeTempDir('scaffold-migrate-dryrun-target-');

    const result = await scaffoldMigrateDryrun({ targetDir, wavemillRoot });

    assert.equal(existsSync(result.reusablePath), true);
    assert.equal(existsSync(result.wrapperPath), true);
    assert.equal(readFileSync(result.reusablePath, 'utf-8'), 'name: reusable\n');
    assert.match(
      readFileSync(result.wrapperPath, 'utf-8'),
      /uses: \.\/\.github\/workflows\/_migrate-dryrun\.yml/
    );
    assert.equal(result.overwritten, false);
  });

  it('creates .github/workflows directory if absent', async () => {
    const wavemillRoot = makeFakeWavemillRoot();
    const targetDir = makeTempDir('scaffold-migrate-dryrun-target-');

    await scaffoldMigrateDryrun({ targetDir, wavemillRoot });

    assert.equal(existsSync(join(targetDir, '.github', 'workflows')), true);
  });

  it('refuses to overwrite existing files without force', async () => {
    const wavemillRoot = makeFakeWavemillRoot('name: original\n');
    const targetDir = makeTempDir('scaffold-migrate-dryrun-target-');

    await scaffoldMigrateDryrun({ targetDir, wavemillRoot });

    const wrapperPath = join(targetDir, '.github', 'workflows', 'migrate-dryrun.yml');
    const originalWrapper = readFileSync(wrapperPath, 'utf-8');
    writeFileSync(wrapperPath, 'name: modified\n', 'utf-8');

    await assert.rejects(
      scaffoldMigrateDryrun({ targetDir, wavemillRoot }),
      /Workflow files already exist/
    );
    assert.equal(readFileSync(wrapperPath, 'utf-8'), 'name: modified\n');
    assert.notEqual(readFileSync(wrapperPath, 'utf-8'), originalWrapper);
  });

  it('overwrites with force', async () => {
    const wavemillRoot = makeFakeWavemillRoot('name: reusable-v2\n');
    const targetDir = makeTempDir('scaffold-migrate-dryrun-target-');

    await scaffoldMigrateDryrun({ targetDir, wavemillRoot });

    const reusablePath = join(targetDir, '.github', 'workflows', '_migrate-dryrun.yml');
    writeFileSync(reusablePath, 'name: stale\n', 'utf-8');

    const result = await scaffoldMigrateDryrun({ targetDir, wavemillRoot, force: true });

    assert.equal(readFileSync(reusablePath, 'utf-8'), 'name: reusable-v2\n');
    assert.equal(result.overwritten, true);
  });

  it('wrapper substitutes provided inputs', async () => {
    const wavemillRoot = makeFakeWavemillRoot();
    const targetDir = makeTempDir('scaffold-migrate-dryrun-target-');

    await scaffoldMigrateDryrun({
      targetDir,
      wavemillRoot,
      runnerCmd: 'python manage.py migrate',
      pythonVersion: '3.12',
      dbName: 'custom_db',
      requirementsFile: 'requirements-dev.txt',
    });

    const wrapper = readFileSync(
      join(targetDir, '.github', 'workflows', 'migrate-dryrun.yml'),
      'utf-8'
    );
    assert.match(wrapper, /migration-runner-cmd: 'python manage\.py migrate'/);
    assert.match(wrapper, /python-version: '3\.12'/);
    assert.match(wrapper, /db-name: 'custom_db'/);
    assert.match(wrapper, /requirements-file: 'requirements-dev\.txt'/);
  });

  it('includes verify-reversibility in wrapper when option set', async () => {
    const wavemillRoot = makeFakeWavemillRoot();
    const targetDir = makeTempDir('scaffold-migrate-dryrun-target-');

    await scaffoldMigrateDryrun({
      targetDir,
      wavemillRoot,
      verifyReversibility: true,
    });

    const wrapper = readFileSync(
      join(targetDir, '.github', 'workflows', 'migrate-dryrun.yml'),
      'utf-8'
    );
    assert.match(wrapper, /verify-reversibility: true/);
  });

  it('throws if targetDir does not exist', async () => {
    const wavemillRoot = makeFakeWavemillRoot();
    const targetDir = join(makeTempDir('scaffold-migrate-dryrun-root-'), 'missing');

    await assert.rejects(
      scaffoldMigrateDryrun({ targetDir, wavemillRoot }),
      /Target directory is not a directory/
    );
  });

  it('throws if targetDir is a file, not a directory', async () => {
    const wavemillRoot = makeFakeWavemillRoot();
    const root = makeTempDir('scaffold-migrate-dryrun-root-');
    const targetFile = join(root, 'not-a-directory.txt');
    writeFileSync(targetFile, 'hello\n', 'utf-8');

    await assert.rejects(
      scaffoldMigrateDryrun({ targetDir: targetFile, wavemillRoot }),
      /Target directory is not a directory/
    );
  });
});
