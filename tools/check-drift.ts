#!/usr/bin/env -S npx tsx
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { detectSubsystems } from '../shared/lib/subsystem-detector.ts';
import { checkSubsystemDrift } from '../shared/lib/drift-detector.ts';

runTool({
  name: 'check-drift',
  description: 'Check subsystem specs for drift (stale documentation)',
  options: {},
  positional: {
    name: 'repoPath',
    description: 'Repository path (default: current directory)',
  },
  examples: [
    'npx tsx tools/check-drift.ts',
    'npx tsx tools/check-drift.ts /path/to/repo',
  ],
  async run({ positional }) {
    const repoDir = resolveRepoDir(positional[0]);
    const contextDir = join(repoDir, '.wavemill', 'context');

    if (!existsSync(contextDir)) {
      // No subsystem specs — nothing to check
      process.exit(0);
    }

    const subsystems = detectSubsystems(repoDir, {
      minFiles: 3,
      useGitAnalysis: false,
      maxSubsystems: 20,
    });

    if (subsystems.length === 0) {
      process.exit(0);
    }

    const stale: string[] = [];
    for (const subsystem of subsystems) {
      const status = checkSubsystemDrift(subsystem, repoDir);
      if (status.isStale) {
        stale.push(subsystem.id);
      }
    }

    if (stale.length > 0) {
      // Output stale subsystem IDs, one per line
      console.log(stale.join('\n'));
    }
  },
});
