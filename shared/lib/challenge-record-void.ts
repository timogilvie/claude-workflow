import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendJsonlRecord, readJsonlFile } from './jsonl-utils.ts';

export const CHALLENGE_RECORD_VOIDS_FILENAME = 'challenge-record-voids.jsonl';

export interface ChallengeRecordVoid {
  challengePairId: string;
  voidedAt: string;
  reason: string;
  recordTimestamp: string;
}

function resolveVoidsFile(dir: string): string {
  return join(resolve(dir), CHALLENGE_RECORD_VOIDS_FILENAME);
}

export function appendChallengeRecordVoid(record: ChallengeRecordVoid, dir: string): void {
  appendJsonlRecord(resolveVoidsFile(dir), record);
}

export function readChallengeRecordVoids(dir: string): ChallengeRecordVoid[] {
  const filePath = resolveVoidsFile(dir);
  if (!existsSync(filePath)) {
    return [];
  }
  return readJsonlFile<ChallengeRecordVoid>(filePath);
}

export function isChallengeRecordVoided(input: {
  challengePairId: string;
  recordTimestamp?: string;
  voids: readonly ChallengeRecordVoid[];
}): boolean {
  const recordTimestamp = input.recordTimestamp ?? '';
  return input.voids.some((voidRecord) => (
    voidRecord.challengePairId === input.challengePairId
    && (recordTimestamp === '' || voidRecord.recordTimestamp >= recordTimestamp)
  ));
}
