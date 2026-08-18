import { join } from 'node:path';
import { classifyGhError, computeBackoffDelayMs } from './gh-retry.ts';
import { mutateJsonState } from './state-mutex.ts';
import { type StatusRenderer } from './tend-status-renderer.ts';
import {
  executeMerge,
  formatStatusLine,
  selectNextCandidate,
  type MergeExecutionResult,
  type TendCandidate,
  type TendDecision,
} from './tend-controller.ts';
import { TendFatalError } from './tend-errors.ts';

export const TEND_LOOP_INTERVAL_MS = 60_000;
export const TEND_LOOP_ERROR_BACKOFF_BASE_MS = 30_000;
export const TEND_LOOP_ERROR_BACKOFF_MAX_MS = 300_000;

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

export interface TendLoopDeps {
  selectNextCandidate: (opts: { repoDir: string }) => Promise<TendDecision>;
  executeMerge: (candidate: TendCandidate, opts: { repoDir: string }) => Promise<MergeExecutionResult>;
  writeHeartbeat: (repoDir: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  renderer: StatusRenderer;
  log: (line: string) => void;
  random?: () => number;
  intervalMs?: number;
  errorBackoffBaseMs?: number;
  errorBackoffMaxMs?: number;
}

export type TendLoopExit =
  | { reason: 'halted'; prNumber: number }
  | { reason: 'fatal'; error: unknown };

function statusActionForResult(status: string, prNumber: number): string {
  return status === 'merged' ? `merged-#${prNumber}` : `${status}-#${prNumber}`;
}

/**
 * Default tend-loop dependency set used by the CLI wrapper.
 */
export function defaultTendLoopDeps(renderer: StatusRenderer): TendLoopDeps {
  return {
    selectNextCandidate,
    executeMerge,
    writeHeartbeat: writeTendHeartbeatBestEffort,
    sleep,
    renderer,
    log: (line) => console.error(line),
  };
}

/**
 * Classify an error thrown from a tend-loop iteration.
 */
export function classifyTendLoopError(error: unknown): 'fatal' | 'transient' | 'unexpected' {
  if (error instanceof TendFatalError || error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
    return 'fatal';
  }

  const ghKind = classifyGhError(error).kind;
  if (ghKind === 'auth') {
    return 'fatal';
  }
  if (ghKind === 'transient') {
    return 'transient';
  }

  return 'unexpected';
}

/**
 * Run the continuous tend loop. Recoverable iteration failures are logged,
 * backed off, and retried; fatal failures are returned to the CLI wrapper.
 */
export async function runTendLoop(repoDir: string, deps: TendLoopDeps): Promise<TendLoopExit> {
  let lastMergedPR: number | null = null;
  let lastDecision: TendDecision | null = null;
  let consecutiveFailures = 0;
  const intervalMs = deps.intervalMs ?? TEND_LOOP_INTERVAL_MS;
  const errorBackoffBaseMs = deps.errorBackoffBaseMs ?? TEND_LOOP_ERROR_BACKOFF_BASE_MS;
  const errorBackoffMaxMs = deps.errorBackoffMaxMs ?? TEND_LOOP_ERROR_BACKOFF_MAX_MS;
  const random = deps.random ?? Math.random;

  while (true) {
    try {
      await deps.writeHeartbeat(repoDir);
      const decision = await deps.selectNextCandidate({ repoDir });
      lastDecision = decision;

      if (decision.nextPR === null) {
        consecutiveFailures = 0;
        deps.renderer.write(formatStatusLine(decision, { action: 'idle', lastPR: lastMergedPR }));
        await deps.sleep(intervalMs);
        continue;
      }

      const candidate = decision.eligible.find((item) => item.number === decision.nextPR);
      if (!candidate) {
        throw new TendFatalError(`tend: selected PR #${decision.nextPR} was not found in eligible candidates`);
      }

      deps.renderer.write(formatStatusLine(decision, {
        action: `merging-#${candidate.number}`,
        lastPR: lastMergedPR,
      }));

      const result = await deps.executeMerge(candidate, { repoDir });
      if (result.status === 'merged') {
        lastMergedPR = result.prNumber;
      }

      consecutiveFailures = 0;
      deps.renderer.write(formatStatusLine(decision, {
        action: statusActionForResult(result.status, result.prNumber),
        lastPR: lastMergedPR,
      }));

      if (result.haltLoop) {
        deps.renderer.finalize();
        return { reason: 'halted', prNumber: result.prNumber };
      }

      await deps.sleep(intervalMs);
    } catch (error) {
      const classification = classifyTendLoopError(error);
      if (classification === 'fatal') {
        deps.log(`tend: fatal error, exiting: ${errorMessage(error)}`);
        deps.renderer.finalize();
        return { reason: 'fatal', error };
      }

      consecutiveFailures += 1;
      const delayMs = computeBackoffDelayMs(consecutiveFailures, errorBackoffBaseMs, errorBackoffMaxMs, random);
      deps.log(
        `tend: ${classification} error (${consecutiveFailures} consecutive): ${errorMessage(error)}; retrying in ${Math.round(delayMs / 1000)}s`,
      );
      deps.renderer.write(formatStatusLine(lastDecision ?? emptyDecision(), {
        action: `retry-${consecutiveFailures}`,
        lastPR: lastMergedPR,
      }));
      await deps.sleep(delayMs);
    }
  }
}

function emptyDecision(): TendDecision {
  return { integrationHealth: { state: 'healthy' }, eligible: [], blocked: [], nextPR: null };
}

async function writeTendHeartbeat(repoDir: string, timestamp: string): Promise<void> {
  const healthPath = join(repoDir, '.wavemill', 'backstage-health.json');
  await mutateJsonState<BackstageHealthFile>(
    healthPath,
    (current) => {
      const next = { ...(current ?? {}) };
      const services = { ...(next.services ?? {}) };
      const existing = { ...(services.tend ?? {}) };
      services.tend = {
        ...existing,
        status: 'healthy',
        detail: 'backstage tend loop is running',
        heartbeatAt: timestamp,
        updatedAt: timestamp,
        restartAttemptCount: 0,
        lastRestartAttemptAt: null,
        repoDir,
      };
      next.updatedAt = timestamp;
      next.status = 'healthy';
      next.detail = 'backstage tend loop is running';
      next.restartAttemptCount = 0;
      next.lastRestartAttemptAt = null;
      next.services = services;
      return next;
    },
    { createIfMissing: true, initial: {} },
  );
}

/**
 * Best-effort heartbeat writer. Failures are logged but never escape the loop.
 */
export async function writeTendHeartbeatBestEffort(repoDir: string): Promise<void> {
  try {
    await writeTendHeartbeat(repoDir, new Date().toISOString());
  } catch (error) {
    console.error(`tend: failed to write heartbeat: ${errorMessage(error)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
