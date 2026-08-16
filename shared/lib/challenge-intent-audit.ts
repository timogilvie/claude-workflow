/**
 * Challenge Intent Audit — business logic for backfill/quarantine tool.
 *
 * @module challenge-intent-audit
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalRecord, InvalidChallengeReason } from './eval-schema.ts';
import {
  attestEvalRecordChallengeExecution,
  enforceChallengeIntentPresence,
  type ChallengeExecutionAttestation,
} from './challenge-execution-contract.ts';
import { attachChallengeExecutionMetadata } from './eval-record-builder.ts';

export interface AuditResult {
  recordId: string;
  changed: boolean;
  action: 'quarantined' | 'already_marked' | 'clean' | 'missing_intent_quarantined' | 'unparseable';
  reason?: InvalidChallengeReason;
  details?: string;
}

export interface AuditSummary {
  scanned: number;
  quarantined: number;
  alreadyMarked: number;
  clean: number;
  missingIntentQuarantined: number;
  unparseable: number;
  results: AuditResult[];
}

export interface AuditOptions {
  filePath: string;
  repoDir?: string;
  dryRun?: boolean;
}

function parseJsonlLine(line: string): EvalRecord | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as EvalRecord;
  } catch {
    return null;
  }
}

function serializeRecord(record: EvalRecord): string {
  return JSON.stringify(record);
}

function isAlreadyMarkedInvalid(record: EvalRecord): boolean {
  return record.invalidChallenge === true;
}

function quarantineRecord(
  record: EvalRecord,
  reason: InvalidChallengeReason,
  details: string,
): void {
  record.invalidChallenge = true;
  record.challengeDivergenceReason = reason;
  record.trainingEligible = false;
  record.nonRewardReason = {
    code: 'INVALID_CHALLENGE',
    message: `Invalid challenge: ${reason} - ${details}`,
  };
}

function attachAttestation(
  record: EvalRecord,
  attestation: ChallengeExecutionAttestation,
): void {
  attachChallengeExecutionMetadata(record, {
    side: record.challengeSide,
    intent: record.challengeIntent,
    evidence: attestation,
  });
}

export function auditChallengeRecord(record: EvalRecord): AuditResult {
  const recordId = record.id ?? 'unknown';

  if (!record.challengePairId) {
    return { recordId, changed: false, action: 'clean' };
  }

  if (isAlreadyMarkedInvalid(record)) {
    return { recordId, changed: false, action: 'already_marked' };
  }

  if (!record.challengeIntent) {
    const wasMarked = enforceChallengeIntentPresence(record, record.challengePairId);
    if (wasMarked) {
      return {
        recordId,
        changed: true,
        action: 'missing_intent_quarantined',
        reason: 'missing_challenge_intent',
        details: 'No persisted intent for challenge pair',
      };
    }
    return { recordId, changed: false, action: 'clean' };
  }

  const attestation = attestEvalRecordChallengeExecution(record);

  if (!attestation) {
    return { recordId, changed: false, action: 'clean' };
  }

  attachAttestation(record, attestation);

  if (attestation.validity === 'invalid_challenge' && attestation.invalidReason) {
    quarantineRecord(record, attestation.invalidReason, attestation.invalidDetails ?? '');
    return {
      recordId,
      changed: true,
      action: 'quarantined',
      reason: attestation.invalidReason,
      details: attestation.invalidDetails,
    };
  }

  return { recordId, changed: false, action: 'clean' };
}

export function runChallengeIntentAudit(options: AuditOptions): AuditSummary {
  const { filePath, dryRun = false } = options;

  const content = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const lines = content.split('\n');

  const results: AuditResult[] = [];
  let scanned = 0;
  let quarantined = 0;
  let alreadyMarked = 0;
  let clean = 0;
  let missingIntentQuarantined = 0;
  let unparseable = 0;

  const outputLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      outputLines.push(line);
      continue;
    }

    const record = parseJsonlLine(line);
    if (!record) {
      outputLines.push(line);
      unparseable++;
      scanned++;
      results.push({ recordId: 'unparseable', changed: false, action: 'unparseable' });
      continue;
    }

    scanned++;
    const result = auditChallengeRecord(record);
    results.push(result);

    switch (result.action) {
      case 'quarantined':
        quarantined++;
        break;
      case 'already_marked':
        alreadyMarked++;
        break;
      case 'missing_intent_quarantined':
        missingIntentQuarantined++;
        break;
      case 'clean':
        clean++;
        break;
    }

    outputLines.push(serializeRecord(record));
  }

  if (!dryRun) {
    const outputContent = outputLines.join('\n');
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, outputContent, 'utf-8');
    renameSync(tmpPath, filePath);
  }

  return {
    scanned,
    quarantined,
    alreadyMarked,
    clean,
    missingIntentQuarantined,
    unparseable,
    results,
  };
}

export function resolveEvalsFilePath(repoDir?: string): string {
  const baseDir = repoDir ?? process.cwd();
  return join(baseDir, '.wavemill', 'evals', 'evals.jsonl');
}
