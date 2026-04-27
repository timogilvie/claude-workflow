#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import { initGithubLabels } from '../shared/lib/pr-state-labels.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'init-github-labels',
  description: 'Initialize Wavemill GitHub repository labels',
  options: {
    repo: {
      type: 'string',
      description: 'Repository in owner/repo format (defaults to current repo)',
    },
  },
  examples: [
    'npx tsx tools/init-github-labels.ts',
    'npx tsx tools/init-github-labels.ts --repo owner/repo',
  ],
  async run({ args }) {
    const result = initGithubLabels({ repo: args.repo });
    console.log(`Repository: ${result.repo}`);
    console.log(`Created ${result.created.length} label(s): ${result.created.join(', ') || 'none'}`);
    console.log(`Skipped ${result.skipped.length} existing label(s): ${result.skipped.join(', ') || 'none'}`);
  },
} as const;

if (isMainModule) {
  runTool(config);
}
