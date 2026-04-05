#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolve } from 'node:path';
import { getEvalConfig } from '../shared/lib/config.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';
import {
  discoverWavemillDirs,
  aggregateEvals,
  formatAggregationReport,
} from '../shared/lib/eval-aggregator.ts';

// ── Config Loading ───────────────────────────────────────────────────────────

interface AggregationConfig {
  repos: string[];
  outputPath: string;
}

function loadAggregationConfig(): AggregationConfig {
  const defaults: AggregationConfig = {
    repos: [],
    outputPath: '.wavemill/evals/aggregated-evals.jsonl',
  };

  const evalConfig = getEvalConfig();
  const agg = evalConfig.aggregation;

  if (agg) {
    if (Array.isArray(agg.repos)) defaults.repos = agg.repos;
    if (agg.outputPath) defaults.outputPath = agg.outputPath;
  }

  return defaults;
}

runTool({
  name: 'aggregate-evals',
  description: 'Aggregate eval records from multiple repositories',
  options: {
    repos: { type: 'string', multiple: true, description: 'Repository directories to aggregate from' },
    discover: { type: 'string', description: 'Auto-discover wavemill dirs from this base path' },
    output: { type: 'string', short: 'o', description: 'Output path (default: .wavemill/evals/aggregated-evals.jsonl)' },
    'deduplicate-by-hash': {
      type: 'boolean',
      description: 'Enable hash-based deduplication (default: true)',
    },
  },
  examples: [
    'npx tsx tools/aggregate-evals.ts',
    'npx tsx tools/aggregate-evals.ts --repos ~/proj1 ~/proj2',
    'npx tsx tools/aggregate-evals.ts --discover ~/repos --output aggregated.jsonl',
    'npx tsx tools/aggregate-evals.ts --discover ~/repos --no-deduplicate-by-hash',
  ],
  additionalHelp: `Collects eval records from multiple repositories into a single
aggregated JSONL file for cross-repo analysis and DSPy training.

Modes:
  1. Config-driven (default):
     Reads eval.aggregation.repos from .wavemill-config.json

  2. Explicit repos:
     npx tsx tools/aggregate-evals.ts --repos ~/proj1 ~/proj2 ~/proj3

  3. Auto-discover:
     npx tsx tools/aggregate-evals.ts --discover /path/to/repos
     Recursively finds all .wavemill/evals directories

Deduplication:
  By default, removes duplicate records using MD5 hash of
  (issueId, prUrl, score, timestamp, modelId).
  Use --no-deduplicate-by-hash to keep all records.`,
  run({ args }) {
    const config = loadAggregationConfig();

    // Build repo list from multiple sources
    let repos = Array.isArray(args.repos) ? args.repos : (args.repos ? [args.repos] : config.repos);
    const deduplicateByHash =
      args['deduplicate-by-hash'] !== false; // Default true, can be disabled with --no-deduplicate-by-hash

    const currentRepo = resolve('.');
    const outputPath = resolve(args.output || config.outputPath);

    // Always include the current repo in aggregation
    const resolvedRepos = repos.map((r) => resolve(r));
    if (!resolvedRepos.includes(currentRepo)) {
      resolvedRepos.push(currentRepo);
    }

    try {
      const result = aggregateEvals({
        repoPaths: resolvedRepos,
        discoverFrom: args.discover ? resolve(args.discover) : undefined,
        outputPath,
        deduplicateByHash,
        addSourceRepo: true,
      });

      // Print report
      console.log(formatAggregationReport(result));
      console.log(`\nOutput: ${outputPath}`);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  },
});
