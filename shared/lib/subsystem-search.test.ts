import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchSubsystemSpecs } from './subsystem-search.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'subsystem-search-'));
}

function cleanUp(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n--- subsystem-search tests ---\n');

test('searchSubsystemSpecs returns ranked snippet matches', () => {
  const repoDir = makeTempRepo();
  try {
    const contextDir = join(repoDir, '.wavemill', 'context');
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, 'alpha.md'),
      `# Subsystem: Alpha\n\n## Purpose\nHandles login flows.\n\n## Architectural Constraints\nAuth tokens must be short lived.\n`,
      'utf-8',
    );

    writeFileSync(
      join(contextDir, 'beta.md'),
      `# Subsystem: Beta\n\n## Purpose\nAnalytics only.\n`,
      'utf-8',
    );

    const results = searchSubsystemSpecs('login', repoDir, { limit: 5 });
    assert.equal(results.length, 1);
    assert.equal(results[0].subsystemId, 'alpha');
    assert.equal(results[0].matchLocations[0], 'Purpose');
    assert.match(results[0].snippets[0], /Handles login flows/);
  } finally {
    cleanUp(repoDir);
  }
});

test('searchSubsystemSpecs honors section filtering', () => {
  const repoDir = makeTempRepo();
  try {
    const contextDir = join(repoDir, '.wavemill', 'context');
    mkdirSync(contextDir, { recursive: true });

    writeFileSync(
      join(contextDir, 'alpha.md'),
      `# Subsystem: Alpha\n\n## Purpose\nHandles login flows.\n\n## Architectural Constraints\nAuth tokens must be short lived.\n`,
      'utf-8',
    );

    const results = searchSubsystemSpecs('short lived', repoDir, {
      sectionFilter: 'Architectural Constraints',
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].matchLocations[0], 'Header');

    const noResults = searchSubsystemSpecs('login', repoDir, {
      sectionFilter: 'Architectural Constraints',
    });
    assert.equal(noResults.length, 0);
  } finally {
    cleanUp(repoDir);
  }
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
});
