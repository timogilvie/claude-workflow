#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { repairChallengePairing } from '../shared/lib/challenge-pairing-repair.ts';

runTool({
  name: 'repair-challenge-pairing',
  description:
    'Re-anchor a drifted challenger task and relabel mis-filed eval records so compare-prs can pair both sides of a challenge.',
  options: {
    'pair-id': { type: 'string', description: 'Challenge pair identifier (the primary issue id)' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
  },
  async run({ args }) {
    const pairId = args['pair-id'] as string;
    if (!pairId) {
      throw new Error('--pair-id is required');
    }
    const repoDir = (args['repo-dir'] as string) || process.cwd();
    const result = await repairChallengePairing({ pairId, repoDir });
    console.log(JSON.stringify(result, null, 2));
  },
});
