#!/usr/bin/env -S npx tsx

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readTransformWrite } from '../shared/lib/jsonl-utils.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import { backfillTaskDescriptorRecord } from '../shared/lib/task-descriptor-backfill.ts';

interface BackfillStats {
  total: number;
  changed: number;
  skipped: number;
  alreadyHadDescriptor: number;
  missingOriginalPrompt: number;
  limitSkipped: number;
  malformed: number;
}

function defaultInputPath(repoDir: string): string {
  return join(resolveEvalsDir(undefined, repoDir).dir, 'aggregated-evals.jsonl');
}

runTool({
  name: 'backfill-task-descriptors',
  description: 'Backfill taskDescriptor onto existing eval records',
  options: {
    file: { type: 'string', description: 'Path to JSONL file (default: configured aggregated eval store)' },
    'dry-run': { type: 'boolean', description: 'Show what would change without writing' },
    limit: { type: 'string', description: 'Maximum number of records to update' },
  },
  examples: [
    'npx tsx tools/backfill-task-descriptors.ts --dry-run',
    'npx tsx tools/backfill-task-descriptors.ts --limit 25',
    'npx tsx tools/backfill-task-descriptors.ts --file /path/to/aggregated-evals.jsonl',
  ],
  run({ args }) {
    const repoDir = resolve('.');
    const filePath = args.file ? resolve(args.file) : defaultInputPath(repoDir);
    const dryRun = !!args['dry-run'];
    const limit = args.limit ? Number(args.limit) : null;

    if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
      throw new Error(`--limit must be a positive number, got: ${args.limit}`);
    }

    if (!existsSync(filePath)) {
      throw new Error(`Eval file not found: ${filePath}`);
    }

    const stats: BackfillStats = {
      total: 0,
      changed: 0,
      skipped: 0,
      alreadyHadDescriptor: 0,
      missingOriginalPrompt: 0,
      limitSkipped: 0,
      malformed: 0,
    };

    const summary = readTransformWrite<EvalRecord>(
      filePath,
      (record) => {
        stats.total++;

        if (limit !== null && stats.changed >= limit) {
          stats.skipped++;
          stats.limitSkipped++;
          return { record, changed: false };
        }

        const result = backfillTaskDescriptorRecord(record);
        if (result.changed) {
          stats.changed++;
          return result;
        }

        stats.skipped++;
        if (result.skipReason === 'already_has_descriptor') {
          stats.alreadyHadDescriptor++;
        } else if (result.skipReason === 'missing_original_prompt') {
          stats.missingOriginalPrompt++;
        }

        return result;
      },
      { dryRun },
    );

    stats.malformed = summary.malformedLines;

    console.log(`File: ${filePath}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log(`Total records: ${summary.recordsProcessed}`);
    console.log(`Changed: ${stats.changed}`);
    console.log(`Skipped: ${stats.skipped}`);
    console.log(`Already had taskDescriptor: ${stats.alreadyHadDescriptor}`);
    console.log(`Missing originalPrompt: ${stats.missingOriginalPrompt}`);
    console.log(`Skipped by limit: ${stats.limitSkipped}`);
    console.log(`Malformed lines: ${stats.malformed}`);
    console.log(
      dryRun
        ? 'No changes written.'
        : summary.fileModified
          ? `Updated file in place. Backup written to ${filePath}.backup`
          : 'No file changes were necessary.',
    );
  },
});
