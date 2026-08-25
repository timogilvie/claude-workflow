import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getContributionConsentStatus } from './hokusai-consent.ts';
import { resolveHokusaiLedgerPath } from './hokusai-queue-paths.ts';
import type { HokusaiQueueProvenance } from './hokusai-queue.ts';

export type HokusaiLedgerEventType = 'submitted' | 'accepted' | 'rejected' | 'reward_updated';
export type HokusaiRewardStatus = 'pending' | 'none' | 'awarded' | 'unknown';

export interface HokusaiLedgerEntry {
  schemaVersion: 1;
  eventType: HokusaiLedgerEventType;
  timestamp: string;
  modelId: '30';
  idempotencyKey: string;
  batchId?: string;
  jobId?: string;
  jobIds?: string[];
  submissionId?: string;
  benchmarkSpecId?: string;
  rowCount: number;
  queuedAt?: string;
  submittedAt?: string;
  acceptedAt?: string;
  rejectedAt?: string;
  rewardStatus: HokusaiRewardStatus;
  tokenReward?: number;
  summary?: string;
  errorCode?: string;
  queueProvenance?: HokusaiQueueProvenance[];
}

export interface HokusaiLedgerOptions {
  repoDir?: string;
  configDir?: string;
}

export interface HokusaiLedgerSummary {
  acceptedSubmissionCount: number;
  acceptedRowCount: number;
  rejectedSubmissionCount: number;
  lastSubmission: {
    timestamp: string;
    status: 'accepted' | 'rejected';
    jobId?: string;
    idempotencyKey: string;
  } | null;
  tokenRewards: {
    awarded: number;
    pending: number;
    none: number;
    unknown: number;
  };
}

const VALID_EVENT_TYPES = new Set<HokusaiLedgerEventType>(['submitted', 'accepted', 'rejected', 'reward_updated']);
const VALID_REWARD_STATUSES = new Set<HokusaiRewardStatus>(['pending', 'none', 'awarded', 'unknown']);

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateLedgerEntry(entry: HokusaiLedgerEntry): void {
  if (entry.schemaVersion !== 1) {
    throw new Error('Ledger entry schemaVersion must be 1');
  }
  if (!VALID_EVENT_TYPES.has(entry.eventType)) {
    throw new Error(`Unsupported ledger eventType: ${String(entry.eventType)}`);
  }
  if (!entry.timestamp || typeof entry.timestamp !== 'string') {
    throw new Error('Ledger entry timestamp is required');
  }
  if (entry.modelId !== '30') {
    throw new Error('Ledger entry modelId must be "30"');
  }
  if (!entry.idempotencyKey || typeof entry.idempotencyKey !== 'string') {
    throw new Error('Ledger entry idempotencyKey is required');
  }
  if (!isFiniteNonNegative(entry.rowCount)) {
    throw new Error('Ledger entry rowCount must be a non-negative finite number');
  }
  if (!VALID_REWARD_STATUSES.has(entry.rewardStatus)) {
    throw new Error(`Unsupported reward status: ${String(entry.rewardStatus)}`);
  }
  if (entry.tokenReward !== undefined && !isFiniteNonNegative(entry.tokenReward)) {
    throw new Error('Ledger entry tokenReward must be a non-negative finite number');
  }
}

export function appendHokusaiLedgerEntry(
  entry: HokusaiLedgerEntry,
  opts: HokusaiLedgerOptions = {},
): { written: true } | { written: false; reason: 'consent_disabled' } {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { written: false, reason: 'consent_disabled' };
  }

  validateLedgerEntry(entry);
  const ledgerPath = resolveHokusaiLedgerPath(opts.repoDir);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf-8');
  return { written: true };
}

export function readHokusaiLedger(opts: HokusaiLedgerOptions = {}): HokusaiLedgerEntry[] {
  const ledgerPath = resolveHokusaiLedgerPath(opts.repoDir);
  if (!existsSync(ledgerPath)) {
    return [];
  }

  const lines = readFileSync(ledgerPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const entries: HokusaiLedgerEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as HokusaiLedgerEntry;
      entries.push(parsed);
    } catch {
      // Skip malformed JSONL lines.
    }
  }
  return entries;
}

function stableSubmissionId(entry: HokusaiLedgerEntry): string {
  return entry.idempotencyKey;
}

function submissionAliases(entry: HokusaiLedgerEntry): string[] {
  const aliases: string[] = [];
  aliases.push(`idempotency:${entry.idempotencyKey}`);
  if (entry.jobId) {
    aliases.push(`job:${entry.jobId}`);
  }
  if (entry.submissionId) {
    aliases.push(`submission:${entry.submissionId}`);
  }
  for (const jobId of entry.jobIds ?? []) {
    if (typeof jobId === 'string' && jobId.length > 0) {
      aliases.push(`job:${jobId}`);
    }
  }
  return aliases;
}

export function summarizeHokusaiLedger(opts: HokusaiLedgerOptions = {}): HokusaiLedgerSummary {
  const entries = readHokusaiLedger(opts);
  const terminal = entries.filter((entry) => entry.eventType === 'accepted' || entry.eventType === 'rejected');

  const groups = new Map<string, HokusaiLedgerEntry>();
  const aliasToGroup = new Map<string, string>();

  for (const entry of terminal) {
    const aliases = submissionAliases(entry);
    let groupId: string | undefined;
    for (const alias of aliases) {
      const found = aliasToGroup.get(alias);
      if (found) {
        groupId = found;
        break;
      }
    }
    if (!groupId) {
      groupId = stableSubmissionId(entry);
    }

    const existing = groups.get(groupId);
    if (!existing || new Date(entry.timestamp).getTime() >= new Date(existing.timestamp).getTime()) {
      groups.set(groupId, entry);
    }
    for (const alias of aliases) {
      aliasToGroup.set(alias, groupId);
    }
  }

  const deduped = [...groups.values()];
  let acceptedSubmissionCount = 0;
  let acceptedRowCount = 0;
  let rejectedSubmissionCount = 0;
  let awarded = 0;
  let pending = 0;
  let none = 0;
  let unknown = 0;
  let lastSubmission: HokusaiLedgerSummary['lastSubmission'] = null;

  for (const entry of deduped) {
    const isAccepted = entry.eventType === 'accepted';
    if (isAccepted) {
      acceptedSubmissionCount += 1;
      acceptedRowCount += entry.rowCount;
    } else {
      rejectedSubmissionCount += 1;
    }

    if (entry.rewardStatus === 'awarded') {
      awarded += entry.tokenReward ?? 0;
    } else if (entry.rewardStatus === 'pending') {
      pending += 1;
    } else if (entry.rewardStatus === 'none') {
      none += 1;
    } else if (entry.rewardStatus === 'unknown') {
      unknown += 1;
    }

    if (!lastSubmission || new Date(entry.timestamp).getTime() > new Date(lastSubmission.timestamp).getTime()) {
      const jobId = entry.jobId ?? entry.submissionId ?? entry.jobIds?.[0];
      lastSubmission = {
        timestamp: entry.timestamp,
        status: isAccepted ? 'accepted' : 'rejected',
        ...(jobId ? { jobId } : {}),
        idempotencyKey: entry.idempotencyKey,
      };
    }
  }

  return {
    acceptedSubmissionCount,
    acceptedRowCount,
    rejectedSubmissionCount,
    lastSubmission,
    tokenRewards: {
      awarded,
      pending,
      none,
      unknown,
    },
  };
}
