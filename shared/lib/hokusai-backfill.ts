/**
 * Re-submit eval records whose Hokusai enqueue was skipped.
 *
 * On 2026-08-17/18 the user-level consent store (`~/.wavemill/config.json`) was
 * left disabled while the repo config said enabled, so `enqueueContribution`
 * refused every record with a bare `disabled`. The eval records themselves
 * persisted normally, so the submissions are recoverable from `evals.jsonl`.
 *
 * Deliberately routes through `triggerHokusaiSubmission` rather than building
 * rows directly: eligibility, redaction and the contribution projection are all
 * decided by the same code the live path uses, so a backfilled row cannot
 * diverge from a normally-submitted one. Enqueue is content-idempotent, so
 * re-running reports `duplicate` instead of double-submitting.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalRecord } from './eval-schema.ts';
import {
  formatHokusaiSubmissionTriggerResult,
  triggerHokusaiSubmission,
} from './hokusai-submission-trigger.ts';
import { toHokusaiSubmission } from './hokusai-schema.ts';
import { getHokusaiSubmissionConfig, getHokusaiSubmissionEnableSources } from './config.ts';

export interface HokusaiBackfillOptions {
  repoDir: string;
  /** Inclusive ISO date (YYYY-MM-DD) lower bound on record timestamp. */
  since?: string;
  /** Inclusive ISO date (YYYY-MM-DD) upper bound on record timestamp. */
  until?: string;
  /** Restrict to specific eval record ids. */
  ids?: string[];
  apply?: boolean;
}

export interface HokusaiBackfillRecordResult {
  id: string;
  issueId: string;
  timestamp: string;
  status: string;
}

export interface HokusaiBackfillSummary {
  applied: boolean;
  scanned: number;
  selected: number;
  results: HokusaiBackfillRecordResult[];
  counts: Record<string, number>;
}

function readEvalRecords(repoDir: string): EvalRecord[] {
  const path = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  const out: EvalRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as EvalRecord);
    } catch {
      // A malformed historical line is not a record to resubmit.
    }
  }
  return out;
}

export function selectBackfillRecords(
  records: readonly EvalRecord[],
  options: Pick<HokusaiBackfillOptions, 'since' | 'until' | 'ids'>,
): EvalRecord[] {
  const ids = options.ids && options.ids.length > 0 ? new Set(options.ids) : null;
  return records.filter((record) => {
    if (ids) return typeof record.id === 'string' && ids.has(record.id);
    const day = String(record.timestamp ?? '').slice(0, 10);
    if (!day) return false;
    if (options.since && day < options.since) return false;
    if (options.until && day > options.until) return false;
    return true;
  });
}

export async function backfillHokusaiSubmissions(
  options: HokusaiBackfillOptions,
): Promise<HokusaiBackfillSummary> {
  const { repoDir, apply = false } = options;
  if (!options.ids?.length && !options.since && !options.until) {
    throw new Error('hokusai-backfill requires --since/--until or --ids; refusing to resubmit the entire corpus');
  }

  const all = readEvalRecords(repoDir);
  const selected = selectBackfillRecords(all, options);
  const results: HokusaiBackfillRecordResult[] = [];
  const counts: Record<string, number> = {};

  for (const record of selected) {
    let status: string;
    if (!apply) {
      // Run the same gates the live path applies, so the preview reports what
      // would really happen rather than assuming every selected record lands.
      if (getHokusaiSubmissionConfig(repoDir).enabled !== true) {
        const sources = getHokusaiSubmissionEnableSources(repoDir);
        status = `would-skip: submission disabled (repo_config: hokusai.dataSubmission.enabled resolved false for repoDir=${repoDir} (base=${sources.baseEnabled ?? 'unset'} local=${sources.localEnabled ?? 'unset'}))`;
      } else {
        const eligibility = toHokusaiSubmission(record);
        status = eligibility.ok
          ? 'would-submit'
          : `would-skip: not eligible (${eligibility.reasons.join(', ') || 'no reason provided'})`;
      }
    } else {
      try {
        status = formatHokusaiSubmissionTriggerResult(
          await triggerHokusaiSubmission(record, { repoDir }),
        );
      } catch (error) {
        status = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    counts[status] = (counts[status] ?? 0) + 1;
    results.push({
      id: String(record.id ?? ''),
      issueId: String(record.issueId ?? ''),
      timestamp: String(record.timestamp ?? ''),
      status,
    });
  }

  return { applied: apply, scanned: all.length, selected: selected.length, results, counts };
}
