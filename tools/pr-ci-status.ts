#!/usr/bin/env -S npx tsx

import { fetchPrCiStatus } from '../shared/lib/pr-ci-status.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'pr-ci-status',
  description: 'Read live GitHub CI status for a pull request',
  positional: {
    name: 'pr',
    description: 'Pull request number',
  },
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
    base: {
      type: 'string',
      description: 'Base branch for required-check resolution',
    },
  },
  examples: [
    'npx tsx tools/pr-ci-status.ts 42 --base auto/integration',
  ],
  async run({ positional, args }) {
    const rawPr = positional[0];
    const prNumber = Number.parseInt(rawPr ?? '', 10);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      throw new Error('PR number required');
    }

    const repoDir = args['repo-dir'] ? String(args['repo-dir']) : process.cwd();
    const baseBranch = args.base ? String(args.base) : undefined;
    const status = await fetchPrCiStatus(prNumber, repoDir, {}, { baseBranch });
    console.log(JSON.stringify(status));
  },
});
