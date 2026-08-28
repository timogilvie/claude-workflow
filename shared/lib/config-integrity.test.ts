import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExcerpt,
  checkConfigIntegrity,
  clearConfigIntegrityCache,
  computeLineColumn,
  extractPositionFromError,
} from './config-integrity.ts';
import { clearConfigCache } from './config.ts';

// Path to the canonical (repo-root) schema; used to seed each fixture with a
// valid worktree schema so the checker exercises the resolution path
// production code takes.
const CANONICAL_SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'wavemill-config.schema.json',
);

function makeFixture(name: string): { repoDir: string; schemaPath: string; homeDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), `config-integrity-${name}-`));
  const schemaPath = join(repoDir, 'wavemill-config.schema.json');
  copyFileSync(CANONICAL_SCHEMA_PATH, schemaPath);
  const homeDir = mkdtempSync(join(tmpdir(), `config-integrity-home-${name}-`));
  clearConfigIntegrityCache();
  clearConfigCache(repoDir);
  return { repoDir, schemaPath, homeDir };
}

function cleanup(repoDir: string, homeDir?: string): void {
  rmSync(repoDir, { recursive: true, force: true });
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  clearConfigCache(repoDir);
  clearConfigIntegrityCache();
}

test('valid schema and no configs produces no issues', () => {
  const fixture = makeFixture('valid');
  try {
    const issues = checkConfigIntegrity({ repoDir: fixture.repoDir, homeDir: fixture.homeDir });
    assert.deepEqual(issues, []);
  } finally {
    cleanup(fixture.repoDir, fixture.homeDir);
  }
});

test('malformed schema surfaces a schema-parse issue with file, line, column, and excerpt', () => {
  const fixture = makeFixture('malformed-schema');
  try {
    const original = readFileSync(fixture.schemaPath, 'utf-8');
    // Insert a stray comma-brace that breaks the JSON somewhere deep in the file.
    // Injecting at position 300 keeps the payload similar to the incident's
    // "closed the root object early" shape but easy to compute line/column for.
    const injectAt = 300;
    const injected = `${original.slice(0, injectAt)}},BREAK\n${original.slice(injectAt)}`;
    writeFileSync(fixture.schemaPath, injected);

    const issues = checkConfigIntegrity({ repoDir: fixture.repoDir, homeDir: fixture.homeDir });
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.equal(issue.kind, 'schema-parse');
    assert.equal(issue.file, fixture.schemaPath);
    assert.ok(typeof issue.position === 'number' && issue.position >= 300);
    assert.ok(typeof issue.line === 'number' && issue.line >= 1);
    assert.ok(typeof issue.column === 'number' && issue.column >= 1);
    assert.ok(typeof issue.excerpt === 'string' && issue.excerpt.length > 0);
    assert.match(issue.message, /position|Unexpected/);
  } finally {
    cleanup(fixture.repoDir, fixture.homeDir);
  }
});

test('malformed .wavemill-config.json produces one config-parse issue naming that file', () => {
  const fixture = makeFixture('bad-repo-config');
  try {
    const configPath = join(fixture.repoDir, '.wavemill-config.json');
    writeFileSync(configPath, '{\n  "mill": {\n    "maxParallel": 3,\n  \n');

    const issues = checkConfigIntegrity({ repoDir: fixture.repoDir, homeDir: fixture.homeDir });
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.equal(issue.kind, 'config-parse');
    assert.equal(issue.file, configPath);
    assert.ok(typeof issue.position === 'number');
    assert.ok(typeof issue.line === 'number' && issue.line >= 1);
    assert.ok(typeof issue.column === 'number' && issue.column >= 1);
  } finally {
    cleanup(fixture.repoDir, fixture.homeDir);
  }
});

test('malformed .wavemill-config.local.json is caught even when base config is missing', () => {
  const fixture = makeFixture('bad-local-config');
  try {
    const localPath = join(fixture.repoDir, '.wavemill-config.local.json');
    writeFileSync(localPath, '{ "router": { "enabled": true,, } }');

    const issues = checkConfigIntegrity({ repoDir: fixture.repoDir, homeDir: fixture.homeDir });
    assert.ok(issues.length >= 1);
    const [issue] = issues;
    assert.equal(issue.kind, 'config-parse');
    assert.equal(issue.file, localPath);
  } finally {
    cleanup(fixture.repoDir, fixture.homeDir);
  }
});

