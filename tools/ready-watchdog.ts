#!/usr/bin/env -S npx tsx

import path from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { tickReadyWatchdog } from '../shared/lib/ready-watchdog.ts';

runTool({
  name: 'ready-watchdog',
  description: 'Classify and recover stale ready-stage local state',
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
    'state-file': {
      type: 'string',
      description: 'Workflow state file path (default: <repo>/.wavemill/workflow-state.json)',
    },
    once: {
      type: 'boolean',
      description: 'Run a single watchdog tick and exit',
      default: true,
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON output',
    },
    recover: {
      type: 'string',
      description: 'Force a recovery attempt for one ready-stage issue id',
    },
  },
  async run({ args }) {
    const repoDir = path.resolve(args['repo-dir'] || process.cwd());
    const stateFile = path.resolve(args['state-file'] || path.join(repoDir, '.wavemill', 'workflow-state.json'));
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      issueFilter: args.recover,
      forceRecover: Boolean(args.recover),
    });

    if (args.json) {
      console.log(JSON.stringify(result));
      return;
    }

    if (result.findings.length === 0) {
      console.log('No stale ready-stage tasks detected.');
      return;
    }

    for (const finding of result.findings) {
      console.log(
        `${finding.issueId} ${finding.displayLabel}: ${finding.detail}`
        + (finding.recoveryCommand ? `\n  recovery: ${finding.recoveryCommand}` : ''),
      );
    }
  },
});
