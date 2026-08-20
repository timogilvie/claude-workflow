import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorMessage } from './error-utils.ts';
import { resolveHokusaiQueuePaths } from './hokusai-queue-paths.ts';

export type HokusaiTriggerLogStatus = 'disabled' | 'not_eligible' | 'enqueued' | 'duplicate' | 'failed';

export interface HokusaiTriggerLogEntry {
  at: string;
  evalId?: string;
  issueId?: string;
  status: HokusaiTriggerLogStatus;
  reasons?: string[];
  source?: string;
  detail?: string;
}

export interface HokusaiTriggerLogSummary {
  counts: Record<HokusaiTriggerLogStatus, number>;
  blocked: number;
  firstBlockedAt?: string;
  lastBlockedAt?: string;
  lastEnqueuedAt?: string;
  disabledSources: string[];
}

function emptyCounts(): Record<HokusaiTriggerLogStatus, number> {
  return {
    disabled: 0,
    not_eligible: 0,
    enqueued: 0,
    duplicate: 0,
    failed: 0,
  };
}

function isTriggerLogStatus(value: unknown): value is HokusaiTriggerLogStatus {
  return value === 'disabled'
    || value === 'not_eligible'
    || value === 'enqueued'
    || value === 'duplicate'
    || value === 'failed';
}

function parseEntry(line: string): HokusaiTriggerLogEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<HokusaiTriggerLogEntry>;
    if (typeof parsed.at !== 'string' || !isTriggerLogStatus(parsed.status)) {
      return null;
    }
    return parsed as HokusaiTriggerLogEntry;
  } catch {
    return null;
  }
}

export function appendTriggerLogEntry(entry: HokusaiTriggerLogEntry, repoDir?: string): void {
  const path = resolveHokusaiQueuePaths(repoDir).triggerLogPath;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (error) {
    console.warn(`[hokusai] failed to append trigger log: ${errorMessage(error)}`);
  }
}

export function summarizeTriggerLog(
  repoDir?: string,
  options: { sinceDays?: number; now?: Date } = {},
): HokusaiTriggerLogSummary | null {
  const path = resolveHokusaiQueuePaths(repoDir).triggerLogPath;
  if (!existsSync(path)) {
    return null;
  }

  const sinceDays = options.sinceDays ?? 14;
  const nowMs = (options.now ?? new Date()).getTime();
  const sinceMs = nowMs - sinceDays * 24 * 60 * 60 * 1000;
  const counts = emptyCounts();
  const disabledSources = new Set<string>();
  let firstBlockedAt: string | undefined;
  let lastBlockedAt: string | undefined;
  let lastEnqueuedAt: string | undefined;

  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const entry = parseEntry(line);
    if (!entry) {
      continue;
    }
    const atMs = new Date(entry.at).getTime();
    if (!Number.isFinite(atMs) || atMs < sinceMs || atMs > nowMs) {
      continue;
    }

    counts[entry.status] += 1;
    if (entry.status === 'disabled' || entry.status === 'failed') {
      if (!firstBlockedAt || entry.at < firstBlockedAt) {
        firstBlockedAt = entry.at;
      }
      if (!lastBlockedAt || entry.at > lastBlockedAt) {
        lastBlockedAt = entry.at;
      }
      if (entry.status === 'disabled' && entry.source) {
        disabledSources.add(entry.source);
      }
    }
    if (entry.status === 'enqueued' && (!lastEnqueuedAt || entry.at > lastEnqueuedAt)) {
      lastEnqueuedAt = entry.at;
    }
  }

  return {
    counts,
    blocked: counts.disabled + counts.failed,
    ...(firstBlockedAt ? { firstBlockedAt } : {}),
    ...(lastBlockedAt ? { lastBlockedAt } : {}),
    ...(lastEnqueuedAt ? { lastEnqueuedAt } : {}),
    disabledSources: [...disabledSources].sort(),
  };
}
