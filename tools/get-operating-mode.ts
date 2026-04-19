#!/usr/bin/env node

import {
  getCurrentOperatingMode,
  getOperatingModeResult,
  getModelOperatingMode,
  hasAnyHealthyModel,
} from '../shared/lib/operating-mode.ts';

type Command = 'global' | 'model' | 'any-healthy';

function parseArgs(argv: string[]): { command: Command; modelId?: string; repoDir?: string; verbose: boolean } {
  const [commandArg, ...rest] = argv;

  if (commandArg !== 'global' && commandArg !== 'model' && commandArg !== 'any-healthy') {
    throw new Error('invalid command');
  }

  let modelId: string | undefined;
  let repoDir: string | undefined;
  let verbose = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
      continue;
    }

    if (arg === '--repo-dir') {
      repoDir = rest[index + 1];
      index += 1;
      continue;
    }

    if (commandArg === 'model' && !modelId) {
      modelId = arg;
      continue;
    }

    throw new Error('invalid arguments');
  }

  if (commandArg === 'model' && !modelId) {
    throw new Error('model id required');
  }

  return { command: commandArg, modelId, repoDir, verbose };
}

function formatVendorBreakdown(vendorBreakdown: Record<string, {
  healthy: number;
  degraded: number;
  exhausted: number;
  total: number;
}>): string[] {
  const vendors = Object.keys(vendorBreakdown).sort((left, right) => left.localeCompare(right));
  if (vendors.length === 0) {
    return ['Vendor breakdown:', '  none'];
  }

  const width = Math.max(...vendors.map((vendor) => vendor.length));
  return [
    'Vendor breakdown:',
    ...vendors.map((vendor) => {
      const stats = vendorBreakdown[vendor];
      const details: string[] = [];
      if (stats.degraded > 0) {
        details.push(`${stats.degraded} degraded`);
      }
      if (stats.exhausted > 0) {
        details.push(`${stats.exhausted} exhausted`);
      }

      const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
      return `  ${vendor.padEnd(width)}: ${stats.healthy}/${stats.total} healthy${suffix}`;
    }),
  ];
}

function main(): number {
  try {
    const { command, modelId, repoDir, verbose } = parseArgs(process.argv.slice(2));

    switch (command) {
      case 'global':
        if (!verbose) {
          console.log(getCurrentOperatingMode(repoDir));
          return 0;
        }

        {
          const result = getOperatingModeResult(repoDir);
          console.log(result.mode);
          for (const line of formatVendorBreakdown(result.vendorBreakdown)) {
            console.log(line);
          }
        }
        return 0;
      case 'model':
        console.log(getModelOperatingMode(modelId!, repoDir));
        return 0;
      case 'any-healthy':
        return hasAnyHealthyModel(repoDir) ? 0 : 1;
    }
  } catch {
    if (process.argv[2] === 'any-healthy') {
      return 0;
    }

    console.log('normal');
    return 0;
  }
}

process.exit(main());
