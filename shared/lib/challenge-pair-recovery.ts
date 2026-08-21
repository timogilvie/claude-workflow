/**
 * Narrow, append-only recovery for challenge pairs invalidated by attestation
 * or intent defects.
 *
 * Design constraints (these are safety properties, not preferences):
 *
 * - **Explicit pair IDs only.** There is no "recover everything" mode. The
 *   generic backfill path already showed how wide a blanket rewrite reaches
 *   (181 historical records), which is far broader than any single incident.
 * - **Append-only.** Original lines in `challenge-records.jsonl` and
 *   `evals.jsonl` are never rewritten or deleted. A recovered comparison is a
 *   *new* record carrying `supersedes`, so the invalid original stays readable.
 * - **Proof before supersession.** A superseding comparison is emitted only
 *   when both arms and an immutable intent can be proven from execution
 *   evidence. Anything short of that upholds the existing quarantine.
 *
 * The proof deliberately reads `.{stage}-result.json` — what the stage actually
 * executed — rather than `.phase-config.json`, which is what was *planned*.
 * Trusting phase-config is the original defect: it held the primary's reviewer
 * on both arms, so challenger attestation derived as `side: "primary"`.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';

export type ChallengeRecoveryVerdict = 'supersedable' | 'quarantine-upheld' | 'pair-not-found';

/** Challenge stage as recorded in intent, mapped to its stage-result filename. */
const STAGE_RESULT_FILE: Record<string, string> = {
  plan: '.planning-result.json',
  planning: '.planning-result.json',
  implementation: '.coding-result.json',
  coding: '.coding-result.json',
  review: '.review-result.json',
};

export interface ChallengeArmEvidence {
  side: 'primary' | 'challenger';
  issueId: string;
  /** Model that actually executed the challenge stage, per the stage result. */
  stageModel?: string;
  stageStatus?: string;
  stageResultPath?: string;
  prUrl?: string;
  evalScore?: number;
  intentCreatedAt?: string;
  intentStage?: string;
  proven: boolean;
  gaps: string[];
}

export interface ChallengeRecoveryAssessment {
  pairId: string;
  verdict: ChallengeRecoveryVerdict;
  challengeStage?: string;
  existingOutcome?: string;
  existingInvalidReason?: string;
  intentProven: boolean;
  arms: ChallengeArmEvidence[];
  blockers: string[];
  assessedAt: string;
}

export interface ChallengeRecoveryOptions {
  repoDir: string;
  pairIds: string[];
  apply?: boolean;
  now?: () => string;
}

export interface ChallengeRecoveryResult {
  assessments: ChallengeRecoveryAssessment[];
  auditPath: string;
  recordsPath: string;
  applied: boolean;
  auditEntriesWritten: number;
  supersedingRecordsWritten: number;
}

interface TaskState {
  slug?: string;
  linearIssueId?: string;
  challengePairId?: string;
  challengeRole?: string;
  challengeExecutionIntent?: {
    createdAt?: string;
    selectedStage?: string;
    challengeStage?: string;
  } | null;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A malformed historical line must never abort recovery; it is simply not evidence.
    }
  }
  return out;
}

/** Resolve the feature directory an arm executed in, if its worktree survives. */
function armFeatureDir(repoDir: string, task: TaskState | undefined): string | undefined {
  const slug = task?.slug;
  if (!slug) return undefined;
  const dir = join(repoDir, 'worktrees', slug, 'features', slug);
  return existsSync(dir) ? dir : undefined;
}

