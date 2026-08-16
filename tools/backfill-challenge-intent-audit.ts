#!/usr/bin/env -S npx tsx

/**
 * Backfill Challenge Intent Audit — quarantine eval records with divergent
 * challenge execution evidence.
 *
 * Usage:
 *   npx tsx tools/backfill-challenge-intent-audit.ts --dry-run
 *   npx tsx tools/backfill-challenge-intent-audit.ts --file .wavemill/evals/evals.jsonl
 *   npx tsx tools/backfill-challenge-intent-audit.ts --repo-dir /path/to/repo
 */

import { resolve } from 'node:path';
import {
  runChallengeIntentAudit,
  resolveEvalsFilePath,
  type AuditSummary,
} from '../shared/lib/challenge-intent-audit.ts';

interface CliOptions {
  file?: string;
  repoDir?: string;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--file':
        options.file = args[++i];
        break;
      case '--repo-dir':
        options.repoDir = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Backfill Challenge Intent Audit — quarantine eval records with divergent challenge evidence.

Usage:
  npx tsx tools/backfill-challenge-intent-audit.ts [options]

Options:
  --file <path>      Path to evals JSONL file (default: .wavemill/evals/evals.jsonl)
  --repo-dir <path>  Repository directory for path resolution
  --dry-run          Print changes without writing
  --verbose          Print per-record change log
  --help, -h         Show this help message
`);
        process.exit(0);
        break;
    }
  }

  return options;
}

function printSummary(summary: AuditSummary, verbose: boolean): void {
  console.log('\n=== Challenge Intent Audit Summary ===\n');
  console.log(`  Scanned:                ${summary.scanned}`);
  console.log(`  Quarantined:            ${summary.quarantined}`);
  console.log(`  Already marked:         ${summary.alreadyMarked}`);
  console.log(`  Missing intent (fixed): ${summary.missingIntentQuarantined}`);
  console.log(`  Clean:                  ${summary.clean}`);
  console.log(`  Unparseable:            ${summary.unparseable}`);

  if (verbose) {
    console.log('\n=== Per-Record Changes ===\n');
    for (const result of summary.results) {
      if (result.action === 'quarantined' || result.action === 'missing_intent_quarantined') {
        console.log(`  ${result.recordId}: ${result.action}`);
        if (result.reason) {
          console.log(`    Reason: ${result.reason}`);
        }
        if (result.details) {
          console.log(`    Details: ${result.details}`);
        }
      } else if (result.action === 'unparseable') {
        console.log(`  [unparseable line]`);
      }
    }
  }

  const totalChanged = summary.quarantined + summary.missingIntentQuarantined;
  if (totalChanged > 0) {
    console.log(`\n${totalChanged} record(s) would be quarantined.`);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const filePath = options.file ?? resolveEvalsFilePath(options.repoDir);
  const absolutePath = resolve(filePath);

  console.log(`Auditing: ${absolutePath}`);
  if (options.dryRun) {
    console.log('(dry-run mode: no changes will be written)');
  }

  const summary = runChallengeIntentAudit({
    filePath: absolutePath,
    repoDir: options.repoDir,
    dryRun: options.dryRun,
  });

  printSummary(summary, options.verbose);

  // Exit with non-zero if there were issues found
  const totalIssues = summary.quarantined + summary.missingIntentQuarantined + summary.unparseable;
  if (totalIssues > 0) {
    process.exit(0); // Still success, but report the issues
  }
}

main();
