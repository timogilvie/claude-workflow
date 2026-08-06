import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCiCommandMapDrift, formatCiCommandMapDrift } from './check-ci-command-map-drift.ts';

async function withRepo(
  workflow: string,
  localCommandMap: Record<string, string>,
  fn: (repoDir: string) => void,
): Promise<void> {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ci-command-map-drift-'));
  try {
    mkdirSync(path.join(repoDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(repoDir, '.github', 'workflows', 'ci.yml'), workflow);
    writeFileSync(path.join(repoDir, '.wavemill-config.json'), JSON.stringify({
      ready: { localCommandMap },
    }, null, 2));
    fn(repoDir);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

const BASE_WORKFLOW = `name: CI

jobs:
  preflight:
    name: Preflight Checks
    runs-on: ubuntu-latest
  shell:
    name: Shell Tests (shard \${{ matrix.shard }}/4)
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
  aggregate:
    name: Shell and Unit Tests
    runs-on: ubuntu-latest
`;

test('checkCiCommandMapDrift passes when every runnable job is mapped', async () => {
  await withRepo(BASE_WORKFLOW, {
    'Preflight Checks': 'npm run lint && npm run test:preflight',
    'Shell Tests': 'npm run test:shell',
  }, (repoDir) => {
    const result = checkCiCommandMapDrift(repoDir);

    assert.equal(result.ok, true);
    assert.equal(result.unmappedJobs.length, 0);
    assert.equal(result.checkedJobs.length, 5);
    assert.deepEqual(result.skippedJobs, ['Shell and Unit Tests']);
  });
});

test('checkCiCommandMapDrift reports missing mappings clearly', async () => {
  await withRepo(BASE_WORKFLOW, {
    'Preflight Checks': 'npm run lint && npm run test:preflight',
  }, (repoDir) => {
    const result = checkCiCommandMapDrift(repoDir);
    const message = formatCiCommandMapDrift(result);

    assert.equal(result.ok, false);
    assert.deepEqual(result.unmappedJobs, [
      'Shell Tests (shard 1/4)',
      'Shell Tests (shard 2/4)',
      'Shell Tests (shard 3/4)',
      'Shell Tests (shard 4/4)',
    ]);
    assert.match(message, /unmapped CI jobs/);
    assert.match(message, /Shell Tests \(shard 2\/4\)/);
    assert.match(message, /ready\.localCommandMap/);
  });
});

test('checkCiCommandMapDrift allows explicit non-runnable CI jobs', async () => {
  await withRepo(`name: CI

jobs:
  check-paths:
    name: Check Lifecycle Paths
    runs-on: ubuntu-latest
`, {}, (repoDir) => {
    const result = checkCiCommandMapDrift(repoDir);

    assert.equal(result.ok, true);
    assert.deepEqual(result.checkedJobs, []);
    assert.deepEqual(result.skippedJobs, ['Check Lifecycle Paths']);
  });
});

test('checkCiCommandMapDrift tolerates shard count changes through base recipe lookup', async () => {
  await withRepo(`name: CI

jobs:
  shell:
    name: Shell Tests (shard \${{ matrix.shard }}/5)
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4, 5]
`, {
    'Shell Tests': 'npm run test:shell',
  }, (repoDir) => {
    const result = checkCiCommandMapDrift(repoDir);

    assert.equal(result.ok, true);
    assert.equal(result.checkedJobs.length, 5);
  });
});
