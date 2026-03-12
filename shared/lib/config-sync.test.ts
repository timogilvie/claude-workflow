import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import {
  CANONICAL_CONFIG_TEMPLATE,
  deepMergeConfig,
  identifyConfigAdditions,
  prepareConfigSync,
} from './config-sync.ts';

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
  return mkdtempSync(join(tmpdir(), 'config-sync-'));
}

function cleanUp(dir: string) {
  clearConfigCache(dir);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n--- config-sync tests ---\n');

test('deepMergeConfig preserves user values while adding missing defaults', () => {
  const merged = deepMergeConfig(
    { a: 1, nested: { keep: true, missing: 'x' }, arr: [1, 2] },
    { nested: { keep: false }, arr: [9], extra: 'y' },
  );

  assert.deepEqual(merged, {
    a: 1,
    nested: { keep: false, missing: 'x' },
    arr: [9],
    extra: 'y',
  });
});

test('identifyConfigAdditions reports new nested paths', () => {
  const additions = identifyConfigAdditions({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 });
  assert.deepEqual(additions.sort(), ['a.c', 'd']);
});

test('prepareConfigSync merges current config with canonical template', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({
        configVersion: '1.0.0',
        mill: { maxParallel: 7 },
      }),
      'utf-8',
    );
    clearConfigCache(repoDir);

    const prepared = prepareConfigSync(repoDir);
    assert.equal(prepared.configExists, true);
    assert.equal(prepared.mergedConfig.mill?.maxParallel, 7);
    assert.equal(prepared.mergedConfig.linear?.project, CANONICAL_CONFIG_TEMPLATE.linear?.project);
    assert.ok(prepared.additions.includes('linear'));
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
