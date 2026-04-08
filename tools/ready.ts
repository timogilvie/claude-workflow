#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { runReadyStage } from '../shared/lib/ready-stage.ts';

runTool({
  name: 'ready',
  description: 'Check PR merge-readiness (CI, approvals, conflicts)',
  positional: {
    name: 'pr',
    description: 'PR number or URL',
  },
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
  },
  examples: [
    '# Check PR 42 in current repo',
    'npx tsx tools/ready.ts 42',
    '',
    '# Check PR from URL',
    'npx tsx tools/ready.ts https://github.com/org/repo/pull/42',
  ],
  async run({ positional, args }) {
    if (positional.length === 0) {
      throw new Error('PR number or URL required');
    }

    // Parse PR number from URL or direct number
    const prInput = positional[0];
    const prNumber = extractPrNumber(prInput);

    const repoDir = args['repo-dir'] || process.cwd();
    const result = await runReadyStage({ prNumber, repoDir });

    // Output JSON for scripting
    console.log(JSON.stringify(result, null, 2));

    // Exit code based on verdict
    if (result.verdict === 'fail') {
      process.exit(1);
    }
  },
});

function extractPrNumber(input: string): number {
  // Try direct number first
  const num = parseInt(input, 10);
  if (!isNaN(num) && num > 0) {
    return num;
  }

  // Try GitHub PR URL pattern
  const match = input.match(/\/pull\/(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }

  throw new Error(`Invalid PR number or URL: ${input}`);
}
