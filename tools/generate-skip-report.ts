import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { readJsonlFile } from '../shared/lib/jsonl-utils.ts';
import { buildNoComparisonReport, formatNoComparisonReportText, formatNoComparisonReportJson } from '../shared/lib/no-comparison-report.ts';
import type { StoredChallengeComparison } from '../shared/lib/challenge-comparison.ts';
import { readChallengeRecordVoids } from '../shared/lib/challenge-record-void.ts';

runTool({
  name: 'generate-skip-report',
  description: 'Generate no-comparison rate report from challenge records',
  options: {
    file: {
      description: 'Path to challenge-records.jsonl (default: repo/.wavemill/evals/challenge-records.jsonl)',
      type: 'string',
    },
    evals: {
      description: 'Path to evals.jsonl for unrecorded pair detection (default: sibling of records file)',
      type: 'string',
    },
    'no-evals': {
      description: 'Skip unrecorded pair detection',
      type: 'boolean',
    },
    since: {
      description: 'ISO date string (inclusive)',
      type: 'string',
    },
    until: {
      description: 'ISO date string (inclusive)',
      type: 'string',
    },
    windows: {
      description: 'Print fixed time windows (all-time, since 08-11, since 08-19, and --since value if provided)',
      type: 'boolean',
    },
    json: {
      description: 'Output JSON instead of text',
      type: 'boolean',
    },
  },
  async run({ args }) {
    const evalsDir = resolve(process.cwd(), '.wavemill', 'evals');
    const recordsFile = resolve((args.file as string) || join(evalsDir, 'challenge-records.jsonl'));
    const evalsFile = resolve((args.evals as string) || join(evalsDir, 'evals.jsonl'));

    if (!existsSync(recordsFile)) {
      console.log('{}');
      return;
    }

    // Read records, handling malformed lines
    let records: StoredChallengeComparison[] = [];
    try {
      records = readJsonlFile<StoredChallengeComparison>(recordsFile);
    } catch (error) {
      console.warn(`Warning: Error reading records: ${error instanceof Error ? error.message : String(error)}`);
      records = [];
    }

    // Read voids
    const voids = readChallengeRecordVoids(evalsDir);

    // Read evals if requested
    let evals: Array<{ challengePairId?: string }> | undefined;
    if (!args['no-evals'] && existsSync(evalsFile)) {
      try {
        evals = readJsonlFile<{ challengePairId?: string }>(evalsFile);
      } catch {
        // Ignore evals read errors
      }
    }

    // Parse dates
    const parsedSince = (args.since as string) ? new Date(args.since as string) : undefined;
    const parsedUntil = (args.until as string) ? new Date(args.until as string) : undefined;

    if ((args.since as string) && Number.isNaN(parsedSince?.getTime())) {
      console.error(`Invalid --since date: ${args.since}`);
      process.exit(1);
    }
    if ((args.until as string) && Number.isNaN(parsedUntil?.getTime())) {
      console.error(`Invalid --until date: ${args.until}`);
      process.exit(1);
    }

    // Generate reports
    if (args.windows) {
      const windows = [
        { name: 'all-time', since: undefined, until: undefined },
        { name: 'since 2026-08-11', since: new Date('2026-08-11'), until: undefined },
        { name: 'since 2026-08-19', since: new Date('2026-08-19'), until: undefined },
        ...(parsedSince ? [{ name: `since ${args.since}`, since: parsedSince, until: parsedUntil }] : []),
      ];

      for (const window of windows) {
        const report = buildNoComparisonReport({
          comparisons: records,
          voids,
          evals,
          since: window.since,
          until: window.until,
        });
        console.log(`\n## ${window.name}`);
        console.log(formatNoComparisonReportText(report));
      }
    } else {
      const report = buildNoComparisonReport({
        comparisons: records,
        voids,
        evals,
        since: parsedSince,
        until: parsedUntil,
      });
      if (args.json) {
        console.log(JSON.stringify(formatNoComparisonReportJson(report), null, 2));
      } else {
        console.log(formatNoComparisonReportText(report));
      }
    }
  },
});
