#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { backfillRubricProvenance } from '../shared/lib/eval-backfill.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'backfill-rubric-eval-records',
  description: 'Mark historical eval records with rubric provenance metadata',
  options: {
    repo: { type: 'string', description: 'Repository directory to backfill', default: '.' },
    'dry-run': { type: 'boolean', description: 'Report changes without writing them' },
  },
  examples: [
    'npx tsx tools/backfill-rubric-eval-records.ts --repo .',
    'npx tsx tools/backfill-rubric-eval-records.ts --repo /path/to/repo --dry-run',
  ],
  async run({ args }) {
    const repoDir = resolve((args.repo as string | undefined) || '.');
    const dryRun = Boolean(args['dry-run']);
    const result = await backfillRubricProvenance({ repoDir, dryRun });

    console.log(JSON.stringify({ repoDir, dryRun, ...result }, null, 2));
  },
});
