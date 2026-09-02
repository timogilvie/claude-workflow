/**
 * Deterministic weighted test partitioning for CI sharding (HOK-2939).
 *
 * The bash `TESTS=(...)` arrays in tests/run-unit-tests.sh and
 * tests/run-custom-tests.sh remain the single registration source. At runtime
 * each shard pipes its full registered list to `tools/ci-test-timings.ts
 * assign`, which calls {@link partition} with the checked-in weight manifest
 * (tests/timings/<suite>-weights.json) and prints that shard's subset.
 *
 * Invariants:
 * - Assignment is a pure function of (tests, weights, defaultWeightMs,
 *   shardTotal): identical inputs produce byte-identical assignments (REQ-F2).
 * - Every input test is assigned exactly once by construction (REQ-F1); tests
 *   absent from the manifest get the manifest's conservative default weight.
 * - Zero/negative/non-finite weights are hard errors naming the entry --
 *   a malformed manifest must fail loudly, never silently drop or reroute a
 *   test.
 * - No shard estimate may exceed 130% of the median shard estimate unless a
 *   single named test's weight alone exceeds that bound (REQ-F3).
 *
 * @module test-partitioner
 */

/** One measured test-file entry inside a timing sample artifact. */
export interface TimingResult {
  /** Repo-relative path (unit) or runner-relative id (custom). */
  file: string;
  /** Elapsed wall time in milliseconds. */
  ms: number;
  /** 'pass' | 'fail' -- recorded for transparency, not used for weighting. */
  result?: string;
}

/** Timing artifact written by the runners / file-timing-reporter. */
export interface TimingSample {
  suite?: string;
  shard?: string | number;
  generatedAt?: string;
  results: TimingResult[];
}

/** Checked-in weight manifest (tests/timings/<suite>-weights.json). */
export interface WeightManifest {
  suite: string;
  generatedAt: string;
  /** Labels of the samples the medians were computed from (>=3 required). */
  samples: string[];
  /** Conservative weight for tests missing from `weights` (p90 of knowns). */
  defaultWeightMs: number;
  /** Median elapsed ms per test id. */
  weights: Record<string, number>;
}

export interface PartitionInput {
  /** Full registered test list, in registration order. */
  tests: string[];
  /** Test id -> weight in ms. Missing ids fall back to defaultWeightMs. */
  weights: Record<string, number>;
  /** Weight assumed for tests absent from `weights`. Must be positive finite. */
  defaultWeightMs: number;
  /** Number of shards (>= 1). */
  shardTotal: number;
}

export interface PartitionAssignment {
  /** shards[i] lists the tests of shard i+1 in input-list order. */
  shards: string[][];
  /** Estimated total ms per shard, same index as `shards`. */
  estimates: number[];
  /** Effective weight used for each test (manifest value or default). */
  effectiveWeights: Record<string, number>;
}

export interface BalanceViolation {
  shard: number;
  estimateMs: number;
  limitMs: number;
}

export interface IndivisibleHotspot {
  shard: number;
  test: string;
  weightMs: number;
  limitMs: number;
}

export interface BalanceReport {
  estimates: number[];
  medianMs: number;
  maxMs: number;
  /** max/median ratio, 1.0 when perfectly flat. */
  maxOverMedian: number;
  /**
   * Shards whose estimate exceeds ratioLimit * median AND that cannot claim
   * the single-test exception. Any entry here is a balance failure (REQ-F3).
   */
  violations: BalanceViolation[];
  /**
   * Shards over the limit where one named test alone exceeds the limit --
   * the explicitly allowed indivisible-hotspot exception.
   */
  indivisibleHotspots: IndivisibleHotspot[];
  ok: boolean;
}

/** REQ-F3 bound: no shard may exceed 130% of the median shard estimate. */
export const BALANCE_RATIO_LIMIT = 1.3;

/**
 * Validate a single weight value, throwing a diagnostic that names the entry.
 */
function assertValidWeight(id: string, value: unknown, source: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `test-partitioner: invalid weight for "${id}" in ${source}: `
      + `${JSON.stringify(value)} (weights must be positive finite numbers)`,
    );
  }
  return value;
}

/**
 * Deterministic greedy LPT (longest processing time) partition.
 *
 * Tests are sorted by (weight desc, id asc) and assigned one at a time to the
 * currently lightest shard, ties broken by lowest shard index. Output order
 * within each shard follows the original input list so the runners execute in
 * a stable, registration-like order.
 *
 * @throws on duplicate test ids, non-positive/non-finite weights, or an
 *   invalid shard count -- callers must fail loudly rather than fall back to
 *   a different selection.
 */
