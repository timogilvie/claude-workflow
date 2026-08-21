import { NoComparisonReason, StoredChallengeComparison, deriveNoComparisonReason, NO_COMPARISON_REASONS } from './challenge-comparison.ts';
import { readChallengeRecordVoids, isChallengeRecordVoided } from './challenge-record-void.ts';

export interface NoComparisonReportReason {
  reason: NoComparisonReason;
  count: number;
  rate: number;
  pairs: string[];
}

export interface NoComparisonReport {
  launchedPairs: number;
  phantomPairs: number;
  comparedPairs: number;
  skipRate: number;
  noComparisonRate: number;
  unknownReasonCount: number;
  byReason: Map<NoComparisonReason, NoComparisonReportReason>;
  unrecordedPairs?: Array<{ pairId: string; evalCount: number }>;
}

export function buildNoComparisonReport(options: {
  comparisons: StoredChallengeComparison[];
  voids?: Map<string, string>;
  evals?: Array<{ challengePairId?: string }>;
  since?: Date;
  until?: Date;
}): NoComparisonReport {
  const { comparisons, voids = new Map(), evals, since, until } = options;

  // Dedupe per challengePairId (latest timestamp, skip voided, honour supersedes)
  const pairsMap = new Map<string, StoredChallengeComparison>();
  for (const record of comparisons) {
    // Check if this record is voided
    if (isChallengeRecordVoided({
      challengePairId: record.challengePairId,
      recordTimestamp: record.timestamp,
      voids: voids,
    })) {
      continue;
    }

    const existing = pairsMap.get(record.challengePairId);
    if (!existing) {
      pairsMap.set(record.challengePairId, record);
    } else if ((existing.supersedes?.timestamp ?? '') < record.timestamp) {
      pairsMap.set(record.challengePairId, record);
    }
  }

  const records = Array.from(pairsMap.values());

  // Filter by date range if provided
  let filteredRecords = records;
  if (since || until) {
    filteredRecords = records.filter((r) => {
      const ts = new Date(r.timestamp);
      if (since && ts < since) return false;
      if (until && ts > until) return false;
      return true;
    });
  }

  // Classify pairs
  let launchedPairs = 0;
  let comparedPairs = 0;
  let phantomPairs = 0;
  const reasonCounts = new Map<NoComparisonReason, Array<string>>();
  let unknownCount = 0;

  for (const record of filteredRecords) {
    // Phantom pair heuristic: orphan_pair with challengerPrUrl ending /pull/0 and challengerModel==='unknown'
    const isPhantom = record.terminalReason === 'orphan_pair'
      && record.challengerPrUrl?.endsWith('/pull/0')
      && record.challengerModel === 'unknown';

    if (isPhantom) {
      phantomPairs += 1;
    } else {
      launchedPairs += 1;
    }

    if (record.comparisonOutcome === 'compared') {
      comparedPairs += 1;
      continue;
    }

    const reason = deriveNoComparisonReason(record) ?? 'unknown';
    if (reason === 'unknown') {
      unknownCount += 1;
    }

    const reasonList = reasonCounts.get(reason) ?? [];
    reasonList.push(record.challengePairId);
    reasonCounts.set(reason, reasonList);
  }

  // Build reason report
  const byReason = new Map<NoComparisonReason, NoComparisonReportReason>();
  for (const [reason, pairs] of reasonCounts) {
    const rate = launchedPairs > 0 ? (pairs.length / launchedPairs) : 0;
    byReason.set(reason, {
      reason,
      count: pairs.length,
      rate,
      pairs,
    });
  }

  // Unrecorded pairs: pairs with evals but no comparison record
  let unrecordedPairs: Array<{ pairId: string; evalCount: number }> | undefined;
  if (evals) {
    const evalPairIds = new Set(evals.map((e) => e.challengePairId).filter(Boolean) as string[]);
    const recordedPairIds = new Set(records.map((r) => r.challengePairId));
    const unrecorded = Array.from(evalPairIds).filter((id) => !recordedPairIds.has(id));
    if (unrecorded.length > 0) {
      unrecordedPairs = unrecorded.map((pairId) => {
        const evalCount = evals.filter((e) => e.challengePairId === pairId).length;
        return { pairId, evalCount };
      });
    }
  }

  const skipRate = launchedPairs > 0 ? ((reasonCounts.get('skipped')?.length ?? 0) + (reasonCounts.get('invalid_challenge')?.length ?? 0)) / launchedPairs : 0;
  const noComparisonRate = launchedPairs > 0 ? (launchedPairs - comparedPairs) / launchedPairs : 0;

  return {
    launchedPairs,
    phantomPairs,
    comparedPairs,
    skipRate,
    noComparisonRate,
    unknownReasonCount: unknownCount,
    byReason,
    ...(unrecordedPairs ? { unrecordedPairs } : {}),
  };
}

export function formatNoComparisonReportText(report: NoComparisonReport): string {
  const lines: string[] = [];

  lines.push(`# No-Comparison Report`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Launched pairs: ${report.launchedPairs}`);
  lines.push(`- Phantom pairs: ${report.phantomPairs} (excluded from launched-pair denominator)`);
  lines.push(`- Compared pairs: ${report.comparedPairs}`);
  lines.push(`- Skip rate: ${(report.skipRate * 100).toFixed(2)}%`);
  lines.push(`- No-comparison rate: ${(report.noComparisonRate * 100).toFixed(2)}%`);
  if (report.unknownReasonCount > 0) {
    lines.push(`- ⚠️  Unknown reason count: ${report.unknownReasonCount}`);
  }
  lines.push('');

  if (report.byReason.size > 0) {
    lines.push('## Reasons (by count)');
    lines.push('');
    const sorted = Array.from(report.byReason.values())
      .sort((a, b) => b.count - a.count);

    for (const item of sorted) {
      lines.push(`### ${item.reason}`);
      lines.push(`- Count: ${item.count}`);
      lines.push(`- Rate: ${(item.rate * 100).toFixed(2)}%`);
      if (item.pairs.length <= 5) {
        lines.push(`- Pairs: ${item.pairs.join(', ')}`);
      } else {
        lines.push(`- Pairs (first 5): ${item.pairs.slice(0, 5).join(', ')}`);
        lines.push(`- ... and ${item.pairs.length - 5} more`);
      }
      lines.push('');
    }
  }

  if (report.unrecordedPairs && report.unrecordedPairs.length > 0) {
    lines.push('## Unrecorded Pairs (evals exist but no comparison record)');
    lines.push('');
    for (const item of report.unrecordedPairs) {
      lines.push(`- ${item.pairId} (${item.evalCount} evals)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatNoComparisonReportJson(report: NoComparisonReport): Record<string, unknown> {
  return {
    launchedPairs: report.launchedPairs,
    phantomPairs: report.phantomPairs,
    comparedPairs: report.comparedPairs,
    skipRate: report.skipRate,
    noComparisonRate: report.noComparisonRate,
    unknownReasonCount: report.unknownReasonCount,
    byReason: Object.fromEntries(
      Array.from(report.byReason.values()).map((item) => [
        item.reason,
        {
          count: item.count,
          rate: item.rate,
          pairs: item.pairs,
        },
      ])
    ),
    ...(report.unrecordedPairs ? { unrecordedPairs: report.unrecordedPairs } : {}),
  };
}
