#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { runChallengeRecovery } from '../shared/lib/challenge-pair-recovery.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'challenge-pair-recovery',
  description: 'Assess named challenge pairs and, only when both arms and an immutable intent are provable, append a superseding comparison',
  options: {
    pair: { type: 'string', description: 'Comma-separated challenge pair IDs (required; there is no recover-all mode)' },
    'repo-dir': { type: 'string', description: 'Repository root (default: cwd)' },
    apply: { type: 'boolean', description: 'Append audit and superseding records; default is dry-run' },
  },
  examples: [
    'npx tsx tools/challenge-pair-recovery.ts --pair HOK-2757',
    'npx tsx tools/challenge-pair-recovery.ts --pair HOK-2757,HOK-2761,HOK-2762 --apply',
  ],
  run({ args, positional }) {
    const repoDir = resolve((args['repo-dir'] as string | undefined) || '.');
    const pairIds = [
      ...String(args.pair ?? '').split(','),
      ...(positional ?? []),
    ]
      .map((value) => value.trim())
      .filter(Boolean);

    if (pairIds.length === 0) {
      throw new Error('--pair is required (comma-separated challenge pair IDs)');
    }

    const result = runChallengeRecovery({ repoDir, pairIds, apply: args.apply === true });
    console.log(JSON.stringify(result, null, 2));

    for (const assessment of result.assessments) {
      const label = assessment.verdict === 'supersedable' ? 'SUPERSEDABLE' : assessment.verdict.toUpperCase();
      console.error(`${assessment.pairId}: ${label}`);
      for (const blocker of assessment.blockers) {
        console.error(`  - ${blocker}`);
      }
    }
    if (!result.applied) {
      console.error('\nDry run: no files were written. Re-run with --apply to append audit and superseding records.');
    }
  },
});
