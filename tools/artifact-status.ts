#!/usr/bin/env -S npx tsx
/**
 * Artifact Status
 *
 * Prints a compact one-line status for normalized task artifacts
 * (task-contract.json, feature-state.json, trace.jsonl) in a feature directory.
 *
 * Designed for dashboard integration: always exits 0, suppresses internal errors,
 * and prints an empty line when artifacts are absent (legacy tasks).
 *
 * Usage:
 *   npx tsx tools/artifact-status.ts [path]
 *   npx tsx tools/artifact-status.ts --feature-dir <path>
 *   npx tsx tools/artifact-status.ts --feature-dir <path> --json
 *   npx tsx tools/artifact-status.ts --feature-dir <path> --max-width 40
 *
 * @module artifact-status
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { summarizeArtifactStatus, formatArtifactStatus } from '../shared/lib/artifact-status.ts';

runTool({
  name: 'artifact-status',
  description: 'Print compact artifact status for a feature directory (dashboard integration)',
  positional: {
    name: 'path',
    description: 'Feature directory or worktree root (optional; overridden by --feature-dir)',
    required: false,
  },
  options: {
    'feature-dir': {
      type: 'string',
      description: 'Explicit path to the feature directory',
    },
    repo: {
      type: 'string',
      description: 'Repository/worktree root for diagnostics (default: feature-dir or cwd)',
    },
    issue: {
      type: 'string',
      description: 'Task issue ID (e.g. HOK-1234) for diagnostics',
    },
    slug: {
      type: 'string',
      description: 'Feature slug for diagnostics',
    },
    json: {
      type: 'boolean',
      description: 'Print the summary as JSON instead of the compact line',
    },
    'max-width': {
      type: 'string',
      description: 'Maximum character width for the compact line (default: 44)',
    },
  },
  examples: [
    'npx tsx tools/artifact-status.ts --feature-dir features/my-feature',
    'npx tsx tools/artifact-status.ts /path/to/worktree --slug my-feature',
    'npx tsx tools/artifact-status.ts --feature-dir features/my-feature --json',
    'npx tsx tools/artifact-status.ts --feature-dir features/my-feature --max-width 40',
  ],
  run({ args, positional }) {
    try {
      const explicitFeatureDir = args['feature-dir'] as string | undefined;
      const repoDir = args['repo'] as string | undefined;
      const issueId = args['issue'] as string | undefined;
      const slug = args['slug'] as string | undefined;
      const asJson = args['json'] === true;
      const maxWidthRaw = args['max-width'] as string | undefined;
      const maxWidth = maxWidthRaw ? Math.max(10, parseInt(maxWidthRaw, 10) || 44) : 44;
      const positionalPath = positional[0] as string | undefined;

      // Resolve feature directory
      let featureDir: string | null = null;

      if (explicitFeatureDir) {
        featureDir = resolve(explicitFeatureDir);
      } else if (positionalPath) {
        const abs = resolve(positionalPath);
        // If path directly has artifact files, use it as feature dir
        if (
          existsSync(join(abs, 'task-contract.json')) ||
          existsSync(join(abs, 'feature-state.json')) ||
          existsSync(join(abs, 'trace.jsonl')) ||
          existsSync(join(abs, '.trace-context.json'))
        ) {
          featureDir = abs;
        } else if (slug) {
          // Try positional as worktree root with slug subdirectory
          const candidate = join(abs, 'features', slug);
          if (existsSync(candidate)) {
            featureDir = candidate;
          }
        }
        // Fallback: treat positional as feature dir even if it doesn't exist
        if (!featureDir) {
          featureDir = abs;
        }
      }

      if (!featureDir) {
        // No path provided: use cwd
        featureDir = process.cwd();
      }

      const summary = summarizeArtifactStatus({
        featureDir,
        repoDir: repoDir ?? featureDir,
        issueId,
        slug,
      });

      if (asJson) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        const line = formatArtifactStatus(summary, { maxWidth });
        console.log(line);
      }
    } catch {
      // Best-effort: always exit 0, print empty on error
      console.log('');
    }
  },
});
