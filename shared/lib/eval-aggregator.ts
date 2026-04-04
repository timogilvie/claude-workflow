/**
 * Core aggregation module for collecting eval logs from multiple wavemill repositories.
 *
 * Provides functions for:
 * - Auto-discovering wavemill directories recursively
 * - Reading eval records from multiple repos
 * - Hash-based deduplication of identical records
 * - Aggregating records with statistics and reporting
 *
 * @module eval-aggregator
 */

import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { EvalRecord } from './eval-schema.ts';
import { readJsonlFile } from './jsonl-utils.ts';

// ────────────────────────────────────────────────────────────────
// Auto-Discovery
// ────────────────────────────────────────────────────────────────

export interface DiscoveryOptions {
  /** Maximum directory depth to search. Default: 5 */
  maxDepth?: number;
  /** Patterns to exclude from search (e.g., node_modules, .git) */
  excludePatterns?: RegExp[];
}

/**
 * Recursively discover all wavemill directories starting from a base directory.
 *
 * A wavemill directory is one containing `.wavemill/evals/evals.jsonl`.
 *
 * @param baseDir - Starting directory for recursive search
 * @param options - Configuration for discovery
 * @returns Array of directory paths containing wavemill eval logs
 *
 * @example
 * const dirs = discoverWavemillDirs('/path/to/repos');
 * // Returns: ['/path/to/repos/repo1', '/path/to/repos/repo2/subdir']
 */
export function discoverWavemillDirs(baseDir: string, options: DiscoveryOptions = {}): string[] {
  const maxDepth = options.maxDepth ?? 5;
  const excludePatterns = options.excludePatterns ?? [
    /node_modules/,
    /\.git$/,
    /\.wavemill$/,
    /\..+$/,
  ];

  const found: string[] = [];

  function isExcluded(dirName: string): boolean {
    return excludePatterns.some((pattern) => pattern.test(dirName));
  }

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    if (!existsSync(dir)) return;

    // Check if this directory contains .wavemill/evals/evals.jsonl
    const evalsPath = join(dir, '.wavemill', 'evals', 'evals.jsonl');
    if (existsSync(evalsPath)) {
      found.push(dir);
      // Still scan subdirectories in case there are nested repos
    }

    // Scan subdirectories
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !isExcluded(entry.name)) {
          scan(join(dir, entry.name), depth + 1);
        }
      }
    } catch {
      // Permission denied or other error - skip this directory
    }
  }

  scan(resolve(baseDir), 0);
  return found;
}

// ────────────────────────────────────────────────────────────────
// Record Reading
// ────────────────────────────────────────────────────────────────

export interface ReadOptions {
  /** Add source repo name to each record */
  addSourceRepo?: boolean;
}

/**
 * Read eval records from a single repository's evals.jsonl file.
 *
 * Skips malformed JSONL lines silently. Adds sourceRepo field if requested.
 *
 * @param repoDir - Directory path of the repository
 * @param options - Configuration options
 * @returns Array of eval records from this repo
 */
export function readEvalsFromRepo(repoDir: string, options: ReadOptions = {}): EvalRecord[] {
  const evalsFile = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  if (!existsSync(evalsFile)) return [];

  const repoName = basename(repoDir);

  try {
    const records = readJsonlFile<EvalRecord>(evalsFile);

    if (options.addSourceRepo) {
      for (const record of records) {
        (record as EvalRecord & { sourceRepo?: string }).sourceRepo = repoName;
      }
    }

    return records;
  } catch {
    // File read error - return empty array
    return [];
  }
}

/**
 * Read eval records from multiple repositories.
 *
 * @param repoPaths - Array of directory paths
 * @param options - Configuration options
 * @returns Object with records and per-repo statistics
 */
export function readEvalsFromRepos(
  repoPaths: string[],
  options: ReadOptions = {},
): { records: EvalRecord[]; repoStats: Record<string, number> } {
  const allRecords: EvalRecord[] = [];
  const repoStats: Record<string, number> = {};

  for (const repoPath of repoPaths) {
    const records = readEvalsFromRepo(repoPath, options);
    allRecords.push(...records);
    const repoName = basename(resolve(repoPath));
    repoStats[repoName] = records.length;
  }

  return { records: allRecords, repoStats };
}

// ────────────────────────────────────────────────────────────────
// Hash-Based Deduplication
// ────────────────────────────────────────────────────────────────

export interface DeduplicationResult {
  /** Total records before deduplication */
  totalRecords: number;
  /** Unique records after deduplication */
  uniqueRecords: number;
  /** Count of duplicates removed */
  duplicatesRemoved: number;
  /** Deduplicated records */
  deduplicatedRecords: EvalRecord[];
  /** Map of hash -> records that were duplicated (kept only for reporting) */
  duplicateGroups: Map<string, EvalRecord[]>;
}

