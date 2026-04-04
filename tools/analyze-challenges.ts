#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { readChallengeComparisons } from '../shared/lib/challenge-comparison.ts';
import { readEvalRecords } from '../shared/lib/eval-persistence.ts';
import { joinRecords, computeAggregations, formatChallengeStats } from '../shared/lib/challenge-aggregator.ts';

runTool({
  name: 'analyze-challenges',
  description: 'Analyze challenge comparison results and display aggregated statistics.',
  options: {
    json: { type: 'boolean', description: 'Output JSON instead of formatted text' },
    from: { type: 'string', description: 'Filter records from this date (ISO 8601)' },
    to: { type: 'string', description: 'Filter records to this date (ISO 8601)' },
    type: { type: 'string', description: 'Filter by challenge type' },
    model: { type: 'string', description: 'Filter by specific model' },
  },
  async run({ args, positional }) {
    const repoDir = positional[0] || process.cwd();
    const comparisons = readChallengeComparisons(repoDir);

    if (comparisons.length === 0) {
      console.log('No challenge records found.');
      return;
    }

    // Apply filters
    let filtered = comparisons;

    if (args.from) {
      const fromDate = new Date(args.from as string);
      if (isNaN(fromDate.getTime())) {
        throw new Error(`Invalid date format for --from: ${args.from}`);
      }
      filtered = filtered.filter((c) => new Date(c.timestamp) >= fromDate);
    }

    if (args.to) {
      const toDate = new Date(args.to as string);
      if (isNaN(toDate.getTime())) {
        throw new Error(`Invalid date format for --to: ${args.to}`);
      }
      filtered = filtered.filter((c) => new Date(c.timestamp) <= toDate);
    }

    if (args.type) {
      const targetType = args.type as string;
      filtered = filtered.filter((c) => c.challengeType === targetType);
    }

    if (args.model) {
      const targetModel = args.model as string;
      filtered = filtered.filter(
        (c) => c.primaryModel === targetModel || c.challengerModel === targetModel
      );
    }

    // Join with eval records
    const evals = readEvalRecords(repoDir);
    const joined = joinRecords(filtered, evals);

    // Compute aggregations
    const stats = computeAggregations(joined);

    // Output
    if (args.json) {
      console.log(JSON.stringify({ stats, records: joined }, null, 2));
    } else {
      console.log(formatChallengeStats(stats));
    }
  },
});
