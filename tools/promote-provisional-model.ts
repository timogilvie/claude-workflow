#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  applyModelPromotion,
  parseModelTransitionSpecFile,
  planModelPromotion,
  rollbackModelPromotion,
} from '../shared/lib/model-promotion.ts';

runTool({
  name: 'promote-provisional-model',
  description: 'Dry-run-first provisional model promotion, re-keying, rollback, and audit manifest generation',
  options: {
    spec: {
      type: 'string',
      description: 'Path to model transition spec JSON',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory to inspect and mutate',
      default: '.',
    },
    apply: {
      type: 'boolean',
      description: 'Apply the verified promotion plan. Omitted means dry run only.',
    },
    manifest: {
      type: 'string',
      description: 'Existing promotion manifest to verify before apply, or restore during rollback',
    },
    rollback: {
      type: 'boolean',
      description: 'Restore exact backups recorded in --manifest',
    },
  },
  examples: [
    'npx tsx tools/promote-provisional-model.ts --spec transitions/ox.json --repo-dir .',
    'npx tsx tools/promote-provisional-model.ts --spec transitions/ox.json --repo-dir . --apply',
    'npx tsx tools/promote-provisional-model.ts --rollback --manifest .wavemill/model-promotions/ox/ox.manifest.json',
  ],
  additionalHelp: [
    'Operator contract:',
    '  Dry run is the default and writes no files. Review the emitted machine-readable manifest before --apply.',
    '  Apply writes per-file backups under .wavemill/model-promotions/<promotionId>/backups and a manifest record.',
    '  Rollback validates the manifest and backup hashes, then atomically restores the exact backups.',
    '  Refusals include malformed JSONL, structured target collisions, count mismatches, accepted Hokusai rows, incomplete pricing, and missing final native certification.',
  ].join('\n'),
  run({ args }) {
    if (args.rollback) {
      if (!args.manifest) {
        throw new Error('--rollback requires --manifest');
      }
      const manifest = rollbackModelPromotion(resolve(String(args.manifest)));
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }

    if (!args.spec) {
      throw new Error('--spec is required');
    }
    const repoDir = resolve(String(args['repo-dir'] ?? '.'));
    const spec = parseModelTransitionSpecFile(resolve(String(args.spec)));
    if (args.apply) {
      const manifest = applyModelPromotion({ spec, repoDir });
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }
    const manifest = planModelPromotion({ spec, repoDir });
    console.log(JSON.stringify(manifest, null, 2));
  },
});
