#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveUnresolvablePair } from '../shared/lib/challenge-pair-resolver.ts';
import { UNRESOLVABLE_REASONS, isUnresolvableReason, type UnresolvableReason } from '../shared/lib/tend-challenge-gate.ts';

runTool({
  name: 'resolve-orphan-challenge-pair',
  description: 'Write a terminal challenge comparison record when a pair is confirmed unresolvable.',
  options: {
    'pair-id': { type: 'string', description: 'Challenge pair identifier' },
    reason: { type: 'string', description: 'Optional explicit unresolvable reason override (one of the UnresolvableReason values).' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
    'dry-run': { type: 'boolean', description: 'Classify and render the result without writing the record' },
  },
  examples: [
    'npx tsx tools/resolve-orphan-challenge-pair.ts --pair-id HOK-2350 --repo-dir . --dry-run',
    'npx tsx tools/resolve-orphan-challenge-pair.ts --pair-id HOK-2351 --reason sibling-eval-hard-failed --repo-dir .',
    'npx tsx tools/resolve-orphan-challenge-pair.ts --pair-id HOK-2352 --reason both-challenge-aborted --repo-dir .',
  ],
  async run({ args }) {
    const pairId = (args['pair-id'] as string | undefined)?.trim();
    const repoDir = (args['repo-dir'] as string | undefined)?.trim() || process.cwd();
    const reasonRaw = (args.reason as string | undefined)?.trim();

    if (!pairId) {
      throw new Error('--pair-id is required');
    }

    // Derive the accepted set from the canonical UNRESOLVABLE_REASONS const so a
    // future reason value cannot desynchronize this CLI from the gate
    // (HOK-2773). No hardcoded list.
    if (reasonRaw !== undefined && !isUnresolvableReason(reasonRaw)) {
      throw new Error(`Unsupported --reason value: ${reasonRaw}. Expected one of: ${UNRESOLVABLE_REASONS.join(', ')}`);
    }
    const reason: UnresolvableReason | undefined = reasonRaw;

    const result = resolveUnresolvablePair({
      pairId,
      repoDir,
      reason,
      dryRun: args['dry-run'] === true,
    });

    console.log(JSON.stringify(result, null, 2));
  },
});
