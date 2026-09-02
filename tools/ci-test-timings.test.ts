import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assignShard,
  checkCiTimings,
  formatCheckResult,
  generateManifest,
  parseCiShardConfig,
} from './ci-test-timings.ts';
import type { WeightManifest } from '../shared/lib/test-partitioner.ts';

const toolPath = fileURLToPath(new URL('./ci-test-timings.ts', import.meta.url));

function manifestFixture(overrides: Partial<WeightManifest> = {}): WeightManifest {
  return {
    suite: 'unit',
    generatedAt: '2026-09-01T00:00:00Z',
    samples: ['s1', 's2', 's3'],
    defaultWeightMs: 500,
    weights: { 'a.test.ts': 4000, 'b.test.ts': 3000, 'c.test.ts': 100, 'd.test.ts': 100 },
    ...overrides,
  };
}

function workflowFixture(options: {
  unitShards?: number;
  unitNameDenominator?: number;
  unitRunDenominator?: number;
  customShards?: number;
  customUnsharded?: boolean;
} = {}): string {
  const unitShards = options.unitShards ?? 2;
  const unitName = options.unitNameDenominator ?? unitShards;
  const unitRun = options.unitRunDenominator ?? unitShards;
  const customShards = options.customShards ?? 2;
  const unitMatrix = Array.from({ length: unitShards }, (_, i) => i + 1).join(', ');
  const customMatrix = Array.from({ length: customShards }, (_, i) => i + 1).join(', ');
  const customBlock = options.customUnsharded
    ? `  custom:
    name: Custom Harness Tests
    runs-on: ubuntu-latest
    steps:
      - name: Run custom harness tests
        run: npm run test:custom
`
    : `  custom:
    name: Custom Harness Tests (shard \${{ matrix.shard }}/${customShards})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [${customMatrix}]
    steps:
      - name: Run custom harness test shard
        run: bash tests/run-custom-tests.sh --shard \${{ matrix.shard }}/${customShards}
`;

  return `name: CI

jobs:
  unit:
    name: Unit Tests (shard \${{ matrix.shard }}/${unitName})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [${unitMatrix}]
    steps:
      - name: Run unit test shard
        run: bash tests/run-unit-tests.sh --shard \${{ matrix.shard }}/${unitRun}
${customBlock}`;
}

interface FixtureRepoOptions {
  workflow: string;
  unitTests: string[];
  customTests: string[];
  unitManifest?: unknown;
  customManifest?: unknown;
}

