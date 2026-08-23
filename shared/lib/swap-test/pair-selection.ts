import type { ChallengeRecordVoid } from '../challenge-record-void.ts';
import { isChallengeRecordVoided } from '../challenge-record-void.ts';
import type { StoredChallengeComparison } from '../challenge-comparison.ts';

export interface PairSelectionLedger {
  inputRecords: number;
  includedBeforeDedupe: number;
  selectedPairs: number;
  duplicatesDropped: number;
  manualExcluded: number;
  nonVerdictExcluded: number;
  voidedExcluded: number;
}

export interface SelectedAdjudicatedPair {
  pairId: string;
  record: StoredChallengeComparison;
}

export interface PairSelectionResult {
  pairs: SelectedAdjudicatedPair[];
  ledger: PairSelectionLedger;
}

const NON_VERDICT_OUTCOMES = new Set([
  'forfeit',
  'double-forfeit',
  'skipped',
  'invalid',
  'invalid_challenge',
  'inconclusive',
]);

function hasRealVerdict(record: StoredChallengeComparison): boolean {
  return (
    (record.winner === 'primary' || record.winner === 'challenger')
    && Boolean(record.dimensions)
    && typeof record.rationale === 'string'
    && record.rationale.trim().length > 0
    && (record.comparisonOutcome === undefined || record.comparisonOutcome === 'compared')
  );
}

function isManualResolution(record: StoredChallengeComparison): boolean {
  const recordKind = (record as { recordKind?: unknown }).recordKind;
  return recordKind === 'manual' || /^Manual\b/.test(record.rationale || '');
}

export function selectAdjudicatedPairs(
  records: readonly StoredChallengeComparison[],
  voids: readonly ChallengeRecordVoid[] = [],
): PairSelectionResult {
  const ledger: PairSelectionLedger = {
    inputRecords: records.length,
    includedBeforeDedupe: 0,
    selectedPairs: 0,
    duplicatesDropped: 0,
    manualExcluded: 0,
    nonVerdictExcluded: 0,
    voidedExcluded: 0,
  };
  const latestByPair = new Map<string, StoredChallengeComparison>();

  for (const record of records) {
    if (!record.challengePairId) {
      ledger.nonVerdictExcluded++;
      continue;
    }
    if (isChallengeRecordVoided({
      challengePairId: record.challengePairId,
      recordTimestamp: record.timestamp,
      voids,
    })) {
      ledger.voidedExcluded++;
      continue;
    }
    if (isManualResolution(record)) {
      ledger.manualExcluded++;
      continue;
    }
    if (record.comparisonOutcome && NON_VERDICT_OUTCOMES.has(record.comparisonOutcome)) {
      ledger.nonVerdictExcluded++;
      continue;
    }
    if (!hasRealVerdict(record)) {
      ledger.nonVerdictExcluded++;
      continue;
    }

    ledger.includedBeforeDedupe++;
    const existing = latestByPair.get(record.challengePairId);
    if (!existing || Date.parse(record.timestamp || '') >= Date.parse(existing.timestamp || '')) {
      latestByPair.set(record.challengePairId, record);
    }
  }

  ledger.duplicatesDropped = ledger.includedBeforeDedupe - latestByPair.size;
  const pairs = [...latestByPair.values()]
    .sort((a, b) => a.challengePairId.localeCompare(b.challengePairId))
    .map((record) => ({
      pairId: record.challengePairId,
      record,
    }));
  ledger.selectedPairs = pairs.length;
  return { pairs, ledger };
}
