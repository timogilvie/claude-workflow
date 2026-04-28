#!/usr/bin/env -S npx tsx

import { executeMerge, formatStatusLine, selectNextCandidate } from '../shared/lib/tend-controller.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'tend',
  description: 'Tend the integration queue',
  options: {
    once: {
      type: 'boolean',
      description: 'Run once and exit',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print status line without mutating',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
      default: process.cwd(),
    },
  },
  examples: [
    'npx tsx tools/tend.ts --once --dry-run',
    'npx tsx tools/tend.ts --once --repo-dir /path/to/repo',
  ],
  async run({ args }) {
    if (!args.once) {
      throw new Error('--once is required');
    }

    const repoDir = String(args['repo-dir'] || process.cwd());
    const decision = await selectNextCandidate({ repoDir });
    if (args['dry-run'] || decision.nextPR === null) {
      console.log(formatStatusLine(decision));
      return;
    }

    const candidate = decision.eligible.find((item) => item.number === decision.nextPR);
    if (!candidate) {
      throw new Error(`tend: selected PR #${decision.nextPR} was not found in eligible candidates`);
    }

    const result = await executeMerge(candidate, { repoDir });
    console.log(`tend: PR#${result.prNumber} ${result.status}${result.phase ? ` phase=${result.phase}` : ''}`);
    if (result.status === 'halted') {
      process.exitCode = 1;
    }
  },
});
