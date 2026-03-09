#!/usr/bin/env -S npx tsx

/**
 * Deduplicate eval records by keeping only the earliest eval for each issue+PR combination.
 *
 * Usage:
 *   npx tsx tools/deduplicate-evals.ts [--dry-run] [--evals-file <path>]
 *
 * Creates a timestamped backup before modifying the file.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getEvalConfig } from '../shared/lib/config.ts';
import { readEvalRecordsFromFile } from '../shared/lib/eval-persistence.ts';
import {
  createEvalBackup,
  deduplicateEvalRecords,
  formatDuplicateReport,
  writeEvalRecordsFile,
} from '../shared/lib/eval-deduplication.ts';

// ── CLI Tool ─────────────────────────────────────────────────────────────────

runTool({
  name: 'deduplicate-evals',
  description: 'Remove duplicate eval records, keeping only the earliest eval for each issue+PR',
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Preview what would be removed without making changes',
    },
    'evals-file': {
      type: 'string',
      description: 'Path to evals.jsonl file (default: .wavemill/evals/evals.jsonl)',
    },
    help: {
      type: 'boolean',
      short: 'h',
      description: 'Show help message',
    },
  },
  examples: [
    'npx tsx tools/deduplicate-evals.ts --dry-run',
    'npx tsx tools/deduplicate-evals.ts',
    'npx tsx tools/deduplicate-evals.ts --evals-file /path/to/evals.jsonl',
  ],
  async run({ args }) {
    const dryRun = args['dry-run'] || false;

    // Determine evals file path
    let evalsFile: string;
    if (args['evals-file']) {
      evalsFile = resolve(args['evals-file'] as string);
    } else {
      const repoDir = process.cwd();
      const evalConfig = getEvalConfig(repoDir);
      const evalsDir = evalConfig.evalsDir
        ? resolve(repoDir, evalConfig.evalsDir)
        : join(repoDir, '.wavemill', 'evals');
      evalsFile = join(evalsDir, 'evals.jsonl');
    }

    console.log(`Deduplicating eval records from ${evalsFile}`);
    console.log('');

    if (!existsSync(evalsFile)) {
      console.error(`Error: Eval file not found at ${evalsFile}`);
      process.exit(1);
    }

    // Read all records
    const records = readEvalRecordsFromFile(evalsFile);
    console.log(`Found ${records.length} total eval records`);

    // Analyze duplicates
    console.log('Analyzing duplicates...');
    const result = deduplicateEvalRecords(records);

    // Report findings
    if (result.duplicateGroups.size === 0) {
      console.log('');
      console.log('✓ No duplicates found - file is already deduplicated');
      process.exit(0);
    }

    console.log(formatDuplicateReport(result));
    console.log('');
    console.log(`Removed ${result.duplicatesRemoved} duplicate records`);
    console.log(`Kept ${result.uniqueRecords} unique records`);

    if (dryRun) {
      console.log('');
      console.log('Dry run mode - no changes made');
      console.log('Run without --dry-run to apply changes');
      process.exit(0);
    }

    // Create backup
    const backupPath = createEvalBackup(evalsFile);
    console.log('');
    console.log(`Creating backup: ${backupPath}`);

    // Write deduplicated records
    writeEvalRecordsFile(evalsFile, result.deduplicatedRecords);
    console.log(`Wrote deduplicated records to ${evalsFile}`);
    console.log('');
    console.log('✓ Deduplication complete');
  },
});
