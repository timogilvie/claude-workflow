#!/usr/bin/env -S npx tsx

import { executeMerge, formatStatusLine, selectNextCandidate } from '../shared/lib/tend-controller.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'tend',
  description: 'Tend the integration queue',
  options: {
    once: {
      type: 'boolean',
      description: 'Run once and exit (required in this slice)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print status line without mutating',
    },
    execute: {
      type: 'boolean',
      description: 'Execute merge for the next ready PR (live mode)',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
      default: process.cwd(),
    },
  },
  examples: [
    'npx tsx tools/tend.ts --once --dry-run',
    'npx tsx tools/tend.ts --once --execute',
    'npx tsx tools/tend.ts --once --dry-run --repo-dir /path/to/repo',
  ],
  async run({ args }) {
    if (!args.once) {
      throw new Error('--once is required');
    }

    const repoDir = String(args['repo-dir'] || process.cwd());

    if (args['dry-run']) {
      const decision = await selectNextCandidate({ repoDir });
      console.log(formatStatusLine(decision));
    } else if (args['execute']) {
      const outcome = await executeMerge({ repoDir });
      console.log(JSON.stringify(outcome));
    } else {
      throw new Error('one of --dry-run or --execute is required');
    }
  },
});
