#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { compareParentMonitor, formatDriftReport } from '../shared/lib/parent-monitor-drift.ts';

interface CliOptions {
  file: string;
  json: boolean;
}

function usage(): string {
  return [
    'Usage: npx tsx tools/check-parent-monitor-drift.ts [--file PATH] [--json]',
    '',
    'Analyzes duplicated shell functions in shared/lib/wavemill-mill.sh parent and MONITOR_EOF regions.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    file: resolve(process.cwd(), 'shared/lib/wavemill-mill.sh'),
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--file requires a path');
      options.file = resolve(process.cwd(), value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = compareParentMonitor(readFileSync(options.file, 'utf8'));

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDriftReport(report));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`check-parent-monitor-drift: ${message}`);
    process.exit(2);
  }
}

main();
