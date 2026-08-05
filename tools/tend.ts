#!/usr/bin/env -S npx tsx

import { join } from 'node:path';
import { createStatusRenderer } from '../shared/lib/tend-status-renderer.ts';
import { executeMerge, formatStatusLine, selectNextCandidate } from '../shared/lib/tend-controller.ts';
import { runPromotion } from '../shared/lib/promotion-controller.ts';
import { acquireTendLock } from '../shared/lib/tend-singleton.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { mutateJsonState } from '../shared/lib/state-mutex.ts';

const TEND_LOOP_INTERVAL_MS = 60_000;

interface BackstageHealthFile {
  updatedAt?: string;
  status?: string;
  detail?: string | null;
  restartAttemptCount?: number;
  lastRestartAttemptAt?: string | null;
  executorPaneId?: string | null;
  services?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusActionForResult(status: string, prNumber: number): string {
  return status === 'merged' ? `merged-#${prNumber}` : `${status}-#${prNumber}`;
}

async function writeTendHeartbeat(repoDir: string, timestamp: string): Promise<void> {
  const healthPath = join(repoDir, '.wavemill', 'backstage-health.json');
  await mutateJsonState<BackstageHealthFile>(
    healthPath,
    (current) => {
      const next = { ...(current ?? {}) };
      const services = { ...(next.services ?? {}) };
      const existing = { ...(services.tend ?? {}) };
      const existingStatus = typeof existing.status === 'string'
        ? existing.status
        : typeof next.status === 'string'
          ? next.status
          : '';
      const preserveActionableStatus = existingStatus === 'stalled' || existingStatus === 'needs-user';
      const status = preserveActionableStatus ? existingStatus : 'healthy';
      const detail = preserveActionableStatus
        ? (typeof existing.detail === 'string'
            ? existing.detail
            : typeof next.detail === 'string'
              ? next.detail
              : 'backstage tend loop is running')
        : 'backstage tend loop is running';
      const restartAttemptCount = preserveActionableStatus && typeof existing.restartAttemptCount === 'number'
        ? existing.restartAttemptCount
        : 0;
      const existingLastRestartAttemptAt = typeof existing.lastRestartAttemptAt === 'string'
        ? existing.lastRestartAttemptAt
        : null;
      const lastRestartAttemptAt = preserveActionableStatus
        ? existingLastRestartAttemptAt ?? next.lastRestartAttemptAt ?? null
        : null;
      services.tend = {
        ...existing,
        status,
        detail,
        heartbeatAt: timestamp,
        updatedAt: timestamp,
        restartAttemptCount,
        lastRestartAttemptAt,
        repoDir,
      };
      next.updatedAt = timestamp;
      next.status = status;
      next.detail = detail;
      next.restartAttemptCount = restartAttemptCount;
      next.lastRestartAttemptAt = lastRestartAttemptAt;
      next.services = services;
      return next;
    },
    { createIfMissing: true, initial: {} },
  );
}

async function writeTendHeartbeatBestEffort(repoDir: string): Promise<void> {
  try {
    await writeTendHeartbeat(repoDir, new Date().toISOString());
  } catch (error) {
    console.error(`tend: failed to write heartbeat: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    'npx tsx tools/tend.ts promote --repo-dir /path/to/repo',
  ],
  positional: {
    name: 'command',
    description: 'Optional subcommand (supported: promote)',
  },
  async run({ args, positional }) {
    const subcommand = positional[0];
    if (!args.once && !args.loop) {
      if (subcommand === 'promote') {
        const repoDir = String(args['repo-dir'] || process.cwd());
        const result = await runPromotion({ repoDir, dryRun: args['dry-run'] });
        console.log(`promote: ${result.status}${result.prUrl ? ` url=${result.prUrl}` : ''}`);
        if (result.checkSummary) {
          console.log(`checks: ${result.checkSummary}`);
        }
        return;
      }
      throw new Error('one of --once or --loop is required');
    }

    const repoDir = String(args['repo-dir'] || process.cwd());

    if (args.loop) {
      let lastMergedPR: number | null = null;
      const renderer = createStatusRenderer(process.stdout as NodeJS.WriteStream);
      const lock = acquireTendLock({
        repoDir,
        session: process.env.WAVEMILL_SESSION,
      });

      if (lock.outcome === 'skipped') {
        renderer.finalize();
        return;
      }

      const handleSignal = (signal: NodeJS.Signals) => {
        renderer.finalize();
        process.kill(process.pid, signal);
      };
      process.once('SIGINT', () => handleSignal('SIGINT'));
      process.once('SIGTERM', () => handleSignal('SIGTERM'));

      try {
        while (true) {
          await writeTendHeartbeatBestEffort(repoDir);
          const decision = await selectNextCandidate({ repoDir });
          if (decision.nextPR === null) {
            renderer.write(formatStatusLine(decision, { action: 'idle', lastPR: lastMergedPR }));
            await sleep(TEND_LOOP_INTERVAL_MS);
            continue;
          }

          const candidate = decision.eligible.find((item) => item.number === decision.nextPR);
          if (!candidate) {
            throw new Error(`tend: selected PR #${decision.nextPR} was not found in eligible candidates`);
          }

          renderer.write(formatStatusLine(decision, {
            action: `merging-#${candidate.number}`,
            lastPR: lastMergedPR,
          }));

          const result = await executeMerge(candidate, { repoDir });
          if (result.status === 'merged') {
            lastMergedPR = result.prNumber;
          }

          renderer.write(formatStatusLine(decision, {
            action: statusActionForResult(result.status, result.prNumber),
            lastPR: lastMergedPR,
          }));

          if (result.haltLoop) {
            renderer.finalize();
            process.exitCode = 1;
            break;
          }

          await sleep(TEND_LOOP_INTERVAL_MS);
        }
      } finally {
        lock.release();
      }
      return;
    }

    const decision = await selectNextCandidate({
      repoDir,
      loserCleanup: args['dry-run'] ? () => {} : undefined,
    });
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
