#!/usr/bin/env -S npx tsx

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { migrateEvalCorpus } from '../shared/lib/eval-corpus-migrator.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'migrate-eval-corpus',
  description: 'Normalize reviewer aliases and quarantine invalid eval corpus records',
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Validate and report changes without writing files',
    },
    'evals-dir': {
      type: 'string',
      description: 'Directory containing evals.jsonl',
    },
    'quarantine-file': {
      type: 'string',
      description: 'Quarantine JSONL filename within the evals directory',
      default: 'quarantine.jsonl',
    },
    'no-backup': {
      type: 'boolean',
      description: 'Allow live writes without requiring evals.jsonl.bak',
    },
  },
  examples: [
    'npx tsx tools/migrate-eval-corpus.ts --dry-run',
    'npx tsx tools/migrate-eval-corpus.ts --evals-dir .wavemill/evals',
    'npx tsx tools/migrate-eval-corpus.ts --evals-dir /path/to/evals --quarantine-file quarantined.jsonl',
  ],
  run({ args }) {
    const repoDir = resolve('.');
    const evalsDir = args['evals-dir']
      ? resolve(String(args['evals-dir']))
      : resolveEvalsDir(undefined, repoDir).dir;
    const evalsFile = join(evalsDir, 'evals.jsonl');
    const quarantineFile = join(evalsDir, String(args['quarantine-file'] || 'quarantine.jsonl'));
    const dryRun = args['dry-run'] === true;
    const noBackup = args['no-backup'] === true;
    const backupFile = `${evalsFile}.bak`;

    if (!existsSync(evalsFile)) {
      throw new Error(`Eval corpus not found: ${evalsFile}`);
    }

    if (!dryRun && !noBackup && !existsSync(backupFile)) {
      throw new Error(`Refusing live migration without backup file: ${backupFile}`);
    }

    const summary = migrateEvalCorpus({
      evalsFile,
      quarantineFile,
      repoDir,
      dryRun,
    });

    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log(`Eval file: ${evalsFile}`);
    console.log(`Quarantine file: ${quarantineFile}`);
    console.log(`Input records: ${summary.inputRecordCount}`);
    console.log(`Unchanged: ${summary.unchanged}`);
    console.log(`Fixed in place: ${summary.fixedInPlace}`);
    console.log(`Quarantined: ${summary.quarantined}`);
    console.log(`Conservation total: ${summary.conservationTotal}`);

    console.log('Fixed by reason:');
    if (Object.keys(summary.fixedByReason).length === 0) {
      console.log('  none');
    } else {
      for (const [reason, count] of Object.entries(summary.fixedByReason).sort()) {
        console.log(`  ${reason}: ${count}`);
      }
    }

    console.log('Quarantined by code:');
    if (Object.keys(summary.quarantinedByCode).length === 0) {
      console.log('  none');
    } else {
      for (const [code, count] of Object.entries(summary.quarantinedByCode).sort()) {
        console.log(`  ${code}: ${count}`);
      }
    }
  },
});
