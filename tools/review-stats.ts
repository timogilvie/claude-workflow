#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolve } from 'node:path';
import { loadMetrics } from '../shared/lib/review-metrics.ts';
import {
  computeStats,
  filterMetrics,
  formatStats,
  type FilterOptions,
} from '../shared/lib/review-stats.ts';

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

runTool({
  name: 'review-stats',
  description: 'Show review metrics summary and statistics',
  options: {
    from: { type: 'string', description: 'Include reviews from this date (YYYY-MM-DD)' },
    to: { type: 'string', description: 'Include reviews up to this date (YYYY-MM-DD)' },
    outcome: { type: 'string', description: 'Filter by outcome (resolved, escalated, error)' },
    branch: { type: 'string', description: 'Filter by branch name (substring match)' },
    issue: { type: 'string', description: 'Filter by Linear issue ID' },
    limit: { type: 'string', description: 'Number of recent reviews to show (default: 5)' },
    json: { type: 'boolean', description: 'Output as JSON' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'repoDir',
    description: 'Repository directory (default: current directory)',
  },
  examples: [
    'npx tsx tools/review-stats.ts',
    'npx tsx tools/review-stats.ts --from 2026-01-01',
    'npx tsx tools/review-stats.ts --outcome resolved',
    'npx tsx tools/review-stats.ts --json',
  ],
  additionalHelp: `Displays aggregate statistics from review metrics log.

Filter Options:
  --from YYYY-MM-DD       Reviews from this date (inclusive)
  --to YYYY-MM-DD         Reviews up to this date (inclusive)
  --outcome TYPE          Filter by outcome (resolved/escalated/error)
  --branch PATTERN        Filter by branch name (substring)
  --issue ISSUE-ID        Filter by Linear issue ID`,
  run({ args, positional }) {
    const repoDir = positional[0] ? resolve(positional[0]) : process.cwd();
    const limit = args.limit ? parseInt(String(args.limit), 10) : 5;

    // Load all metrics
    const allMetrics = loadMetrics(repoDir);

    // Build filter options
    const filterOptions: FilterOptions = {};
    if (args.from) filterOptions.from = String(args.from);
    if (args.to) filterOptions.to = String(args.to);
    if (args.outcome) {
      const outcome = String(args.outcome);
      if (!['resolved', 'escalated', 'error'].includes(outcome)) {
        console.error(`Error: Invalid outcome '${outcome}'. Must be one of: resolved, escalated, error`);
        process.exit(1);
      }
      filterOptions.outcome = outcome as 'resolved' | 'escalated' | 'error';
    }
    if (args.branch) filterOptions.branch = String(args.branch);
    if (args.issue) filterOptions.issue = String(args.issue);

    // Filter metrics
    const metrics = filterMetrics(allMetrics, filterOptions);

    // Compute statistics
    const stats = computeStats(metrics, limit);

    // Output
    if (args.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      const output = formatStats(stats);
      console.log(output);
    }
  },
});
