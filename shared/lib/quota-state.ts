import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { errorMessage } from './error-utils.ts';
import { resolveFromMainRepo } from './git-utils.ts';

export type QuotaStatus = 'healthy' | 'degrading' | 'exhausted';

export interface QuotaEntry {
  status: QuotaStatus;
  remainingEstimate: number | null;
  resetAt: string | null;
  confidence: number;
  lastLimitErrorAt: string | null;
  lastSuccessAt: string | null;
  lastReason: string | null;
}

export interface QuotaSnapshot {
  models: Readonly<Record<string, Readonly<QuotaEntry>>>;
  snapshotAt: string;
}

export interface LimitErrorInput {
  modelId: string;
  resetAt?: string | Date | null;
  remainingEstimate?: number | null;
  reason?: string;
}

export interface SuccessInput {
  modelId: string;
}

interface StoredQuotaEntry extends QuotaEntry {
  consecutiveLimitErrors: number;
}

interface QuotaStateFile {
  version: number;
  updatedAt: string;
  models: Record<string, StoredQuotaEntry>;
}

interface LoadedQuotaState {
  state: QuotaStateFile;
  writeAllowed: boolean;
}

interface StatePaths {
  statePath: string;
  lockPath: string;
}

interface LockHandle {
  fd: number;
  lockPath: string;
}

const QUOTA_STATE_VERSION = 1;
export const QUOTA_STATE_TIMINGS = {
  HEALTHY_DECAY_MS: 5 * 60_000,
  DEGRADING_DECAY_MS: 10 * 60_000,
  EXHAUSTED_DECAY_MS: 30 * 60_000,
  LOCK_ACQUIRE_TIMEOUT_MS: 2_000,
  STALE_LOCK_MS: 5_000,
};

let clock: (() => number) | null = null;

function now(): number {
  return clock ? clock() : Date.now();
}

export function __setClock(fn: () => number): void {
  clock = fn;
}

export function __resetClock(): void {
  clock = null;
}

function emptyState(nowMs = now()): QuotaStateFile {
  return {
    version: QUOTA_STATE_VERSION,
    updatedAt: new Date(nowMs).toISOString(),
    models: {},
  };
}

function resolveStatePaths(repoDir?: string): StatePaths {
  const statePath = resolveFromMainRepo('.wavemill/quota-state.json', repoDir);
  return {
    statePath,
    lockPath: join(dirname(statePath), 'quota-state.lock'),
  };
}

