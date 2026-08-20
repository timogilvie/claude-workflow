#!/usr/bin/env -S npx tsx

/**
 * Backfill top-level challengeStage on challenge eval records.
 *
 * This tool only writes a stage when it can recover one from persisted intent
 * or challenge pair records. Unrecoverable challenge records are explicitly
 * marked with missing_challenge_stage and are never defaulted to implementation.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import type { ChallengeStage } from '../shared/lib/challenge-mode.ts';

const VALID_STAGES: readonly ChallengeStage[] = ['plan', 'implementation', 'review'];
const VALID_STAGE_SET = new Set<string>(VALID_STAGES);
const MISSING_STAGE_CODE = 'missing_challenge_stage';

type JsonRecord = Record<string, unknown>;

interface EvalRecordForBackfill extends JsonRecord {
  challengePairId?: string;
  challengeStage?: ChallengeStage;
  challengeSide?: 'primary' | 'challenger';
  challengeIntent?: {
    challengeStage?: unknown;
    selectedStage?: unknown;
    primary?: { challengeStage?: unknown };
    challenger?: { challengeStage?: unknown };
  };
  eligibilityErrors?: string[];
}

interface ChallengePairRecord {
  challengePairId?: string;
  variedStage?: unknown;
  challengeType?: unknown;
}

export interface ChallengeStageBackfillSummary {
  file: string;
  total: number;
  already_had_stage: number;
  recovered_from_intent: number;
  recovered_from_pair_records: number;
  unrecoverable: number;
  disagreements: number;
  disagreementPairIds: string[];
  changed: number;
}

interface PairStageIndexEntry {
  stage?: ChallengeStage;
  disagreement: boolean;
  stages: Set<ChallengeStage>;
}

const DEFAULT_TARGETS = [
  resolve(process.cwd(), '.wavemill/evals/evals.jsonl'),
  '/Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/evals.jsonl',
  '/Users/timothyogilvie/Dropbox/Hokusai/hokusai-infrastructure/.wavemill/evals/evals.jsonl',
];

function isChallengeStage(value: unknown): value is ChallengeStage {
  return typeof value === 'string' && VALID_STAGE_SET.has(value);
}

function stageFromChallengeType(value: unknown): ChallengeStage | undefined {
  if (value === 'planner-only') return 'plan';
  if (value === 'coder-only') return 'implementation';
  if (value === 'reviewer-only') return 'review';
  return undefined;
}

function recoverStageFromIntent(record: EvalRecordForBackfill): ChallengeStage | undefined {
  const intent = record.challengeIntent;
  if (!intent) return undefined;
  if (isChallengeStage(intent.challengeStage)) return intent.challengeStage;
  if (isChallengeStage(intent.selectedStage)) return intent.selectedStage;

  const sideIntent = record.challengeSide === 'challenger' ? intent.challenger : intent.primary;
  if (isChallengeStage(sideIntent?.challengeStage)) return sideIntent.challengeStage;
  if (isChallengeStage(intent.primary?.challengeStage)) return intent.primary.challengeStage;
  if (isChallengeStage(intent.challenger?.challengeStage)) return intent.challenger.challengeStage;
  return undefined;
}

function recoverStageFromPairRecord(record: ChallengePairRecord): ChallengeStage | undefined {
  if (isChallengeStage(record.variedStage)) return record.variedStage;
  return stageFromChallengeType(record.challengeType);
}

function loadPairStageIndex(evalsFile: string): Map<string, PairStageIndexEntry> {
  const challengeRecordsFile = join(dirname(evalsFile), 'challenge-records.jsonl');
  const index = new Map<string, PairStageIndexEntry>();
  if (!existsSync(challengeRecordsFile)) {
    return index;
  }

  for (const line of readFileSync(challengeRecordsFile, 'utf-8').split('\n')) {
    if (!line.trim()) continue;

    let record: ChallengePairRecord;
    try {
      record = JSON.parse(line) as ChallengePairRecord;
    } catch {
      continue;
    }

    if (!record.challengePairId) continue;
    const stage = recoverStageFromPairRecord(record);
    if (!stage) continue;

    const entry = index.get(record.challengePairId) ?? {
      disagreement: false,
      stages: new Set<ChallengeStage>(),
    };
    entry.stages.add(stage);
    entry.disagreement = entry.stages.size > 1;
    entry.stage = entry.disagreement ? undefined : stage;
    index.set(record.challengePairId, entry);
  }

  return index;
}

function removeMissingStageMarker(record: EvalRecordForBackfill): boolean {
  if (!Array.isArray(record.eligibilityErrors)) return false;
  if (!record.eligibilityErrors.includes(MISSING_STAGE_CODE)) return false;

  const next = record.eligibilityErrors.filter((code) => code !== MISSING_STAGE_CODE);
  if (next.length > 0) {
    record.eligibilityErrors = next;
  } else {
    delete record.eligibilityErrors;
  }
  return true;
}

function markMissingStage(record: EvalRecordForBackfill): boolean {
  const current = Array.isArray(record.eligibilityErrors) ? record.eligibilityErrors : [];
  if (current.includes(MISSING_STAGE_CODE)) return false;
  record.eligibilityErrors = [...current, MISSING_STAGE_CODE];
  return true;
}

function cloneRecord(record: EvalRecordForBackfill): EvalRecordForBackfill {
  return JSON.parse(JSON.stringify(record)) as EvalRecordForBackfill;
}

function recordsEqual(left: EvalRecordForBackfill, right: EvalRecordForBackfill): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function backfillChallengeStageFile(
  filePath: string,
  options: { dryRun?: boolean } = {},
): ChallengeStageBackfillSummary {
  const file = resolve(filePath);
  const content = readFileSync(file, 'utf-8');
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hasTrailingNewline) {
    lines.pop();
  }

  const pairStageIndex = loadPairStageIndex(file);
  const disagreementPairIds = new Set<string>();
  const output: string[] = [];
  const summary: ChallengeStageBackfillSummary = {
    file,
    total: 0,
    already_had_stage: 0,
    recovered_from_intent: 0,
    recovered_from_pair_records: 0,
    unrecoverable: 0,
    disagreements: 0,
    disagreementPairIds: [],
    changed: 0,
  };

  for (const line of lines) {
    if (!line.trim()) {
      output.push(line);
      continue;
    }

    let record: EvalRecordForBackfill;
    try {
      record = JSON.parse(line) as EvalRecordForBackfill;
    } catch {
      output.push(line);
      continue;
    }

    summary.total += 1;
    if (!record.challengePairId) {
      output.push(line);
      continue;
    }

    const before = cloneRecord(record);
    if (isChallengeStage(record.challengeStage)) {
      summary.already_had_stage += 1;
      removeMissingStageMarker(record);
    } else {
      const intentStage = recoverStageFromIntent(record);
      if (intentStage) {
        record.challengeStage = intentStage;
        removeMissingStageMarker(record);
        summary.recovered_from_intent += 1;
      } else {
        const pairStage = pairStageIndex.get(record.challengePairId);
        if (pairStage?.disagreement) {
          disagreementPairIds.add(record.challengePairId);
          summary.unrecoverable += 1;
          markMissingStage(record);
        } else if (pairStage?.stage) {
          record.challengeStage = pairStage.stage;
          removeMissingStageMarker(record);
          summary.recovered_from_pair_records += 1;
        } else {
          summary.unrecoverable += 1;
          markMissingStage(record);
        }
      }
    }

    if (!recordsEqual(before, record)) {
      summary.changed += 1;
      output.push(JSON.stringify(record));
    } else {
      output.push(line);
    }
  }

  summary.disagreementPairIds = [...disagreementPairIds].sort();
  summary.disagreements = summary.disagreementPairIds.length;

  if (!options.dryRun && summary.changed > 0) {
    writeFileSync(file, `${output.join('\n')}${hasTrailingNewline ? '\n' : ''}`, 'utf-8');
  }

  return summary;
}

function printSummary(summary: ChallengeStageBackfillSummary, dryRun: boolean): void {
  const prefix = dryRun ? '[dry-run]' : '[updated]';
  console.log(
    `${prefix} ${summary.file}: total=${summary.total} already_had_stage=${summary.already_had_stage} `
    + `recovered_from_intent=${summary.recovered_from_intent} `
    + `recovered_from_pair_records=${summary.recovered_from_pair_records} `
    + `unrecoverable=${summary.unrecoverable} disagreements=${summary.disagreements} `
    + `changed=${summary.changed}`,
  );
  if (summary.disagreementPairIds.length > 0) {
    console.log(`  disagreementPairIds=${summary.disagreementPairIds.join(',')}`);
  }
}

if (import.meta.main) {
  runTool({
    name: 'backfill-challenge-stage',
    description: 'Populate top-level challengeStage on challenge eval records without defaulting unknown stages',
    options: {
      file: { type: 'string', description: 'Specific JSONL file (otherwise backfills built-in defaults)' },
      'dry-run': { type: 'boolean', description: 'Report what would change without writing' },
    },
    examples: [
      'npx tsx tools/backfill-challenge-stage.ts --dry-run',
      'npx tsx tools/backfill-challenge-stage.ts',
      'npx tsx tools/backfill-challenge-stage.ts --file path/to/evals.jsonl',
    ],
    run({ args }) {
      const dryRun = Boolean(args['dry-run']);
      const targets = args.file ? [resolve(args.file as string)] : [...new Set(DEFAULT_TARGETS)];
      const overall: Omit<ChallengeStageBackfillSummary, 'file' | 'disagreementPairIds'> = {
        total: 0,
        already_had_stage: 0,
        recovered_from_intent: 0,
        recovered_from_pair_records: 0,
        unrecoverable: 0,
        disagreements: 0,
        changed: 0,
      };

      for (const target of targets) {
        if (!existsSync(target)) {
          console.log(`[skip] ${target} (not found)`);
          continue;
        }
        const summary = backfillChallengeStageFile(target, { dryRun });
        printSummary(summary, dryRun);
        overall.total += summary.total;
        overall.already_had_stage += summary.already_had_stage;
        overall.recovered_from_intent += summary.recovered_from_intent;
        overall.recovered_from_pair_records += summary.recovered_from_pair_records;
        overall.unrecoverable += summary.unrecoverable;
        overall.disagreements += summary.disagreements;
        overall.changed += summary.changed;
      }

      console.log('');
      console.log(
        `${dryRun ? 'Would update' : 'Updated'} challengeStage: total=${overall.total} `
        + `already_had_stage=${overall.already_had_stage} `
        + `recovered_from_intent=${overall.recovered_from_intent} `
        + `recovered_from_pair_records=${overall.recovered_from_pair_records} `
        + `unrecoverable=${overall.unrecoverable} disagreements=${overall.disagreements} `
        + `changed=${overall.changed}`,
      );
    },
  });
}