function collectArmEvidence(
  repoDir: string,
  side: 'primary' | 'challenger',
  issueId: string,
  task: TaskState | undefined,
  challengeStage: string | undefined,
  record: Record<string, unknown> | undefined,
  evals: Record<string, unknown>[],
): ChallengeArmEvidence {
  const gaps: string[] = [];
  const evidence: ChallengeArmEvidence = { side, issueId, proven: false, gaps };

  if (!task) {
    gaps.push(`no task state for ${issueId}`);
    return evidence;
  }

  const intent = task.challengeExecutionIntent ?? undefined;
  if (!intent?.createdAt) {
    gaps.push('no immutable challenge execution intent');
  } else {
    evidence.intentCreatedAt = intent.createdAt;
    evidence.intentStage = intent.selectedStage ?? intent.challengeStage;
  }

  const stageFile = challengeStage ? STAGE_RESULT_FILE[challengeStage] : undefined;
  if (!stageFile) {
    gaps.push(`unknown challenge stage "${challengeStage ?? ''}"`);
  } else {
    const featureDir = armFeatureDir(repoDir, task);
    if (!featureDir) {
      gaps.push('worktree evidence no longer on disk');
    } else {
      const path = join(featureDir, stageFile);
      const stageResult = readJson<{ status?: string; model?: string }>(path);
      if (!stageResult) {
        gaps.push(`missing ${stageFile}`);
      } else {
        evidence.stageResultPath = path;
        evidence.stageStatus = stageResult.status;
        evidence.stageModel = stageResult.model;
        if (stageResult.status !== 'completed') {
          gaps.push(`challenge stage did not complete (status=${stageResult.status ?? 'unknown'})`);
        }
        if (!stageResult.model) {
          gaps.push('stage result records no model');
        }
      }
    }
  }

  const prUrl = side === 'primary'
    ? (record?.primaryPrUrl as string | undefined)
    : (record?.challengerPrUrl as string | undefined);
  if (prUrl) evidence.prUrl = prUrl;

  const score = side === 'primary'
    ? (record?.primaryEvalScore as number | undefined)
    : (record?.challengerEvalScore as number | undefined);
  if (typeof score === 'number') {
    evidence.evalScore = score;
  } else {
    gaps.push('no eval score recorded');
  }

  // The arm's own eval record is corroborating evidence that it ran at all.
  if (prUrl && !evals.some((e) => e.prUrl === prUrl)) {
    gaps.push(`no eval record referencing ${prUrl}`);
  }

  evidence.proven = gaps.length === 0;
  return evidence;
}

export function assessChallengePair(
  repoDir: string,
  pairId: string,
  now: () => string = () => new Date().toISOString(),
): ChallengeRecoveryAssessment {
  const statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  const recordsPath = join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl');
  const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');

  const state = readJson<{ tasks?: Record<string, TaskState> }>(statePath);
  const tasks = state?.tasks ?? {};
  const records = readJsonl<Record<string, unknown>>(recordsPath);
  const evals = readJsonl<Record<string, unknown>>(evalsPath);

  const assessment: ChallengeRecoveryAssessment = {
    pairId,
    verdict: 'pair-not-found',
    intentProven: false,
    arms: [],
    blockers: [],
    assessedAt: now(),
  };

  // Latest record wins as the current state of the pair.
  const pairRecords = records.filter((r) => r.challengePairId === pairId);
  const record = pairRecords[pairRecords.length - 1];
  const primaryTask = tasks[pairId];
  const challengerTask = tasks[`${pairId}_c`];

  if (!record && !primaryTask) {
    assessment.blockers.push(`no challenge record or task state for ${pairId}`);
    return assessment;
  }

  if (record) {
    assessment.existingOutcome = record.comparisonOutcome as string | undefined;
    assessment.existingInvalidReason = record.invalidChallengeReason as string | undefined;
  }

  const primaryIntent = primaryTask?.challengeExecutionIntent ?? undefined;
  const challengerIntent = challengerTask?.challengeExecutionIntent ?? undefined;
  const challengeStage = primaryIntent?.selectedStage
    ?? challengerIntent?.selectedStage
    ?? (record?.challengeStage as string | undefined);
  assessment.challengeStage = challengeStage;

  assessment.arms = [
    collectArmEvidence(repoDir, 'primary', pairId, primaryTask, challengeStage, record, evals),
    collectArmEvidence(repoDir, 'challenger', `${pairId}_c`, challengerTask, challengeStage, record, evals),
  ];

  // ── Gate 1: an immutable intent shared by both arms ────────────────
  if (!primaryIntent?.createdAt || !challengerIntent?.createdAt) {
    assessment.blockers.push('challenge execution intent is missing on at least one arm');
  } else if (primaryIntent.createdAt !== challengerIntent.createdAt) {
    assessment.blockers.push(
      `arms disagree on intent createdAt (${primaryIntent.createdAt} vs ${challengerIntent.createdAt})`,
    );
  } else if ((primaryIntent.selectedStage ?? '') !== (challengerIntent.selectedStage ?? '')) {
    assessment.blockers.push('arms disagree on the challenge stage');
  } else {
    assessment.intentProven = true;
  }

  // ── Gate 2: both arms actually executed the challenge stage ────────
  for (const arm of assessment.arms) {
    if (!arm.proven) {
      assessment.blockers.push(`${arm.side} arm unproven: ${arm.gaps.join('; ')}`);
    }
  }

  // ── Gate 3: the challenge stage genuinely varied ───────────────────
  const [primaryArm, challengerArm] = assessment.arms;
  if (primaryArm.stageModel && challengerArm.stageModel) {
    if (primaryArm.stageModel === challengerArm.stageModel) {
      assessment.blockers.push(
        `both arms ran ${primaryArm.stageModel} at the challenge stage — identical control, not a challenge`,
      );
    }
  }

  assessment.verdict = assessment.intentProven && assessment.blockers.length === 0
    ? 'supersedable'
    : 'quarantine-upheld';
  return assessment;
}