function withFixtureRepo(options: FixtureRepoOptions, fn: (repoDir: string) => void): void {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ci-test-timings-'));
  try {
    mkdirSync(path.join(repoDir, '.github', 'workflows'), { recursive: true });
    mkdirSync(path.join(repoDir, 'tests', 'timings'), { recursive: true });
    writeFileSync(path.join(repoDir, '.github', 'workflows', 'ci.yml'), options.workflow);

    const listScript = (tests: string[]) =>
      `#!/usr/bin/env bash\nif [[ "\${1:-}" == "--list" ]]; then\n${tests.map((t) => `  echo "${t}"`).join('\n')}\n  exit 0\nfi\nexit 3\n`;
    const unitRunner = path.join(repoDir, 'tests', 'run-unit-tests.sh');
    const customRunner = path.join(repoDir, 'tests', 'run-custom-tests.sh');
    writeFileSync(unitRunner, listScript(options.unitTests));
    writeFileSync(customRunner, listScript(options.customTests));
    chmodSync(unitRunner, 0o755);
    chmodSync(customRunner, 0o755);

    const unitManifest = options.unitManifest ?? manifestFixture();
    const customManifest = options.customManifest ?? manifestFixture({
      suite: 'custom',
      weights: { 'x.test.ts': 1000, 'y.test.ts': 1000, 'z.test.sh': 2000 },
    });
    writeFileSync(
      path.join(repoDir, 'tests', 'timings', 'unit-weights.json'),
      JSON.stringify(unitManifest, null, 2),
    );
    writeFileSync(
      path.join(repoDir, 'tests', 'timings', 'custom-weights.json'),
      JSON.stringify(customManifest, null, 2),
    );

    fn(repoDir);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

test('assignShard is deterministic and shards cover the input exactly once', () => {
  const tests = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
  const manifest = manifestFixture();

  const shard1 = assignShard({ tests, manifest, shardIndex: 1, shardTotal: 2 });
  const shard2 = assignShard({ tests, manifest, shardIndex: 2, shardTotal: 2 });
  const again1 = assignShard({ tests, manifest, shardIndex: 1, shardTotal: 2 });

  assert.deepEqual(shard1, again1);
  assert.deepEqual([...shard1, ...shard2].sort(), [...tests].sort());
  assert.equal(shard1.filter((id) => shard2.includes(id)).length, 0);
});

test('assignShard rejects out-of-range shard indexes', () => {
  assert.throws(
    () => assignShard({ tests: ['a.test.ts'], manifest: manifestFixture(), shardIndex: 3, shardTotal: 2 }),
    /invalid shard 3\/2/,
  );
});

test('parseCiShardConfig extracts matrix values and both denominators', () => {
  const config = parseCiShardConfig(workflowFixture({ unitShards: 5 }), 'unit');
  assert.ok(config);
  assert.deepEqual(config.matrixShards, [1, 2, 3, 4, 5]);
  assert.equal(config.nameDenominator, 5);
  assert.equal(config.runDenominator, 5);

  const unsharded = parseCiShardConfig(workflowFixture({ customUnsharded: true }), 'custom');
  assert.ok(unsharded);
  assert.deepEqual(unsharded.matrixShards, []);
  assert.equal(unsharded.nameDenominator, null);
  assert.equal(unsharded.runDenominator, null);

  assert.equal(parseCiShardConfig(workflowFixture(), 'nonexistent'), null);
});

test('checkCiTimings passes on a consistent fixture repo and reports default-weight tests', () => {
  withFixtureRepo({
    workflow: workflowFixture(),
    unitTests: ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'new-unlisted.test.ts'],
    customTests: ['x.test.ts', 'y.test.ts', 'z.test.sh'],
  }, (repoDir) => {
    const result = checkCiTimings(repoDir);

    assert.equal(result.ok, true, formatCheckResult(result));
    const unit = result.suites.find((entry) => entry.suite === 'unit');
    assert.ok(unit);
    assert.equal(unit.shardTotal, 2);
    assert.equal(unit.registeredCount, 5);
    assert.ok(unit.warnings.some((warning) => warning.includes('new-unlisted.test.ts')));
  });
});

test('checkCiTimings fails when the --shard denominator disagrees with the matrix count', () => {
  withFixtureRepo({
    workflow: workflowFixture({ unitShards: 3, unitRunDenominator: 2 }),
    unitTests: ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'],
    customTests: ['x.test.ts', 'y.test.ts'],
  }, (repoDir) => {
    const result = checkCiTimings(repoDir);

    assert.equal(result.ok, false);
    const unit = result.suites.find((entry) => entry.suite === 'unit');
    assert.ok(unit);
    assert.ok(unit.errors.some((error) => error.includes('--shard denominator')));
  });
});

test('checkCiTimings fails when the job name denominator disagrees with the matrix count', () => {
  withFixtureRepo({
    workflow: workflowFixture({ unitShards: 3, unitNameDenominator: 5 }),
    unitTests: ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'],
    customTests: ['x.test.ts', 'y.test.ts'],
  }, (repoDir) => {
    const result = checkCiTimings(repoDir);

    assert.equal(result.ok, false);
    const unit = result.suites.find((entry) => entry.suite === 'unit');
    assert.ok(unit);
    assert.ok(unit.errors.some((error) => error.includes('name denominator')));
  });
});

test('checkCiTimings fails with a named diagnostic on a malformed manifest', () => {
  withFixtureRepo({
    workflow: workflowFixture(),
    unitTests: ['a.test.ts', 'b.test.ts'],
    customTests: ['x.test.ts', 'y.test.ts'],
    unitManifest: manifestFixture({ weights: { 'a.test.ts': -3 } }),
  }, (repoDir) => {
    const result = checkCiTimings(repoDir);

    assert.equal(result.ok, false);
    const unit = result.suites.find((entry) => entry.suite === 'unit');
    assert.ok(unit);
    assert.ok(unit.errors.some((error) => error.includes('invalid weight for "a.test.ts"')));
  });
});

test('checkCiTimings fails on a balance violation across divisible tests', () => {
  // Ten equal-cost tests forced onto 2 shards would balance fine; skew the
  // weights so one shard must exceed 130% of median while every single test
  // stays under the limit.
  const weights: Record<string, number> = {
    'a.test.ts': 100, 'b.test.ts': 100, 'c.test.ts': 100, 'd.test.ts': 100,
  };
  withFixtureRepo({
    workflow: workflowFixture({ unitShards: 3 }),
    unitTests: ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'],
    customTests: ['x.test.ts', 'y.test.ts'],
    unitManifest: manifestFixture({ weights, defaultWeightMs: 100 }),
  }, (repoDir) => {
    const result = checkCiTimings(repoDir);
    const unit = result.suites.find((entry) => entry.suite === 'unit');
    assert.ok(unit);
    // 4 tests of 100ms on 3 shards -> [200, 100, 100]: violation, not hotspot.
    assert.equal(result.ok, false);
    assert.ok(unit.errors.some((error) => error.includes('exceeds')));
  });
});

test('checkCiTimings accepts an unsharded custom job (rollback layout)', () => {
  withFixtureRepo({
    workflow: workflowFixture({ customUnsharded: true }),
    unitTests: ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'],
    customTests: ['x.test.ts', 'y.test.ts', 'z.test.sh'],
  }, (repoDir) => {
    const result = checkCiTimings(repoDir);

    assert.equal(result.ok, true, formatCheckResult(result));
    const custom = result.suites.find((entry) => entry.suite === 'custom');
    assert.ok(custom);
    assert.equal(custom.shardTotal, 1);
  });
});

test('generateManifest records labels, medians, and a conservative default', () => {
  const manifest = generateManifest({
    suite: 'custom',
    samples: [
      { results: [{ file: 'x.test.ts', ms: 100 }, { file: 'y.test.ts', ms: 9000 }] },
      { results: [{ file: 'x.test.ts', ms: 300 }, { file: 'y.test.ts', ms: 11000 }] },
      { results: [{ file: 'x.test.ts', ms: 200 }, { file: 'y.test.ts', ms: 10000 }] },
    ],
    sampleLabels: ['run-1.json', 'run-2.json', 'run-3.json'],
  });

  assert.equal(manifest.suite, 'custom');
  assert.deepEqual(manifest.samples, ['run-1.json', 'run-2.json', 'run-3.json']);
  assert.equal(manifest.weights['x.test.ts'], 200);
  assert.equal(manifest.weights['y.test.ts'], 10000);
  assert.equal(manifest.defaultWeightMs, 10000);
});

test('generateManifest refuses fewer than 3 samples without allowFew', () => {
  assert.throws(
    () => generateManifest({
      suite: 'unit',
      samples: [{ results: [{ file: 'a.test.ts', ms: 10 }] }],
      sampleLabels: ['only.json'],
    }),
    /at least 3 are required/,
  );
});

test('CLI assign round-trips a stdin list deterministically', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-test-timings-cli-'));
  try {
    const weightsFile = path.join(dir, 'weights.json');
    writeFileSync(weightsFile, JSON.stringify(manifestFixture(), null, 2));
    const input = 'a.test.ts\nb.test.ts\nc.test.ts\nd.test.ts\ne.test.ts\n';
    const run = (shard: string) => execFileSync(
      process.execPath,
      [toolPath, 'assign', '--suite', 'unit', '--shard', shard, '--weights', weightsFile],
      { input, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).split('\n').filter(Boolean);

    const shard1 = run('1/2');
    const shard2 = run('2/2');

    assert.deepEqual(run('1/2'), shard1);
    assert.deepEqual([...shard1, ...shard2].sort(), ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI assign exits non-zero with a diagnostic on a malformed manifest', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-test-timings-cli-'));
  try {
    const weightsFile = path.join(dir, 'weights.json');
    writeFileSync(weightsFile, '{"suite": "unit", not json');
    assert.throws(
      () => execFileSync(
        process.execPath,
        [toolPath, 'assign', '--suite', 'unit', '--shard', '1/2', '--weights', weightsFile],
        { input: 'a.test.ts\n', encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ),
      (err: { status?: number; stderr?: string }) => {
        assert.equal(err.status, 1);
        assert.match(String(err.stderr), /malformed JSON/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