/**
 * Compute MD5 hash of key record fields for deduplication.
 *
 * Uses issueId, prUrl, score, timestamp, and modelId to create a stable hash.
 * This identifies duplicate evaluations of the same task across repos.
 *
 * @param record - The eval record
 * @returns MD5 hex string
 */
export function hashEvalRecord(record: EvalRecord): string {
  const key = JSON.stringify({
    issueId: record.issueId || 'no-issue',
    prUrl: record.prUrl || 'no-pr',
    score: record.score,
    timestamp: record.timestamp,
    modelId: record.modelId,
  });

  return createHash('md5').update(key).digest('hex');
}

/**
 * Deduplicate eval records using MD5 hash of key fields.
 *
 * When duplicates exist, keeps the earliest by timestamp.
 * Returns both deduplicated records and the duplicate groups for reporting.
 *
 * @param records - Array of eval records
 * @returns Deduplication result with statistics
 *
 * @example
 * const result = deduplicateByHash(records);
 * console.log(`Removed ${result.duplicatesRemoved} duplicates`);
 * console.log(`Kept ${result.uniqueRecords} unique records`);
 */
export function deduplicateByHash(records: EvalRecord[]): DeduplicationResult {
  const hashGroups = new Map<string, EvalRecord[]>();

  // Group by hash
  for (const record of records) {
    const hash = hashEvalRecord(record);
    if (!hashGroups.has(hash)) {
      hashGroups.set(hash, []);
    }
    hashGroups.get(hash)!.push(record);
  }

  // Keep earliest from each group
  const duplicateGroups = new Map<string, EvalRecord[]>();
  const deduplicatedRecords: EvalRecord[] = [];

  for (const [hash, group] of hashGroups) {
    const sorted = [...group].sort((a, b) =>
      String(a.timestamp || '').localeCompare(String(b.timestamp || '')),
    );

    if (sorted.length > 1) {
      duplicateGroups.set(hash, sorted);
    }

    deduplicatedRecords.push(sorted[0]);
  }

  return {
    totalRecords: records.length,
    uniqueRecords: deduplicatedRecords.length,
    duplicatesRemoved: records.length - deduplicatedRecords.length,
    deduplicatedRecords,
    duplicateGroups,
  };
}

// ────────────────────────────────────────────────────────────────
// Aggregation
// ────────────────────────────────────────────────────────────────

export interface AggregationOptions {
  /** Directories to aggregate from */
  repoPaths: string[];
  /** Auto-discover wavemill directories from this base path */
  discoverFrom?: string;
  /** Output file path */
  outputPath: string;
  /** Apply hash-based deduplication */
  deduplicateByHash?: boolean;
  /** Add source repo name to each record */
  addSourceRepo?: boolean;
}

export interface AggregationResult {
  /** Total records aggregated (before dedup) */
  totalRecords: number;
  /** Unique records after dedup (if enabled) */
  uniqueRecords: number;
  /** Duplicates removed (if dedup enabled) */
  duplicatesRemoved: number;
  /** Per-repo record counts (before dedup) */
  repoStats: Record<string, number>;
  /** Paths that were aggregated */
  aggregatedPaths: string[];
  /** Cost statistics (if available) */
  costStats?: CostStatistics;
  /** Duplicate groups (if dedup enabled) */
  duplicateGroups?: Map<string, EvalRecord[]>;
}

export interface CostStatistics {
  recordsWithCost: number;
  recordsWithoutCost: number;
  totalCost: number;
  averageCost: number;
  medianCost: number;
  minCost: number;
  maxCost: number;
  costPercentage: number;
  workflowCostStatusDistribution: Record<string, number>;
}

/**
 * Main aggregation orchestration.
 *
 * Discovers repos (if requested), reads records, deduplicates (if enabled),
 * sorts by timestamp, writes to output, and returns statistics.
 *
 * @param options - Aggregation configuration
 * @returns Aggregation result with statistics
 */
export function aggregateEvals(options: AggregationOptions): AggregationResult {
  const dedup = options.deduplicateByHash ?? true;
  const addSourceRepo = options.addSourceRepo ?? true;

  // Determine which repos to process
  let repoPaths = [...(options.repoPaths || [])];
  if (options.discoverFrom) {
    const discovered = discoverWavemillDirs(options.discoverFrom);
    repoPaths = Array.from(new Set([...repoPaths, ...discovered]));
  }

  if (repoPaths.length === 0) {
    throw new Error('No repositories to aggregate (provide --repos or --discover)');
  }

  // Read records from all repos
  const { records, repoStats } = readEvalsFromRepos(repoPaths, { addSourceRepo });

  // Deduplicate if requested
  let uniqueRecords = records;
  let duplicateGroups: Map<string, EvalRecord[]> | undefined;
  let duplicatesRemoved = 0;

  if (dedup && records.length > 0) {
    const dedupResult = deduplicateByHash(records);
    uniqueRecords = dedupResult.deduplicatedRecords;
    duplicateGroups = dedupResult.duplicateGroups;
    duplicatesRemoved = dedupResult.duplicatesRemoved;
  }

  // Sort by timestamp for reproducibility
  uniqueRecords.sort((a, b) => {
    const ta = String(a.timestamp || '');
    const tb = String(b.timestamp || '');
    return ta.localeCompare(tb);
  });

  // Compute cost statistics
  const costStats = computeCostStatistics(uniqueRecords);

  // Write output
  mkdirSync(dirname(options.outputPath), { recursive: true });
  const content = uniqueRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(options.outputPath, content, 'utf-8');

  return {
    totalRecords: records.length,
    uniqueRecords: uniqueRecords.length,
    duplicatesRemoved,
    repoStats,
    aggregatedPaths: repoPaths,
    costStats,
    duplicateGroups,
  };
}

