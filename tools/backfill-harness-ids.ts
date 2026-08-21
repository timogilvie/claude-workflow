#!/usr/bin/env -S npx tsx
import { backfillHarnessIds } from '../shared/lib/harness-id-backfill.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'backfill-harness-ids',
  description: 'Best-effort backfill of harnessId on manifests, eval records, and challenge records',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory override' },
    'dry-run': { type: 'boolean', description: 'Report changes without writing them' },
  },
  async run({ args }) {
    const summary = backfillHarnessIds({
      repoDir: args['repo-dir'] as string | undefined,
      dryRun: Boolean(args['dry-run']),
    });
    console.log(JSON.stringify(summary, null, 2));
  },
});