/**
 * Build the superseding comparison record. Only ever called for a
 * `supersedable` assessment; the winner is decided by eval score, and the
 * models come from execution evidence rather than from the prior record's
 * (incorrectly derived) attestation.
 */
function buildSupersedingRecord(
  assessment: ChallengeRecoveryAssessment,
  previous: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const [primaryArm, challengerArm] = assessment.arms;
  const primaryScore = primaryArm.evalScore ?? 0;
  const challengerScore = challengerArm.evalScore ?? 0;

  // `winner` — not `comparisonOutcome` — is what the merge gate keys off when it
  // decides which PR merges and which goes to loser cleanup. A record without it
  // makes the gate silently treat the primary as the winner.
  // A tie must NOT name a winner: resolving it arbitrarily would send a PR of
  // equal measured quality to the destructive loser path.
  const winner: 'primary' | 'challenger' | undefined =
    challengerScore > primaryScore ? 'challenger'
      : primaryScore > challengerScore ? 'primary'
        : undefined;

  return {
    challengePairId: assessment.pairId,
    challengeStage: assessment.challengeStage,
    primaryModel: primaryArm.stageModel,
    challengerModel: challengerArm.stageModel,
    primaryPrUrl: primaryArm.prUrl,
    challengerPrUrl: challengerArm.prUrl,
    primaryEvalScore: primaryArm.evalScore,
    challengerEvalScore: challengerArm.evalScore,
    // A tie has no decisive winner, so it is reported as inconclusive rather
    // than as a comparison the gate would act on.
    comparisonOutcome: winner ? 'compared' : 'inconclusive',
    ...(winner ? { winner } : {}),
    invalidChallenge: false,
    rationale: winner
      ? `Recovered comparison from execution evidence: ${winner} wins (${primaryArm.stageModel} ${primaryScore} vs ${challengerArm.stageModel} ${challengerScore}).`
      : `Recovered comparison from execution evidence: tie at ${primaryScore}; no decisive winner.`,
    timestamp: assessment.assessedAt,
    // Provenance: this record replaces an invalid one and says so explicitly,
    // so the original stays auditable rather than being silently dropped.
    recordKind: 'superseding-comparison',
    supersedes: {
      timestamp: previous?.timestamp,
      comparisonOutcome: previous?.comparisonOutcome,
      invalidChallengeReason: previous?.invalidChallengeReason,
    },
    recoveryProvenance: {
      tool: 'challenge-recovery',
      intentCreatedAt: primaryArm.intentCreatedAt,
      evidence: assessment.arms.map((arm) => ({
        side: arm.side,
        issueId: arm.issueId,
        stageModel: arm.stageModel,
        stageResultPath: arm.stageResultPath,
      })),
    },
  };
}

