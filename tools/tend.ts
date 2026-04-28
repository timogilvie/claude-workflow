#!/usr/bin/env -S npx tsx

import { formatStatusLine, selectNextCandidate } from '../shared/lib/tend-controller.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'tend',
  description: 'Tend the integration queue (dry-run candidate selection)',
  options: {
    once: {
      type: 'boolean',
      description: 'Run once and exit (required in this slice)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print status line without mutating (required in this slice)',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
      default: process.cwd(),
    },
  },
  examples: [
    'npx tsx tools/tend.ts --once --dry-run',
    'npx tsx tools/tend.ts --once --dry-run --repo-dir /path/to/repo',
  ],
  async run({ args }) {
    if (!args.once) {
      throw new Error('--once is required');
    }

    if (!args['dry-run']) {
      throw new Error('--dry-run is required');
    }

    const repoDir = String(args['repo-dir'] || process.cwd());
    const decision = await selectNextCandidate({ repoDir });
    console.log(formatStatusLine(decision));
  },
});