// ────────────────────────────────────────────────────────────────
// Reporting
// ────────────────────────────────────────────────────────────────

/**
 * Compute cost statistics from eval records.
 *
 * @param records - Array of eval records
 * @returns Cost statistics object
 */
export function computeCostStatistics(records: EvalRecord[]): CostStatistics {
  let recordsWithCost = 0;
  let totalCost = 0;
  const costs: number[] = [];
  const statusCounts: Record<string, number> = {};

  for (const record of records) {
    const cost = record.workflowCost;
    if (cost !== undefined && cost !== null) {
      recordsWithCost++;
      totalCost += cost;
      costs.push(cost);
    }

    const status = (record as any).workflowCostStatus ?? 'unknown';
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  costs.sort((a, b) => a - b);

  return {
    recordsWithCost,
    recordsWithoutCost: records.length - recordsWithCost,
    totalCost,
    averageCost: recordsWithCost > 0 ? totalCost / recordsWithCost : 0,
    medianCost: costs.length > 0 ? costs[Math.floor(costs.length / 2)] : 0,
    minCost: costs.length > 0 ? costs[0] : 0,
    maxCost: costs.length > 0 ? costs[costs.length - 1] : 0,
    costPercentage: records.length > 0 ? (recordsWithCost / records.length) * 100 : 0,
    workflowCostStatusDistribution: statusCounts,
  };
}

/**
 * Format aggregation result into human-readable report.
 *
 * @param result - Aggregation result
 * @returns Multi-line report string
 */
export function formatAggregationReport(result: AggregationResult): string {
  const lines: string[] = [];

  lines.push('=== Aggregation Summary ===');
  lines.push(`Aggregated repositories: ${result.aggregatedPaths.length}`);
  lines.push(`Total records: ${result.totalRecords}`);

  if (result.duplicatesRemoved > 0) {
    lines.push(`Duplicates removed: ${result.duplicatesRemoved}`);
    lines.push(`Unique records: ${result.uniqueRecords}`);
  }

  lines.push('\n=== Records per Repository ===');
  for (const [repo, count] of Object.entries(result.repoStats).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${repo}: ${count}`);
  }

  if (result.duplicateGroups && result.duplicateGroups.size > 0) {
    lines.push('\n=== Duplicates Found ===');
    for (const [, records] of result.duplicateGroups) {
      const first = records[0];
      const issueId = (first as any).issueId || '(no issue)';
      const prUrl = (first as any).prUrl || '(no PR)';
      lines.push(`  ${issueId} + ${prUrl}: ${records.length} records → kept earliest`);
    }
  }

  if (result.costStats) {
    lines.push('\n=== Cost Statistics ===');
    lines.push(`Records with cost: ${result.costStats.recordsWithCost} (${result.costStats.costPercentage.toFixed(1)}%)`);
    lines.push(`Records without cost: ${result.costStats.recordsWithoutCost}`);
    if (result.costStats.recordsWithCost > 0) {
      lines.push(`\nCost Summary:`);
      lines.push(`  Total: $${result.costStats.totalCost.toFixed(2)}`);
      lines.push(`  Average: $${result.costStats.averageCost.toFixed(2)}`);
      lines.push(`  Median: $${result.costStats.medianCost.toFixed(2)}`);
      lines.push(`  Range: $${result.costStats.minCost.toFixed(2)} - $${result.costStats.maxCost.toFixed(2)}`);
    }

    if (Object.keys(result.costStats.workflowCostStatusDistribution).length > 0) {
      lines.push('\nWorkflow Cost Status Distribution:');
      const entries = Object.entries(result.costStats.workflowCostStatusDistribution).sort(
        (a, b) => b[1] - a[1],
      );
      for (const [status, count] of entries) {
        const pct = ((count / result.uniqueRecords) * 100).toFixed(1);
        lines.push(`  ${status.padEnd(15)} ${count} (${pct}%)`);
      }
    }
  }

  return lines.join('\n');
}