function parseIsoDate(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeIsoDate(value: string | Date | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function normalizeConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function normalizeRemainingEstimate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function normalizeStoredEntry(value: unknown): StoredQuotaEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<StoredQuotaEntry>;
  const status = candidate.status;
  if (status !== 'healthy' && status !== 'degrading' && status !== 'exhausted') {
    return null;
  }

  return {
    status,
    remainingEstimate: normalizeRemainingEstimate(candidate.remainingEstimate),
    resetAt: normalizeIsoDate(candidate.resetAt ?? null),
    confidence: normalizeConfidence(candidate.confidence),
    lastLimitErrorAt: normalizeIsoDate(candidate.lastLimitErrorAt ?? null),
    lastSuccessAt: normalizeIsoDate(candidate.lastSuccessAt ?? null),
    lastReason: typeof candidate.lastReason === 'string' ? candidate.lastReason : null,
    consecutiveLimitErrors: Number.isInteger(candidate.consecutiveLimitErrors)
      ? Math.max(0, candidate.consecutiveLimitErrors as number)
      : 0,
  };
}

function loadFile(repoDir?: string): LoadedQuotaState {
  const { statePath } = resolveStatePaths(repoDir);

  if (!existsSync(statePath)) {
    return {
      state: emptyState(),
      writeAllowed: true,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as Partial<QuotaStateFile>;

    if (!parsed || typeof parsed !== 'object') {
      return { state: emptyState(), writeAllowed: true };
    }

    if (typeof parsed.version === 'number' && parsed.version > QUOTA_STATE_VERSION) {
      console.warn(
        `Quota state file at ${statePath} uses unsupported version ${parsed.version}; refusing to modify it.`,
      );
      return { state: emptyState(), writeAllowed: false };
    }

    if (parsed.version !== QUOTA_STATE_VERSION) {
      return { state: emptyState(), writeAllowed: true };
    }

    const models = parsed.models && typeof parsed.models === 'object'
      ? Object.entries(parsed.models).reduce<Record<string, StoredQuotaEntry>>((acc, [modelId, entry]) => {
        const normalized = normalizeStoredEntry(entry);
        if (normalized) {
          acc[modelId] = normalized;
        }
        return acc;
      }, {})
      : {};

    return {
      state: {
        version: QUOTA_STATE_VERSION,
        updatedAt: normalizeIsoDate(parsed.updatedAt ?? null) ?? new Date(now()).toISOString(),
        models,
      },
      writeAllowed: true,
    };
  } catch {
    return { state: emptyState(), writeAllowed: true };
  }
}

function saveFile(state: QuotaStateFile, repoDir?: string): void {
  const { statePath } = resolveStatePaths(repoDir);
  const stateDir = dirname(statePath);
  const tmpPath = join(stateDir, `.quota-state.json.tmp-${process.pid}-${randomUUID()}`);

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, statePath);
}

function sleepMs(ms: number): void {
  // Note: Atomics.wait blocks the event loop, so this is only suitable for
  // short-lived lock-acquisition spin-waits. Not suitable for browsers or worker contexts.
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function readLockTimestamp(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as { acquiredAt?: string };
    return parseIsoDate(parsed.acquiredAt ?? null);
  } catch {
    return null;
  }
}

function acquireLock(repoDir?: string): LockHandle {
  const { lockPath } = resolveStatePaths(repoDir);
  const startMs = Date.now();
  const lockDir = dirname(lockPath);

  mkdirSync(lockDir, { recursive: true, mode: 0o700 });

  while (Date.now() - startMs <= QUOTA_STATE_TIMINGS.LOCK_ACQUIRE_TIMEOUT_MS) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date(now()).toISOString(),
      }), 'utf-8');
      return { fd, lockPath };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== 'EEXIST') {
        throw error;
      }

      const lockAge = readLockTimestamp(lockPath);
      if (lockAge == null || now() - lockAge > QUOTA_STATE_TIMINGS.STALE_LOCK_MS) {
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          const unlinkErrno = unlinkError as NodeJS.ErrnoException;
          if (unlinkErrno.code !== 'ENOENT') {
            throw unlinkError;
          }
        }
        continue;
      }

      const jitterMs = 10 + Math.floor(Math.random() * 41);
      sleepMs(jitterMs);
    }
  }

  throw new Error(`Timed out acquiring quota state lock at ${lockPath}`);
}

