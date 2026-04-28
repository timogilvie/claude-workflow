#!/usr/bin/env -S npx tsx

import { executeMerge, formatStatusLine, selectNextCandidate } from '../shared/lib/tend-controller.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

const TEND_LOOP_INTERVAL_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusActionForResult(status: string, prNumber: number): string {
  return status === 'merged' ? `merged-#${prNumber}` : `${status}-#${prNumber}`;
}

runTool({
  name: 'tend',
  description: 'Tend the integration queue',
  options: {
    once: {
      type: 'boolean',
      description: 'Run once and exit',
    },
    loop: {
      type: 'boolean',
      description: 'Run continuously inside the mill tmux session',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print status line without mutating',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
      default: process.cwd(),
    },
  },
  examples: [
    'npx tsx tools/tend.ts --once --dry-run',
    'npx tsx tools/tend.ts --once --repo-dir /path/to/repo',
    'npx tsx tools/tend.ts --loop --repo-dir /path/to/repo',
  ],
  async run({ args }) {
    if (!args.once && !args.loop) {
      throw new Error('one of --once or --loop is required');
    }

    const repoDir = String(args['repo-dir'] || process.cwd());

    if (args.loop) {
      let lastMergedPR: number | null = null;

      while (true) {
        const decision = await selectNextCandidate({ repoDir });
        if (decision.nextPR === null) {
          console.log(formatStatusLine(decision, { action: 'idle', lastPR: lastMergedPR }));
          await sleep(TEND_LOOP_INTERVAL_MS);
          continue;
        }

        const candidate = decision.eligible.find((item) => item.number === decision.nextPR);
        if (!candidate) {
          throw new Error(`tend: selected PR #${decision.nextPR} was not found in eligible candidates`);
        }

        console.log(formatStatusLine(decision, {
          action: `merging-#${candidate.number}`,
          lastPR: lastMergedPR,
        }));

        const result = await executeMerge(candidate, { repoDir });
        if (result.status === 'merged') {
          lastMergedPR = result.prNumber;
        }

        console.log(formatStatusLine(decision, {
          action: statusActionForResult(result.status, result.prNumber),
          lastPR: lastMergedPR,
        }));

        if (result.haltLoop) {
          process.exitCode = 1;
          break;
        }

        await sleep(TEND_LOOP_INTERVAL_MS);
      }
      return;
    }

    const decision = await selectNextCandidate({ repoDir });
    if (args['dry-run'] || decision.nextPR === null) {
      console.log(formatStatusLine(decision, { action: 'idle' }));
      return;
    }

    const candidate = decision.eligible.find((item) => item.number === decision.nextPR);
    if (!candidate) {
      throw new Error(`tend: selected PR #${decision.nextPR} was not found in eligible candidates`);
    }

    const result = await executeMerge(candidate, { repoDir });
    console.log(formatStatusLine(decision, {
      action: statusActionForResult(result.status, result.prNumber),
      lastPR: result.status === 'merged' ? result.prNumber : null,
    }));
    if (result.status === 'halted') {
      process.exitCode = 1;
    }
  },
});
