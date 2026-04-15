#!/usr/bin/env -S npx tsx

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import {
  extractKeyFiles,
  extractSubsystemName,
  listContextSpecPaths,
} from '../shared/lib/context-tool.ts';
import { checkSubsystemDrift } from '../shared/lib/drift-detector.ts';
import type { Subsystem } from '../shared/lib/subsystem-detector.ts';

function loadContextSubsystems(repoDir: string): Subsystem[] {
  let specPaths: string[] = [];

  try {
    specPaths = listContextSpecPaths(repoDir);
  } catch {
    return [];
  }

  return specPaths.map((specPath) => {
    const content = requireContent(specPath);
    const id = path.basename(specPath, '.md');

    return {
      id,
      name: extractSubsystemName(content),
      description: '',
      keyFiles: extractKeyFiles(content),
      testPatterns: [],
      dependencies: [],
      confidence: 1,
      detectionMethod: 'directory',
    } satisfies Subsystem;
  });
}

function requireContent(specPath: string): string {
  return readFileSync(specPath, 'utf-8');
}

runTool({
  name: 'check-drift',
  description: 'Check subsystem spec drift and print stale subsystem ids',
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
    const subsystems = loadContextSubsystems(repoDir);

    // Debug logging for CI investigation
    const debugMode = process.env.DEBUG_DRIFT === '1';
    if (debugMode) {
      console.error(`DEBUG: Loaded ${subsystems.length} subsystems from ${repoDir}`);
      for (const sub of subsystems) {
        console.error(`DEBUG: Subsystem ${sub.id}: ${sub.keyFiles.length} key files:`, sub.keyFiles);
      }
    }

    if (subsystems.length === 0) {
      if (debugMode) console.error('DEBUG: No subsystems found, exiting 1');
      process.exitCode = 1;
      return;
    }

    const staleSubsystemIds = subsystems
      .filter((subsystem) => {
        const drift = checkSubsystemDrift(subsystem, repoDir);
        if (debugMode) {
          console.error(`DEBUG: ${subsystem.id} drift check:`, {
            isStale: drift.isStale,
            daysSinceUpdate: drift.daysSinceUpdate,
            specLastModified: drift.specLastModified,
            filesLastModified: drift.filesLastModified,
          });
        }
        return drift.isStale;
      })
      .map((subsystem) => subsystem.id);

    if (debugMode) console.error(`DEBUG: Found ${staleSubsystemIds.length} stale subsystems:`, staleSubsystemIds);

    if (staleSubsystemIds.length === 0) {
      if (debugMode) console.error('DEBUG: No stale subsystems, exiting 1');
      process.exitCode = 1;
      return;
    }

    console.log(staleSubsystemIds.join(','));
  },
});
