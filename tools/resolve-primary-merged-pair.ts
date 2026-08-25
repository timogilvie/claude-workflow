#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { resolvePrimaryMergedPair } from '../shared/lib/challenge-pair-resolver.ts';

runTool({
  name: 'resolve-primary-merged-pair',
  description: 'Write a terminal challenge comparison record when a primary arm merged before comparison.',
  options: {
    'pair-id': { type: 'string', description: 'Challenge pair identifier' },
    'primary-pr': { type: 'string', description: 'Merged primary PR number' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
    json: { type: 'boolean', description: 'Emit JSON output' },
    'dry-run': { type: 'boolean', description: 'Render the result without writing state or comparison records' },
  },
  examples: [
    'npx tsx tools/resolve-primary-merged-pair.ts --pair-id HOK-2871 --primary-pr 1230 --repo-dir .',
    'npx tsx tools/resolve-primary-merged-pair.ts --pair-id HOK-2872 --primary-pr 1227 --repo-dir . --dry-run',
  ],
  async run({ args }) {
    const pairId = (args['pair-id'] as string | undefined)?.trim();
    const repoDir = (args['repo-dir'] as string | undefined)?.trim() || process.cwd();
    const primaryPrRaw = (args['primary-pr'] as string | undefined)?.trim();
    const primaryPr = Number(primaryPrRaw);

    if (!pairId) {
      throw new Error('--pair-id is required');
    }
    if (!Number.isInteger(primaryPr) || primaryPr <= 0) {
      throw new Error('--primary-pr must be a positive integer');
    }

    const result = await resolvePrimaryMergedPair({
      pairId,
      primaryPr,
      repoDir,
      dryRun: args['dry-run'] === true,
    });

    console.log(JSON.stringify(result, null, 2));
  },
});
