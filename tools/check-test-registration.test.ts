import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkTestRegistration, formatTestRegistration } from './check-test-registration.ts';

function withRepo(entries: string[], testFiles: string[], fn: (repoDir: string) => void): void {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'test-registration-'));
  try {
    mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
    for (const testFile of testFiles) {
      const filePath = path.join(repoDir, testFile);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, '');
    }
    writeFileSync(path.join(repoDir, 'tests', 'run-unit-tests.sh'), `TESTS=(\n${entries.map((entry) => `  ${entry}`).join('\n')}\n)\n`);
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
