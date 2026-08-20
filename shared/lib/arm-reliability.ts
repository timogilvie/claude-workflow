import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendJsonlRecord, readJsonlFile } from './jsonl-utils.ts';
import {
  classifyArmFault,
  isModelQualitySignal,
  parseAbortFailureKind,
  type ArmFaultClass,
  type ChallengeArmSide,
} from './arm-failure-taxonomy.ts';

const DEFAULT_EVALS_DIR = '.wavemill/evals';
const RELIABILITY_RECORDS_FILENAME = 'reliability-records.jsonl';

export interface ArmReliabilityRecord {
  schemaVersion: '1.0.0';
  id: string;
  timestamp: string;
  issueId: string;
  challengePairId: string;
  challengeRole: ChallengeArmSide;
  stage: string;
  model: string;
  completed: false;
  abortReason: string;
  failureKind: string | null;
  faultClass: ArmFaultClass;
  qualitySignalEligible: boolean;
  detail?: string;
  nextAction?: string;
  source: 'challenge_abort_pair';
}

export interface BuildArmReliabilityRecordInput {
  issueId: string;
  challengePairId: string;
  challengeRole: ChallengeArmSide;
  stage: string;
  model: string;
  abortReason: string;
  detail?: string;
  nextAction?: string;
  timestamp?: string;
  id?: string;
}

/**
 * Append-only reliability corpus for challenge arms that did not complete.
 *
 * These records are not EvalRecords and are not exported to Hokusai quality
 * submissions. They preserve failure evidence for reliability, eligibility, and
 * harness diagnostics while keeping harness/selection/unknown faults out of
 * model-quality routing feedback.
 */
export function buildArmReliabilityRecord(input: BuildArmReliabilityRecordInput): ArmReliabilityRecord {
  const failureKind = parseAbortFailureKind(input.abortReason);
  const faultClass = classifyArmFault({ failureKind, detail: input.detail });
  return {
    schemaVersion: '1.0.0',
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    issueId: input.issueId,
    challengePairId: input.challengePairId,
    challengeRole: input.challengeRole,
    stage: input.stage,
    model: input.model,
    completed: false,
    abortReason: input.abortReason,
    failureKind,
    faultClass,
    qualitySignalEligible: isModelQualitySignal(faultClass),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.nextAction ? { nextAction: input.nextAction } : {}),
    source: 'challenge_abort_pair',
  };
}

export function appendArmReliabilityRecord(
  input: BuildArmReliabilityRecordInput,
  dirOrRepo?: string,
): ArmReliabilityRecord {
  const record = buildArmReliabilityRecord(input);
  const filePath = resolveReliabilityRecordsFile(dirOrRepo);
  const existing = existsSync(filePath) ? readArmReliabilityRecords(dirOrRepo) : [];
  const duplicate = existing.some((candidate) =>
    candidate.issueId === record.issueId
    && candidate.challengePairId === record.challengePairId
    && candidate.challengeRole === record.challengeRole
    && candidate.abortReason === record.abortReason
    && candidate.stage === record.stage
  );
  if (!duplicate) {
    appendJsonlRecord(filePath, record);
  }
  return record;
}

export function readArmReliabilityRecords(dirOrRepo?: string): ArmReliabilityRecord[] {
  const filePath = resolveReliabilityRecordsFile(dirOrRepo);
  if (!existsSync(filePath)) {
    return [];
  }
  return readJsonlFile<ArmReliabilityRecord>(filePath);
}

export function resolveReliabilityRecordsFile(dirOrRepo?: string): string {
  const base = dirOrRepo ? resolve(dirOrRepo) : resolve(DEFAULT_EVALS_DIR);
  const evalsDir = base.endsWith(`${DEFAULT_EVALS_DIR}`) || base.endsWith('/evals')
    ? base
    : join(base, DEFAULT_EVALS_DIR);
  return join(evalsDir, RELIABILITY_RECORDS_FILENAME);
}