export function partition(input: PartitionInput): PartitionAssignment {
  const { tests, weights, defaultWeightMs, shardTotal } = input;

  if (!Number.isInteger(shardTotal) || shardTotal < 1) {
    throw new Error(`test-partitioner: invalid shardTotal ${shardTotal}`);
  }
  assertValidWeight('(defaultWeightMs)', defaultWeightMs, 'partition input');

  const seen = new Set<string>();
  for (const test of tests) {
    if (seen.has(test)) {
      throw new Error(`test-partitioner: duplicate test id "${test}" in input list`);
    }
    seen.add(test);
  }

  const effectiveWeights: Record<string, number> = {};
  for (const test of tests) {
    effectiveWeights[test] = Object.hasOwn(weights, test)
      ? assertValidWeight(test, weights[test], 'weight manifest')
      : defaultWeightMs;
  }

  const byCostDesc = [...tests].sort((a, b) => {
    const diff = effectiveWeights[b] - effectiveWeights[a];
    if (diff !== 0) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const estimates = new Array<number>(shardTotal).fill(0);
  const shardOf = new Map<string, number>();
  for (const test of byCostDesc) {
    let lightest = 0;
    for (let i = 1; i < shardTotal; i++) {
      if (estimates[i] < estimates[lightest]) lightest = i;
    }
    shardOf.set(test, lightest);
    estimates[lightest] += effectiveWeights[test];
  }

  const shards: string[][] = Array.from({ length: shardTotal }, () => []);
  for (const test of tests) {
    shards[shardOf.get(test) as number].push(test);
  }

  return { shards, estimates, effectiveWeights };
}

/**
 * Evaluate the REQ-F3 balance rule over a partition assignment.
 *
 * A shard estimate above `ratioLimit * median` is a violation unless a single
 * test in that shard has weight alone above the limit; then it is reported as
 * a named indivisible hotspot instead.
 */
export function balanceReport(
  assignment: PartitionAssignment,
  ratioLimit: number = BALANCE_RATIO_LIMIT,
): BalanceReport {
  const { estimates, shards, effectiveWeights } = assignment;
  const medianMs = median(estimates);
  const maxMs = Math.max(...estimates);
  const limitMs = medianMs * ratioLimit;

  const violations: BalanceViolation[] = [];
  const indivisibleHotspots: IndivisibleHotspot[] = [];

  for (let i = 0; i < estimates.length; i++) {
    if (estimates[i] <= limitMs) continue;
    const heaviest = shards[i].reduce(
      (best, test) => (effectiveWeights[test] > effectiveWeights[best] ? test : best),
      shards[i][0],
    );
    if (heaviest !== undefined && effectiveWeights[heaviest] > limitMs) {
      indivisibleHotspots.push({
        shard: i + 1,
        test: heaviest,
        weightMs: effectiveWeights[heaviest],
        limitMs,
      });
    } else {
      violations.push({ shard: i + 1, estimateMs: estimates[i], limitMs });
    }
  }

  return {
    estimates,
    medianMs,
    maxMs,
    maxOverMedian: medianMs > 0 ? maxMs / medianMs : 1,
    violations,
    indivisibleHotspots,
    ok: violations.length === 0,
  };
}

export interface MergeSamplesOptions {
  /**
   * Permit fewer than 3 samples. A single noisy run must not become a
   * permanent manifest (packet constraint), so this exists only for tests and
   * explicitly flagged local bootstrap.
   */
  allowFew?: boolean;
}

export interface MergedWeights {
  /** Median ms per test id, rounded to integers >= 1. */
  weights: Record<string, number>;
  /** p90 of the merged medians -- the conservative default for unknown tests. */
  defaultWeightMs: number;
  sampleCount: number;
}

/**
 * Merge >=3 timing samples into median-per-test weights.
 *
 * Malformed entries (missing file, non-finite or negative ms) throw with a
 * diagnostic naming the sample and entry rather than dropping the test.
 */
export function mergeSamples(samples: TimingSample[], options: MergeSamplesOptions = {}): MergedWeights {
  if (samples.length < 3 && !options.allowFew) {
    throw new Error(
      `test-partitioner: refusing to build a weight manifest from ${samples.length} sample(s); `
      + 'at least 3 are required so a single noisy run cannot skew shard balance '
      + '(pass --allow-few only for explicit local bootstrap)',
    );
  }
  if (samples.length === 0) {
    throw new Error('test-partitioner: no timing samples given');
  }

  const byTest = new Map<string, number[]>();
  samples.forEach((sample, index) => {
    if (!Array.isArray(sample.results)) {
      throw new Error(`test-partitioner: sample ${index + 1} has no results array`);
    }
    for (const entry of sample.results) {
      if (typeof entry?.file !== 'string' || entry.file.length === 0) {
        throw new Error(`test-partitioner: sample ${index + 1} has an entry without a file id`);
      }
      if (typeof entry.ms !== 'number' || !Number.isFinite(entry.ms) || entry.ms < 0) {
        throw new Error(
          `test-partitioner: sample ${index + 1} has invalid ms for "${entry.file}": `
          + `${JSON.stringify(entry.ms)}`,
        );
      }
      const list = byTest.get(entry.file) ?? [];
      list.push(entry.ms);
      byTest.set(entry.file, list);
    }
  });

  const weights: Record<string, number> = {};
  for (const file of [...byTest.keys()].sort()) {
    weights[file] = Math.max(1, Math.round(median(byTest.get(file) as number[])));
  }

  return {
    weights,
    defaultWeightMs: computeDefaultWeight(weights),
    sampleCount: samples.length,
  };
}

/**
 * Conservative default weight for tests absent from the manifest: the p90 of
 * known weights. New tests are over- rather than under-budgeted so a fresh
 * test cannot silently overload one shard.
 */
export function computeDefaultWeight(weights: Record<string, number>): number {
  const values = Object.values(weights).sort((a, b) => a - b);
  if (values.length === 0) return 1000;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * 0.9) - 1));
  return Math.max(1, values[index]);
}

/**
 * Validate a parsed manifest object, throwing named diagnostics on any
 * malformed field. Returns the manifest typed for downstream use.
 */
export function validateManifest(raw: unknown, source: string): WeightManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`test-partitioner: ${source} is not a JSON object`);
  }
  const manifest = raw as Partial<WeightManifest>;
  if (typeof manifest.suite !== 'string' || manifest.suite.length === 0) {
    throw new Error(`test-partitioner: ${source} is missing "suite"`);
  }
  if (typeof manifest.weights !== 'object' || manifest.weights === null) {
    throw new Error(`test-partitioner: ${source} is missing "weights"`);
  }
  assertValidWeight('(defaultWeightMs)', manifest.defaultWeightMs, source);
  for (const [id, value] of Object.entries(manifest.weights)) {
    assertValidWeight(id, value, source);
  }
  return manifest as WeightManifest;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
