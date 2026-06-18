#!/usr/bin/env -S npx tsx
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { buildTaskContract, writeTaskContract } from '../shared/lib/task-contract-builder.ts';

runTool({
  name: 'build-task-contract',
  description: 'Build a task-contract.json projection from existing task packet / plan artifacts',
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository root directory (default: current directory)',
    },
  },
  positional: {
    name: 'feature-dir',
    description: 'Feature directory path or slug (resolved as features/<slug> under repo)',
    required: true,
  },
  examples: [
    'npx tsx tools/build-task-contract.ts features/my-feature',
    'npx tsx tools/build-task-contract.ts my-feature',
    'npx tsx tools/build-task-contract.ts --repo-dir /path/to/repo my-feature',
  ],
  async run({ args, positional }) {
    const arg = positional[0];
    if (!arg) {
      throw new Error('feature-dir is required. Run with --help for usage information.');
    }

    const repoDir = resolve(args['repo-dir'] ?? process.cwd());
    let featureDir: string;

    // If arg is an existing path, use it directly
    if (existsSync(arg)) {
      featureDir = resolve(arg);
    } else {
      // Otherwise try features/<slug> under repo
      const candidate = join(repoDir, 'features', arg);
      if (existsSync(candidate)) {
        featureDir = candidate;
      } else {
        throw new Error(`Feature directory not found: ${arg} (tried ${resolve(arg)} and ${candidate})`);
      }
    }

    const contract = await buildTaskContract(featureDir, { repoDir });
    const outPath = await writeTaskContract(featureDir, contract, { repoDir });

    const relPath = outPath.startsWith(repoDir)
      ? outPath.slice(repoDir.length + 1)
      : outPath;

    console.log(`Written: ${relPath}`);
    console.log(`Missing fields: ${contract.missingFields.length}`);
    if (contract.missingFields.length > 0) {
      console.log(`  ${contract.missingFields.join(', ')}`);
    }
    if (contract.extractionWarnings.length > 0) {
      for (const warning of contract.extractionWarnings) {
        console.warn(`Warning: ${warning}`);
      }
    }
  },
});
