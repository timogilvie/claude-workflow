#!/usr/bin/env -S npx tsx

import { resolveRepoDir, runTool } from '../shared/lib/tool-runner.ts';
import {
  buildGlobalModelParityReport,
  renderGlobalModelParityReport,
} from '../shared/lib/parity-report.ts';

runTool({
  name: 'parity-report',
  description: 'Report global certified-model parity and challenge availability.',
  options: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
    'repo-dir': { type: 'string', description: 'Repository directory to inspect.' },
    'strict-challenge': { type: 'boolean', description: 'Exit non-zero when any stage lacks a challenge pair.' },
  },
  examples: [
    'npx tsx tools/parity-report.ts',
    'npx tsx tools/parity-report.ts --json --repo-dir ~/src/wavemill',
    'npx tsx tools/parity-report.ts --strict-challenge',
  ],
  async run({ args }) {
    const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
    const report = buildGlobalModelParityReport({ repoDir });
    console.log(args.json === true
      ? JSON.stringify(report, null, 2)
      : renderGlobalModelParityReport(report));

    if (report.forbiddenLocalConfig.length > 0) {
      process.exit(2);
    }
    if (
      args['strict-challenge'] === true
      && Object.values(report.challengePairAvailability).some((available) => available !== true)
    ) {
      process.exit(3);
    }
  },
});
