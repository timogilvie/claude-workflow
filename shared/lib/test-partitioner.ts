/**
 * Deterministic weighted test partitioner (HOK-2939).
 *
 * Assigns test files to CI shards using an LPT (longest-processing-time)
 * greedy algorithm over a checked-in weights manifest, so shard runtimes stay
 * balanced as the suite grows. The assignment is a pure function of
 * (file list, weights, defaultMs, shardCount): identical inputs always produce
 * byte-identical assignments, which is what lets every matrix leg compute the
 * full partition independently and select only its own shard.
 *
 * Invariants enforced here (REQ-F1/F2/F3):
 * - every input file is assigned to exactly one shard;
 * - malformed inputs (duplicate files, non-positive/non-finite weights,
 *   invalid shard counts) throw with the offending entry named — tests are
 *   never silently dropped;
 * - balance analysis flags any shard whose estimate exceeds a threshold ratio
 *   of the median shard estimate, with a named exception for a single
 *   indivisible test that alone exceeds the bound.
 *
 * @module test-partitioner
 */

/** Input to {@link partitionTests}. */
export interface PartitionOptions {
  /** Test files in registration order. Order is preserved within each shard. */
  files: string[];
  /** Measured weight (elapsed ms) per test file. Files absent here get defaultMs. */
  weights: Record<string, number>;
  /** Conservative weight for tests with no measurement yet. Must be finite and > 0. */
  defaultMs: number;
  /** Number of shards. Must be an integer >= 1 and <= files.length. */
  shardCount: number;
}

/** One shard's assignment. */
export interface ShardAssignment {
  /** Files assigned to this shard, in original registration order. */
  files: string[];
  /** Sum of effective weights for this shard's files, in ms. */
  estimatedMs: number;
}

/** Full partition result. */
export interface PartitionResult {
  shards: ShardAssignment[];
  /** Effective weight used for every input file (measured or defaultMs). */
  effectiveWeights: Record<string, number>;
}

/** Result of {@link analyzeBalance}. */
export interface BalanceAnalysis {
  /** Median of shard estimates, in ms. */
  medianMs: number;
  /** The configured threshold ratio (e.g. 1.3). */
  thresholdRatio: number;
  /** medianMs * thresholdRatio, in ms. */
  thresholdMs: number;
  /** Shards whose estimate exceeds thresholdMs without an allowed exception. */
  overloaded: Array<{ shardIndex: number; estimatedMs: number }>;
  /**
   * Shards over threshold that are excused because a single indivisible test
   * alone exceeds thresholdMs; the test is named so callers can report it.
   */
  indivisibleHotspots: Array<{ shardIndex: number; file: string; weightMs: number }>;
  /** True when no shard is overloaded (hotspot-excused shards still pass). */
  ok: boolean;
}

/**
 * Validate a weights map, throwing a diagnostic naming the first offending
 * entry. Exposed so manifest loaders can fail loudly rather than dropping
 * tests (task packet Section 6: malformed timing fails with a diagnostic).
 */
export function validateWeights(weights: Record<string, number>, context = 'weights'): void {
  for (const [file, weight] of Object.entries(weights)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(
        `${context}: invalid weight for "${file}": ${JSON.stringify(weight)} (must be a finite number > 0)`
      );
    }
  }
}

/**
 * Deterministically partition test files across shards using LPT greedy
 * assignment: files sorted by (weight desc, id asc) are each placed on the
 * shard with the smallest running total (ties broken by lowest shard index).
 *
 * @throws Error on duplicate files, invalid shard count, non-positive
 *   defaultMs, or invalid weight values; the offending entry is named.
 */
export function partitionTests(options: PartitionOptions): PartitionResult {
  const { files, weights, defaultMs, shardCount } = options;

  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`test-partitioner: shardCount must be an integer >= 1, got ${shardCount}`);
  }
  if (typeof defaultMs !== 'number' || !Number.isFinite(defaultMs) || defaultMs <= 0) {
    throw new Error(`test-partitioner: defaultMs must be a finite number > 0, got ${defaultMs}`);
  }
  if (files.length === 0) {
    throw new Error('test-partitioner: no test files provided');
  }
  if (shardCount > files.length) {
    throw new Error(
      `test-partitioner: shardCount ${shardCount} exceeds test count ${files.length}; a shard would be empty`
    );
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) {
      throw new Error(`test-partitioner: duplicate test file "${file}"`);
    }
    seen.add(file);
  }
  validateWeights(weights, 'test-partitioner');

  const effectiveWeights: Record<string, number> = {};
  for (const file of files) {
    effectiveWeights[file] = Object.prototype.hasOwnProperty.call(weights, file)
      ? weights[file]
      : defaultMs;
  }

  // LPT greedy: heaviest first; ties broken by byte-order id comparison so the
  // sort is total and locale-independent (determinism, REQ-F2).
  const ordered = [...files].sort((a, b) => {
    const diff = effectiveWeights[b] - effectiveWeights[a];
    if (diff !== 0) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const totals = new Array<number>(shardCount).fill(0);
  const assignment = new Map<string, number>();
  for (const file of ordered) {
    let target = 0;
    for (let i = 1; i < shardCount; i++) {
      if (totals[i] < totals[target]) target = i;
    }
    assignment.set(file, target);
    totals[target] += effectiveWeights[file];
  }

  // Rebuild each shard in original registration order so execution order stays
  // stable regardless of weight changes.
  const shards: ShardAssignment[] = Array.from({ length: shardCount }, () => ({
    files: [],
    estimatedMs: 0,
  }));
  for (const file of files) {
    const index = assignment.get(file)!;
    shards[index].files.push(file);
    shards[index].estimatedMs += effectiveWeights[file];
  }

  return { shards, effectiveWeights };
}

/**
 * Analyze shard balance against the REQ-F3 rule: no shard's estimated total
 * may exceed `thresholdRatio` x the median shard estimate, unless a single
 * indivisible test alone exceeds that bound — in which case the test is named
 * and the shard is excused.
 */
export function analyzeBalance(
  partition: PartitionResult,
  { thresholdRatio = 1.3 }: { thresholdRatio?: number } = {}
): BalanceAnalysis {
  const estimates = partition.shards.map((shard) => shard.estimatedMs);
  const medianMs = median(estimates);
  const thresholdMs = medianMs * thresholdRatio;

  const overloaded: BalanceAnalysis['overloaded'] = [];
  const indivisibleHotspots: BalanceAnalysis['indivisibleHotspots'] = [];

  partition.shards.forEach((shard, shardIndex) => {
    if (shard.estimatedMs <= thresholdMs) return;
    let heaviest: { file: string; weightMs: number } | null = null;
    for (const file of shard.files) {
      const weightMs = partition.effectiveWeights[file];
      if (!heaviest || weightMs > heaviest.weightMs) {
        heaviest = { file, weightMs };
      }
    }
    if (heaviest && heaviest.weightMs > thresholdMs) {
      indivisibleHotspots.push({ shardIndex, ...heaviest });
    } else {
      overloaded.push({ shardIndex, estimatedMs: shard.estimatedMs });
    }
  });

  return {
    medianMs,
    thresholdRatio,
    thresholdMs,
    overloaded,
    indivisibleHotspots,
    ok: overloaded.length === 0,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
