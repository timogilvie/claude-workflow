#!/usr/bin/env -S npx tsx
/**
 * Build Task Contract
 *
 * Produces features/<slug>/task-contract.json from existing task packet
 * and plan artifacts. Exits 0 even when fields are missing; prints warnings
 * to stderr. Exits non-zero only for CLI-level misuse or an unreadable
 * feature directory.
 *
 * Usage:
 *   npx tsx tools/build-task-contract.ts <slug>
 *   npx tsx tools/build-task-contract.ts --feature-dir <path>
 *   npx tsx tools/build-task-contract.ts <slug> --output <path>
 *
 * @module build-task-contract
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { buildTaskContract, serializeTaskContract } from '../shared/lib/task-contract.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';

runTool({
  name: 'build-task-contract',
  description: 'Build features/<slug>/task-contract.json from task packet and plan artifacts',
  positional: {
    name: 'slug',
    description: 'Feature slug (used to resolve features/<slug>/ directory)',
    required: false,
  },
  options: {
    'feature-dir': {
      type: 'string',
      description: 'Direct path to the feature directory (alternative to slug)',
    },
    output: {
      type: 'string',
      description: 'Override the output file path (default: features/<slug>/task-contract.json)',
    },
  },
  examples: [
    'npx tsx tools/build-task-contract.ts my-feature-slug',
    'npx tsx tools/build-task-contract.ts --feature-dir /path/to/features/my-feature',
    'npx tsx tools/build-task-contract.ts my-slug --output /tmp/contract.json',
  ],
  run({ args, positional }) {
    const slug = positional[0];
    const featureDirArg = args['feature-dir'] as string | undefined;
    const outputArg = args['output'] as string | undefined;

    // Resolve feature directory
    let featureDir: string;
    if (featureDirArg) {
      featureDir = resolve(featureDirArg);
    } else if (slug) {
      featureDir = resolve(process.cwd(), 'features', slug);
    } else {
      console.error('Error: provide a slug or --feature-dir');
      process.exitCode = 1;
      return;
    }

    // Validate feature directory exists
    if (!existsSync(featureDir)) {
      console.error(`Error: feature directory not found: ${featureDir}`);
      process.exitCode = 1;
      return;
    }

    // Build the contract
    let result;
    try {
      result = buildTaskContract({ featureDir, slug });
    } catch (err) {
      // buildTaskContract should never throw, but guard defensively
      console.error(`Error: unexpected failure building contract: ${errorMessage(err)}`);
      process.exitCode = 1;
      return;
    }

    const { contract, warnings } = result;

    // Emit warnings to stderr
    for (const warning of warnings) {
      process.stderr.write(`warning: ${warning}\n`);
    }

    // Resolve output path
    const outputPath = outputArg
      ? resolve(outputArg)
      : join(featureDir, 'task-contract.json');

    // Write artifact
    try {
      mkdirSync(join(outputPath, '..'), { recursive: true });
      writeFileSync(outputPath, serializeTaskContract(contract), 'utf-8');
      console.log(`wrote ${outputPath}`);
    } catch (err) {
      console.error(`Error: failed to write ${outputPath}: ${errorMessage(err)}`);
      process.exitCode = 1;
      return;
    }
  },
});