test('malformed ~/.wavemill/config.json is caught via injected homeDir', () => {
  const fixture = makeFixture('bad-global-config');
  try {
    const globalDir = join(fixture.homeDir, '.wavemill');
    mkdirSync(globalDir, { recursive: true });
    const globalPath = join(globalDir, 'config.json');
    writeFileSync(globalPath, '{ oops }');

    const issues = checkConfigIntegrity({ repoDir: fixture.repoDir, homeDir: fixture.homeDir });
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.equal(issue.kind, 'config-parse');
    assert.equal(issue.file, globalPath);
  } finally {
    cleanup(fixture.repoDir, fixture.homeDir);
  }
});

test('missing global config file is not an issue', () => {
  const fixture = makeFixture('no-global-config');
  try {
    // homeDir is empty — no .wavemill/config.json
    const issues = checkConfigIntegrity({ repoDir: fixture.repoDir, homeDir: fixture.homeDir });
    assert.deepEqual(issues, []);
  } finally {
    cleanup(fixture.repoDir, fixture.homeDir);
  }
});

test('schema-valid JSON with schema-invalid content produces a config-validate issue', () => {
  const fixture = makeFixture('schema-invalid');
  try {
    const configPath = join(fixture.repoDir, '.wavemill-config.json');
    // maxParallel is typed as an integer; a string here forces Ajv to reject.
    writeFileSync(configPath, JSON.stringify({ mill: { maxParallel: 'three' } }));

    const issues = checkConfigIntegrity({ repoDir: fixture.repoDir, homeDir: fixture.homeDir });
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.equal(issue.kind, 'config-validate');
    assert.equal(issue.file, join(fixture.repoDir, '.wavemill-config.json'));
    assert.match(issue.message, /Config validation failed|must be/);
  } finally {
    cleanup(fixture.repoDir, fixture.homeDir);
  }
});

test('unreadable schema file surfaces as a parse issue, not a thrown exception', () => {
  const fixture = makeFixture('unreadable-schema');
  try {
    // Remove read permission and rely on the checker guarding the readFileSync
    // path. Root would still succeed, so also validate the branch where the
    // file simply cannot be parsed.
    let unreadableWorked = false;
    try {
      chmodSync(fixture.schemaPath, 0o000);
      unreadableWorked = true;
    } catch {
      // best effort — some CI environments do not allow chmod 0
    }

    if (!unreadableWorked) {
      writeFileSync(fixture.schemaPath, '\x00\x01\x02\x03 not json at all');
    }

    let issues: ReturnType<typeof checkConfigIntegrity>;
    try {
      issues = checkConfigIntegrity({ repoDir: fixture.repoDir, homeDir: fixture.homeDir });
    } catch (err) {
      assert.fail(`checkConfigIntegrity threw instead of reporting: ${err instanceof Error ? err.message : String(err)}`);
    }
    assert.ok(issues.length >= 1);
    assert.equal(issues[0].kind, 'schema-parse');
  } finally {
    // Restore permission so cleanup can remove the file.
    try { chmodSync(fixture.schemaPath, 0o644); } catch { /* ignore */ }
    cleanup(fixture.repoDir, fixture.homeDir);
  }
});

test('extractPositionFromError parses both V8 error shapes', () => {
  assert.equal(
    extractPositionFromError('Unexpected non-whitespace character after JSON at position 141378 (line 2903 column 6)'),
    141378,
  );
  assert.equal(
    extractPositionFromError('Unexpected token } in JSON at position 42'),
    42,
  );
  assert.equal(extractPositionFromError('a totally unrelated error'), null);
});

test('computeLineColumn is 1-based and treats \\r\\n as a single line break', () => {
  assert.deepEqual(computeLineColumn('abc\ndef', 0), { line: 1, column: 1 });
  assert.deepEqual(computeLineColumn('abc\ndef', 3), { line: 1, column: 4 });
  assert.deepEqual(computeLineColumn('abc\ndef', 4), { line: 2, column: 1 });
  assert.deepEqual(computeLineColumn('abc\r\ndef', 5), { line: 2, column: 1 });
  assert.deepEqual(computeLineColumn('', 0), { line: 1, column: 1 });
});

test('buildExcerpt returns a compact single-line snippet around the offending position', () => {
  const content = '   { "a": 1,\n"broken here": ,\n"c": 3 }   ';
  const excerpt = buildExcerpt(content, 22);
  assert.ok(excerpt.length > 0);
  assert.ok(!excerpt.includes('\n'));
  assert.ok(excerpt.length <= 60);
});