function releaseLock(handle: LockHandle): void {
  try {
    closeSync(handle.fd);
  } finally {
    try {
      unlinkSync(handle.lockPath);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function toPublicEntry(entry: StoredQuotaEntry): QuotaEntry {
  return {
    status: entry.status,
    remainingEstimate: entry.remainingEstimate,
    resetAt: entry.resetAt,
    confidence: entry.confidence,
    lastLimitErrorAt: entry.lastLimitErrorAt,
    lastSuccessAt: entry.lastSuccessAt,
    lastReason: entry.lastReason,
  };
}

function project(entry: StoredQuotaEntry, nowMs: number): StoredQuotaEntry {
  const resetAtMs = parseIsoDate(entry.resetAt);
  if (resetAtMs != null && nowMs >= resetAtMs) {
    return {
      ...entry,
      status: 'healthy',
      remainingEstimate: null,
      resetAt: null,
      confidence: 0.8,
      consecutiveLimitErrors: 0,
    };
  }

  const lastLimitErrorAtMs = parseIsoDate(entry.lastLimitErrorAt);
  if (lastLimitErrorAtMs == null) {
    return entry;
  }

  if (
    entry.status === 'degrading'
    && nowMs - lastLimitErrorAtMs > QUOTA_STATE_TIMINGS.DEGRADING_DECAY_MS
  ) {
    return {
      ...entry,
      status: 'healthy',
      confidence: 0.6,
      consecutiveLimitErrors: 0,
    };
  }

  if (
    entry.status === 'exhausted'
    && nowMs - lastLimitErrorAtMs > QUOTA_STATE_TIMINGS.EXHAUSTED_DECAY_MS
  ) {
    return {
      ...entry,
      status: 'degrading',
      confidence: 0.5,
      consecutiveLimitErrors: 0,
    };
  }

  return entry;
}

function mutateWithLock(repoDir: string | undefined, mutator: (state: QuotaStateFile) => boolean): void {
  const lock = acquireLock(repoDir);

  try {
    const loaded = loadFile(repoDir);
    if (!loaded.writeAllowed) {
      return;
    }

    const changed = mutator(loaded.state);
    if (!changed) {
      return;
    }

    loaded.state.updatedAt = new Date(now()).toISOString();
    saveFile(loaded.state, repoDir);
  } finally {
    releaseLock(lock);
  }
}

function freezeValue<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const nestedValue of Object.values(value as Record<string, unknown>)) {
    freezeValue(nestedValue);
  }

  return value;
}

function warnWriteFailure(action: string, error: unknown): void {
  console.warn(`Failed to ${action} quota state: ${errorMessage(error)}`);
}

export function readQuotaSnapshot(repoDir?: string): QuotaSnapshot {
  const { state } = loadFile(repoDir);
  const snapshotAt = new Date(now()).toISOString();
  const models = Object.entries(state.models).reduce<Record<string, Readonly<QuotaEntry>>>((acc, [modelId, entry]) => {
    acc[modelId] = freezeValue(toPublicEntry(project(entry, now())));
    return acc;
  }, {});

  return freezeValue({
    models,
    snapshotAt,
  });
}

export function getModelStatus(modelId: string, repoDir?: string): QuotaStatus {
  return readQuotaSnapshot(repoDir).models[modelId]?.status ?? 'healthy';
}

export function recordLimitError(input: LimitErrorInput, repoDir?: string): void {
  try {
    mutateWithLock(repoDir, (state) => {
      const current = state.models[input.modelId] ?? {
        status: 'healthy',
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: 0,
      };
      const effective = project(current, now());
      const lastLimitErrorAtMs = parseIsoDate(effective.lastLimitErrorAt);
      const lastWasRecent = lastLimitErrorAtMs != null
        && now() - lastLimitErrorAtMs <= QUOTA_STATE_TIMINGS.HEALTHY_DECAY_MS;
      const consecutiveLimitErrors = lastWasRecent
        ? effective.consecutiveLimitErrors + 1
        : 1;

      const nextStatus: QuotaStatus = effective.status === 'exhausted'
        ? 'exhausted'
        : consecutiveLimitErrors >= 2
          ? 'exhausted'
          : 'degrading';

      state.models[input.modelId] = {
        status: nextStatus,
        remainingEstimate: normalizeRemainingEstimate(input.remainingEstimate),
        resetAt: normalizeIsoDate(input.resetAt ?? null),
        confidence: nextStatus === 'degrading' ? 0.5 : 0.9,
        lastLimitErrorAt: new Date(now()).toISOString(),
        lastSuccessAt: effective.lastSuccessAt,
        lastReason: input.reason ?? null,
        consecutiveLimitErrors,
      };
      return true;
    });
  } catch (error) {
    warnWriteFailure('record limit-error', error);
  }
}

export function recordSuccess(input: SuccessInput, repoDir?: string): void {
  try {
    mutateWithLock(repoDir, (state) => {
      const current = state.models[input.modelId];
      const lastLimitErrorAt = current?.lastLimitErrorAt ?? null;

      state.models[input.modelId] = {
        status: 'healthy',
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt,
        lastSuccessAt: new Date(now()).toISOString(),
        lastReason: null,
        consecutiveLimitErrors: 0,
      };
      return true;
    });
  } catch (error) {
    warnWriteFailure('record success', error);
  }
}

export function compactQuotaState(repoDir?: string): void {
  try {
    mutateWithLock(repoDir, (state) => {
      let changed = false;
      const nextModels = Object.entries(state.models).reduce<Record<string, StoredQuotaEntry>>((acc, [modelId, entry]) => {
        const projected = project(entry, now());
        acc[modelId] = projected;

        if (JSON.stringify(projected) !== JSON.stringify(entry)) {
          changed = true;
        }

        return acc;
      }, {});

      if (!changed) {
        return false;
      }

      state.models = nextModels;
      return true;
    });
  } catch (error) {
    warnWriteFailure('compact', error);
  }
}

export function __resetQuotaStateTestState(): void {
  __resetClock();
  QUOTA_STATE_TIMINGS.HEALTHY_DECAY_MS = 5 * 60_000;
  QUOTA_STATE_TIMINGS.DEGRADING_DECAY_MS = 10 * 60_000;
  QUOTA_STATE_TIMINGS.EXHAUSTED_DECAY_MS = 30 * 60_000;
  QUOTA_STATE_TIMINGS.LOCK_ACQUIRE_TIMEOUT_MS = 2_000;
  QUOTA_STATE_TIMINGS.STALE_LOCK_MS = 5_000;
}
