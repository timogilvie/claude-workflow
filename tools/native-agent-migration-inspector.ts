#!/usr/bin/env -S npx tsx

import { existsSync, statSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import { listCertifications } from '../shared/lib/native-agent/certification/index.ts';
import { evaluateMigrationEligibility } from '../shared/lib/native-agent/certification/migration.ts';

runTool({
  name: 'native-agent-migration-inspector',
  description: 'Inspect legacy repo-local native-agent certification artifacts without importing them.',
  options: {
    repo: { type: 'string', description: 'Repository directory to scan. Defaults to current working directory.' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
  },
  examples: [
    'npx tsx tools/native-agent-migration-inspector.ts',
    'npx tsx tools/native-agent-migration-inspector.ts --json',
  ],
  async run({ args }) {
    const repoDir = (args.repo as string | undefined) || process.cwd();
    const inspections = listCertifications(repoDir).map((path) => evaluateMigrationEligibility({
      path,
      sizeBytes: safeSize(path),
      globalArtifactExists: existsSync,
    }));

    if (args.json === true) {
      console.log(JSON.stringify({ scanned: inspections.length, inspections }, null, 2));
      return;
    }

    if (inspections.length === 0) {
      console.log('No legacy repo-local certification artifacts found.');
      return;
    }

    for (const item of inspections) {
      console.log(`${item.decision} ${item.path} ${item.provider ?? '?'} / ${item.model ?? '?'} ${item.suiteVersion ?? '?'} - ${item.reason}`);
    }
  },
});

function safeSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}
