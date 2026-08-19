import { join } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';
import { executeMerge, formatStatusLine, selectNextCandidate, type MergeExecutionResult } from './tend-controller.ts';
import type { StatusRenderer } from './tend-status-renderer.ts';
import { computeBackoffDelayMs, isTransientError } from './transient-retry.ts';

export const TEND_LOOP_INTERVAL_MS = 60_000;
export const TEND_LOOP_ERROR_BACKOFF_BASE_MS = 30_000;
// Keep this below BACKSTAGE_TEND_HEARTBEAT_STALE_SECONDS in wavemill-mill.sh.
export const TEND_LOOP_ERROR_BACKOFF_MAX_MS = 120_000;
export const TEND_MAX_CONSECUTIVE_UNKNOWN_FAILURES = 3;

export type TendLoopErrorClass = 'transient' | 'terminal' | 'unknown';

export interface TendLoopExit {
  reason: 'halted' | 'terminal-error' | 'unknown-error-budget-exhausted';
  error?: unknown;
  lastMergedPR: number | null;
}

export interface TendLoopDeps {
  selectNextCandidate: typeof selectNextCandidate;
  executeMerge: typeof executeMerge;
  writeHeartbeat: typeof writeTendHeartbeatBestEffort;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  random: () => number;
}

export interface TendLoopOptions {
  repoDir: string;
  renderer: StatusRenderer;
  deps?: Partial<TendLoopDeps>;
  intervalMs?: number;
  errorBackoffBaseMs?: number;
  errorBackoffMaxMs?: number;
  maxConsecutiveUnknownFailures?: number;
}

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

const TERMINAL_ERROR_PATTERNS = [
  /integration branch not configured/i,
  /invalid (?:integration|PR) branch name/i,
  /tend-singleton:/i,
  /was not found in eligible candidates/i,
];

export function statusActionForResult(status: MergeExecutionResult['status'], prNumber: number): string {
  return status === 'merged' ? `merged-#${prNumber}` : `${status}-#${prNumber}`;
}

export async function runTendLoop(options: TendLoopOptions): Promise<TendLoopExit> {
  const deps = tendLoopDeps(options.deps);
  const intervalMs = options.intervalMs ?? TEND_LOOP_INTERVAL_MS;
  const maxUnknown = options.maxConsecutiveUnknownFailures ?? TEND_MAX_CONSECUTIVE_UNKNOWN_FAILURES;
  let lastMergedPR: number | null = null;
  let consecutiveFailures = 0;
  let consecutiveUnknown = 0;
  let lastError: string | null = null;
  let lastErrorAt: string | null = null;

  while (true) {
    await deps.writeHeartbeat(options.repoDir, {
      failureCount: consecutiveFailures,
      lastError,
      lastErrorAt,
      timestamp: deps.now().toISOString(),
    });

    try {
      const decision = await deps.selectNextCandidate({ repoDir: options.repoDir });
      if (decision.nextPR === null) {
        options.renderer.write(formatStatusLine(decision, { action: 'idle', lastPR: lastMergedPR }));
        consecutiveFailures = 0;
        consecutiveUnknown = 0;
        lastError = null;
        lastErrorAt = null;
        await deps.writeHeartbeat(options.repoDir, {
          failureCount: consecutiveFailures,
          lastError,
          lastErrorAt,
          timestamp: deps.now().toISOString(),
        });
        await deps.sleep(intervalMs);
        continue;
      }

      const candidate = decision.eligible.find((item) => item.number === decision.nextPR);
      if (!candidate) {
        throw new Error(`tend: selected PR #${decision.nextPR} was not found in eligible candidates`);
      }

      options.renderer.write(formatStatusLine(decision, {
        action: `merging-#${candidate.number}`,
        lastPR: lastMergedPR,
      }));

      const result = await deps.executeMerge(candidate, { repoDir: options.repoDir });
      if (result.status === 'merged') {
        lastMergedPR = result.prNumber;
      }

      options.renderer.write(formatStatusLine(decision, {
        action: statusActionForResult(result.status, result.prNumber),
        lastPR: lastMergedPR,
      }));

      consecutiveFailures = 0;
      consecutiveUnknown = 0;
      lastError = null;
      lastErrorAt = null;
      await deps.writeHeartbeat(options.repoDir, {
        failureCount: consecutiveFailures,
        lastError,
        lastErrorAt,
        timestamp: deps.now().toISOString(),
      });

      if (result.haltLoop) {
        options.renderer.finalize();
        return { reason: 'halted', lastMergedPR };
      }

      await deps.sleep(intervalMs);
    } catch (error) {
      const classification = classifyTendLoopError(error);
      if (classification === 'terminal') {
        throw error;
      }

      consecutiveFailures += 1;
      if (classification === 'unknown') {
        consecutiveUnknown += 1;
      } else {
        consecutiveUnknown = 0;
      }

      if (consecutiveUnknown >= maxUnknown) {
        options.renderer.write(formatLoopErrorLine({
          classification,
          consecutiveFailures,
          retryInMs: 0,
          lastPR: lastMergedPR,
          message: errorMessage(error),
        }));
        throw error;
      }

      const retryInMs = tendLoopBackoffMs(consecutiveFailures, {
        baseMs: options.errorBackoffBaseMs ?? TEND_LOOP_ERROR_BACKOFF_BASE_MS,
        maxMs: options.errorBackoffMaxMs ?? TEND_LOOP_ERROR_BACKOFF_MAX_MS,
        random: deps.random,
      });
      lastError = `${classification}: ${truncateOneLine(errorMessage(error), 200)}`;
      lastErrorAt = deps.now().toISOString();
      options.renderer.write(formatLoopErrorLine({
        classification,
        consecutiveFailures,
        retryInMs,
        lastPR: lastMergedPR,
        message: errorMessage(error),
      }));
      if (classification === 'unknown') {
        deps.log(`tend: unknown loop error: ${errorStack(error)}`);
      }
      await deps.writeHeartbeat(options.repoDir, {
        failureCount: consecutiveFailures,
        lastError,
        lastErrorAt,
        timestamp: deps.now().toISOString(),
      });
      await deps.sleep(retryInMs);
    }
  }
}

