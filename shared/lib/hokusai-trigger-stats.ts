import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';
import { resolveHokusaiQueuePaths } from './hokusai-queue-paths.ts';
import type { HokusaiSubmissionTriggerResult } from './hokusai-submission-trigger.ts';
import { errorMessage } from './error-utils.ts';

type TriggerStatus = 'enqueued' | 'disabled' | 'not_eligible' | 'duplicate' | 'failed';

export interface HokusaiTriggerStats {
  schemaVersion: '1.0';
  counts: Record<TriggerStatus, number>;
  lastAt: Partial<Record<TriggerStatus, string>>;
  lastDisabled?: { at: string; reason: string };
  lastNotEligible?: { at: string; reasons: string[] };
}

function initialStats(): HokusaiTriggerStats {
  return {
    schemaVersion: '1.0',
    counts: {
      enqueued: 0,
      disabled: 0,
      not_eligible: 0,
      duplicate: 0,
      failed: 0,
    },
    lastAt: {},
  };
}

export async function recordTriggerOutcome(
  result: HokusaiSubmissionTriggerResult,
  opts: { repoDir: string; now?: Date },
): Promise<void> {
  try {
    const now = opts.now ?? new Date();
    const timestamp = now.toISOString();
    const paths = resolveHokusaiQueuePaths(opts.repoDir);

    await mutateJsonState<HokusaiTriggerStats>(
      paths.triggerStatsPath,
      (current) => {
        const status = result.status;
        const updated = { ...current };

        updated.counts[status] = (updated.counts[status] ?? 0) + 1;
        updated.lastAt[status] = timestamp;

        if (status === 'disabled') {
          updated.lastDisabled = {
            at: timestamp,
            reason: result.reason,
          };
        }

        if (status === 'not_eligible') {
          updated.lastNotEligible = {
            at: timestamp,
            reasons: result.reasons,
          };
        }

        return updated;
      },
      { createIfMissing: true, initial: initialStats() },
    );
  } catch (error) {
    console.warn(`[hokusai] Failed to record trigger outcome: ${errorMessage(error)}`);
  }
}

export function readTriggerStats(opts: { repoDir?: string } = {}): HokusaiTriggerStats | null {
  try {
    const paths = resolveHokusaiQueuePaths(opts.repoDir);
    if (!existsSync(paths.triggerStatsPath)) {
      return null;
    }

    const content = readFileSync(paths.triggerStatsPath, 'utf-8');
    const parsed = JSON.parse(content) as HokusaiTriggerStats;
    return parsed && typeof parsed === 'object' && 'counts' in parsed ? parsed : null;
  } catch {
    return null;
  }
}

export function summarizeTriggerStats(stats: HokusaiTriggerStats): { lines: string[]; warnings: string[] } {
  const lines: string[] = [];
  const warnings: string[] = [];

  const counts = stats.counts;
  lines.push(
    `Trigger outcomes: enqueued=${counts.enqueued} disabled=${counts.disabled} not_eligible=${counts.not_eligible} duplicate=${counts.duplicate} failed=${counts.failed}`,
  );

  const lastEnqueued = stats.lastAt.enqueued ? `Last enqueued: ${stats.lastAt.enqueued}` : '';
  const lastDisabledLine = stats.lastDisabled
    ? `Last disabled: ${stats.lastDisabled.at} (${stats.lastDisabled.reason})`
    : '';

  if (lastEnqueued || lastDisabledLine) {
    lines.push([lastEnqueued, lastDisabledLine].filter(Boolean).join(' | '));
  }

  if (stats.lastDisabled && stats.lastAt.enqueued) {
    const lastDisabledTime = new Date(stats.lastDisabled.at).getTime();
    const lastEnqueuedTime = new Date(stats.lastAt.enqueued).getTime();
    if (lastDisabledTime > lastEnqueuedTime) {
      warnings.push(
        `WARNING: most recent trigger outcome was 'disabled' — submissions are being skipped.`,
      );
    }
  } else if (stats.lastDisabled && !stats.lastAt.enqueued) {
    warnings.push(
      `WARNING: most recent trigger outcome was 'disabled' — submissions are being skipped.`,
    );
  }

  return { lines, warnings };
}
