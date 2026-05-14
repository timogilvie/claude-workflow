#!/usr/bin/env -S npx tsx

import { runPromotion } from '../shared/lib/promotion-controller.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'promote',
  description: 'Open or update a promotion PR from integration to the promotion branch',
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Print promotion status without mutating',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
      default: process.cwd(),
    },
  },
  examples: [
    'npx tsx tools/promote.ts --dry-run',
    'npx tsx tools/promote.ts --repo-dir /path/to/repo',
  ],
  async run({ args }) {
    const repoDir = String(args['repo-dir'] || process.cwd());
    const result = await runPromotion({
      repoDir,
      dryRun: args['dry-run'],
    });

    console.log(`promote: ${result.status}${result.prUrl ? ` url=${result.prUrl}` : ''}`);
    if (result.checkSummary) {
      console.log(`checks: ${result.checkSummary}`);
    }
    if (result.status === 'blocked' && result.blockSummary) {
      console.log(`blocked: ${result.blockSummary}`);
    }
  },
});
