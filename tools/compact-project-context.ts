#!/usr/bin/env -S npx tsx
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { compactProjectContext } from '../shared/lib/project-context-compactor.ts';

function formatKb(bytes: number): number {
  return Math.floor(bytes / 1024);
}

runTool({
  name: 'compact-project-context',
  description: 'Archive and compact .wavemill/project-context.md Recent Work entries',
  options: {
    'threshold-kb': { type: 'string', description: 'Compaction threshold in KB' },
    'keep-recent': { type: 'string', description: 'Number of recent entries to keep' },
    'dry-run': { type: 'boolean', description: 'Show result without modifying files' },
  },
  positional: {
    name: 'repoPath',
    description: 'Repository path (default: current directory)',
  },
  examples: [
    'npx tsx tools/compact-project-context.ts',
    'npx tsx tools/compact-project-context.ts --dry-run',
    'npx tsx tools/compact-project-context.ts --threshold-kb 120 --keep-recent 30 /path/to/repo',
  ],
  async run({ args, positional }) {
    const repoDir = resolveRepoDir(positional[0]);
    const thresholdKb = args['threshold-kb'] ? Number(args['threshold-kb']) : undefined;
    const keepRecent = args['keep-recent'] ? Number(args['keep-recent']) : undefined;

    if (thresholdKb !== undefined && (!Number.isFinite(thresholdKb) || thresholdKb <= 0)) {
      throw new Error(`Invalid --threshold-kb value: ${args['threshold-kb']}`);
    }
    if (keepRecent !== undefined && (!Number.isFinite(keepRecent) || keepRecent <= 0)) {
      throw new Error(`Invalid --keep-recent value: ${args['keep-recent']}`);
    }

    const result = await compactProjectContext({
      repoDir,
      thresholdKb,
      keepRecent,
      dryRun: args['dry-run'] === true,
    });

    if (result.skipped) {
      console.log(`skipped: file under threshold (${formatKb(result.originalSizeBytes)}KB ≤ ${thresholdKb ?? 100}KB)`);
      return;
    }

    if (result.dryRun) {
      console.log(
        `dry-run: ${formatKb(result.originalSizeBytes)}KB → ${formatKb(result.newSizeBytes)}KB, ` +
          `would keep ${result.entriesKept} entries (archive ${result.entriesArchived})`
      );
      return;
    }

    console.log(
      `compacted: ${formatKb(result.originalSizeBytes)}KB → ${formatKb(result.newSizeBytes)}KB, ` +
        `archived to ${result.archivedPath}, kept ${result.entriesKept} entries (archived ${result.entriesArchived})`
    );
  },
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