export function classifyTendLoopError(error: unknown): TendLoopErrorClass {
  if (isTransientError(error)) {
    return 'transient';
  }
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
    return 'terminal';
  }
  const message = errorMessage(error);
  if (TERMINAL_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'terminal';
  }
  return 'unknown';
}

export function tendLoopBackoffMs(
  consecutiveFailures: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  return computeBackoffDelayMs(consecutiveFailures, {
    baseMs: options.baseMs ?? TEND_LOOP_ERROR_BACKOFF_BASE_MS,
    maxMs: options.maxMs ?? TEND_LOOP_ERROR_BACKOFF_MAX_MS,
    random: options.random,
  });
}

export function formatLoopErrorLine(options: {
  classification: TendLoopErrorClass;
  consecutiveFailures: number;
  retryInMs: number;
  lastPR: number | null;
  message: string;
}): string {
  const retrySeconds = Math.ceil(options.retryInMs / 1000);
  const last = typeof options.lastPR === 'number' ? `#${options.lastPR}` : 'none';
  return [
    `error=${options.classification}`,
    `consecutive=${options.consecutiveFailures}`,
    `retry_in=${retrySeconds}s`,
    `last=${last}`,
    `detail=${truncateOneLine(options.message, 200)}`,
  ].join(' ');
}

export async function writeTendHeartbeat(
  repoDir: string,
  timestamp: string,
  health: { failureCount: number; lastError: string | null; lastErrorAt: string | null },
): Promise<void> {
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
        failureCount: health.failureCount,
        lastError: health.lastError,
        lastErrorAt: health.lastErrorAt,
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

export async function writeTendHeartbeatBestEffort(
  repoDir: string,
  options: {
    failureCount?: number;
    lastError?: string | null;
    lastErrorAt?: string | null;
    timestamp?: string;
  } = {},
): Promise<void> {
  try {
    await writeTendHeartbeat(
      repoDir,
      options.timestamp ?? new Date().toISOString(),
      {
        failureCount: options.failureCount ?? 0,
        lastError: options.lastError ?? null,
        lastErrorAt: options.lastErrorAt ?? null,
      },
    );
  } catch (error) {
    console.error(`tend: failed to write heartbeat: ${errorMessage(error)}`);
  }
}

function tendLoopDeps(overrides: Partial<TendLoopDeps> | undefined): TendLoopDeps {
  return {
    selectNextCandidate,
    executeMerge,
    writeHeartbeat: writeTendHeartbeatBestEffort,
    sleep,
    now: () => new Date(),
    log: (line) => console.error(line),
    random: Math.random,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateOneLine(message: string, maxLength: number): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 3)}...` : oneLine;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : errorMessage(error);
}