export function runChallengeRecovery(options: ChallengeRecoveryOptions): ChallengeRecoveryResult {
  const { repoDir, pairIds, apply = false } = options;
  const now = options.now ?? (() => new Date().toISOString());

  if (pairIds.length === 0) {
    throw new Error('challenge-recovery requires explicit pair IDs; there is no recover-all mode');
  }

  const evalsDir = join(repoDir, '.wavemill', 'evals');
  const auditPath = join(evalsDir, 'challenge-recovery-audit.jsonl');
  const recordsPath = join(evalsDir, 'challenge-records.jsonl');
  const records = readJsonl<Record<string, unknown>>(recordsPath);

  const assessments: ChallengeRecoveryAssessment[] = [];
  let auditEntriesWritten = 0;
  let supersedingRecordsWritten = 0;

  for (const pairId of pairIds) {
    const assessment = assessChallengePair(repoDir, pairId, now);
    assessments.push(assessment);

    if (!apply) continue;

    // The audit entry is written for every assessed pair, including upheld
    // quarantines — "we looked and refused" is itself the record worth keeping.
    appendFileSync(auditPath, `${JSON.stringify({ ...assessment, applied: true })}\n`, 'utf8');
    auditEntriesWritten += 1;

    if (assessment.verdict === 'supersedable') {
      const pairRecords = records.filter((r) => r.challengePairId === pairId);
      const previous = pairRecords[pairRecords.length - 1];
      const superseding = buildSupersedingRecord(assessment, previous);
      appendFileSync(recordsPath, `${JSON.stringify(superseding)}\n`, 'utf8');
      supersedingRecordsWritten += 1;
    }
  }

  return {
    assessments,
    auditPath,
    recordsPath,
    applied: apply,
    auditEntriesWritten,
    supersedingRecordsWritten,
  };
}

/**
 * Void a challenge pair record by appending a voided-comparison record.
 * This marks the record as intentionally invalidated without removing the original,
 * and resets the challengeCompared state so the comparison can be retried.
 */
export async function voidChallengePair(input: {
  repoDir: string;
  pairId: string;
  reason: string;
  now?: () => Date;
}): Promise<void> {
  const evalsDir = join(input.repoDir, '.wavemill', 'evals');
  const recordsPath = join(evalsDir, 'challenge-records.jsonl');
  const auditPath = join(evalsDir, 'challenge-recovery-audit.jsonl');
  const stateFilePath = join(input.repoDir, '.wavemill', 'workflow-state.json');

  // Create voided-comparison record
  const voidedRecord = {
    challengePairId: input.pairId,
    recordKind: 'voided-comparison',
    voids: input.pairId,
    rationale: input.reason,
    timestamp: (input.now ?? (() => new Date()))().toISOString(),
  };

  // Append to records
  appendFileSync(recordsPath, `${JSON.stringify(voidedRecord)}\n`, 'utf8');

  // Log audit entry
  const auditEntry = {
    challengePairId: input.pairId,
    action: 'void',
    reason: input.reason,
    timestamp: voidedRecord.timestamp,
  };
  appendFileSync(auditPath, `${JSON.stringify(auditEntry)}\n`, 'utf8');

  // Reset challengeCompared state for both arms so comparison can be retried
  if (existsSync(stateFilePath)) {
    const primaryId = input.pairId;
    const challengerId = `${input.pairId}_c`;

    try {
      await mutateJsonState(stateFilePath, (state: any) => {
        if (state.tasks) {
          if (state.tasks[primaryId]) {
            state.tasks[primaryId].challengeCompared = false;
          }
          if (state.tasks[challengerId]) {
            state.tasks[challengerId].challengeCompared = false;
          }
        }
        return state;
      });
    } catch (error) {
      console.warn(`Failed to reset challengeCompared state for pair ${input.pairId}: ${(error as Error).message}`);
    }
  }
}
