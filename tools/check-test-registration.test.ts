import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkTestRegistration, formatTestRegistration } from './check-test-registration.ts';

interface RepoOptions {
  customTsEntries?: string[];
  customShEntries?: string[];
}

function withRepo(entries: string[], testFiles: string[], fn: (repoDir: string) => void, options: RepoOptions = {}): void {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'test-registration-'));
  try {
    mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
    for (const testFile of testFiles) {
      const filePath = path.join(repoDir, testFile);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, '');
    }
    writeFileSync(path.join(repoDir, 'tests', 'run-unit-tests.sh'), `TESTS=(\n${entries.map((entry) => `  ${entry}`).join('\n')}\n)\n`);
    const customTs = (options.customTsEntries ?? []).map((entry) => `  ${entry}`).join('\n');
    const customSh = (options.customShEntries ?? []).map((entry) => `  ${entry}`).join('\n');
    writeFileSync(
      path.join(repoDir, 'tests', 'run-custom-tests.sh'),
      `CUSTOM_TS_TESTS=(\n${customTs}\n)\n\nCUSTOM_SH_TESTS=(\n${customSh}\n)\n`
    );
    fn(repoDir);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

test('checkTestRegistration passes when discovered tests are registered exactly once', () => {
  withRepo(['shared/lib/a.test.ts', 'tools/b.test.ts'], ['shared/lib/a.test.ts', 'tools/b.test.ts'], (repoDir) => {
    const result = checkTestRegistration(repoDir);

    assert.equal(result.ok, true);
    assert.deepEqual(result.unregistered, []);
    assert.match(formatTestRegistration(result), /2 discovered, 2 registered/);
  });
});

test('checkTestRegistration reports unregistered test files with the registration remedy', () => {
  withRepo(['shared/lib/a.test.ts'], ['shared/lib/a.test.ts', 'src/b.test.ts'], (repoDir) => {
    const result = checkTestRegistration(repoDir);
    const message = formatTestRegistration(result);

    assert.equal(result.ok, false);
    assert.deepEqual(result.unregistered, ['src/b.test.ts']);
    assert.match(message, /Unregistered test files:/);
    assert.match(message, /tests\/run-unit-tests\.sh/);
  });
});

test('checkTestRegistration reports stale and duplicate registrations', () => {
  withRepo(['tools/a.test.ts', 'tools/a.test.ts', 'tools/missing.test.ts'], ['tools/a.test.ts'], (repoDir) => {
    const result = checkTestRegistration(repoDir);

    assert.equal(result.ok, false);
    assert.deepEqual(result.stale, ['tools/missing.test.ts']);
    assert.deepEqual(result.duplicates, ['tools/a.test.ts']);
  });
});

test('checkTestRegistration passes with valid custom harness registrations', () => {
  withRepo(
    ['shared/lib/a.test.ts'],
    ['shared/lib/a.test.ts', 'tests/b.test.sh'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);
      assert.equal(result.ok, true);
      assert.deepEqual(result.customDuplicates, []);
      assert.deepEqual(result.customMissing, []);
    },
    { customTsEntries: ['shared/lib/a.test.ts'], customShEntries: ['tests/b.test.sh'] }
  );
});

test('checkTestRegistration reports duplicate custom harness registrations', () => {
  withRepo(
    ['shared/lib/a.test.ts'],
    ['shared/lib/a.test.ts'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);
      const message = formatTestRegistration(result);

      assert.equal(result.ok, false);
      assert.deepEqual(result.customDuplicates, ['shared/lib/a.test.ts']);
      assert.match(message, /Duplicate custom harness registrations:/);
    },
    { customTsEntries: ['shared/lib/a.test.ts', 'shared/lib/a.test.ts'] }
  );
});

test('checkTestRegistration reports custom harness entries whose files are missing', () => {
  withRepo(
    ['shared/lib/a.test.ts'],
    ['shared/lib/a.test.ts'],
    (repoDir) => {
      const result = checkTestRegistration(repoDir);
      const message = formatTestRegistration(result);

      assert.equal(result.ok, false);
      assert.deepEqual(result.customMissing, ['tests/gone.test.sh']);
      assert.match(message, /Missing custom harness test files:/);
      assert.match(message, /tests\/gone\.test\.sh/);
    },
    { customTsEntries: ['shared/lib/a.test.ts'], customShEntries: ['tests/gone.test.sh'] }
  );
});
