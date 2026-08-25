import { existsSync, readFileSync } from 'node:fs';
import { getContributionConsentStatus } from './hokusai-consent.ts';
import { errorMessage } from './error-utils.ts';
import { resolveHokusaiRewardLedgerPaths } from './hokusai-reward-ledger-paths.ts';
import { mutateJsonState, StateParseError } from './state-mutex.ts';
import type { HokusaiQueueProvenance } from './hokusai-queue.ts';

const LEDGER_SCHEMA_VERSION = '1.0';
const MAX_REASON_LENGTH = 240;

export type HokusaiRewardLedgerStatus = 'pending' | 'accepted' | 'rejected';

export interface HokusaiRewardLedgerEntry {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  contributionId: string;
  batchId: string | null;
  idempotencyKey: string;
  rowCount: number;
  submittedAt: string;
  acceptedAt: string | null;
  status: HokusaiRewardLedgerStatus;
  tokenAmount: number | null;
  hokusaiJobIds: string[];
  rewardMetadata?: Record<string, string | number | boolean | null>;
  rejectionReason?: string;
  queueProvenance?: HokusaiQueueProvenance[];
}

interface HokusaiRewardLedgerState {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  entries: HokusaiRewardLedgerEntry[];
}

export interface RewardLedgerAccessOptions {
  repoDir?: string;
  configDir?: string;
}

export interface PendingAcceptedBatchInput {
  contributionId: string;
  batchId?: string | null;
  idempotencyKey: string;
  rowCount: number;
  submittedAt: string;
  acceptedAt: string;
  hokusaiJobIds?: string[];
  queueProvenance?: HokusaiQueueProvenance[];
}

export interface RewardLedgerUpdateInput {
  contributionId: string;
  status: 'accepted' | 'rejected';
  acceptedAt?: string | null;
  tokenAmount?: number | null;
  hokusaiJobIds?: string[];
  rewardMetadata?: Record<string, unknown>;
  rejectionReason?: string;
}

export interface RewardLedgerMutationResult {
  status: 'disabled' | 'recorded' | 'updated';
  entry?: HokusaiRewardLedgerEntry;
}

export interface RewardLedgerListResult {
  status: 'disabled' | 'ok' | 'corrupt_state';
  entries: HokusaiRewardLedgerEntry[];
  error?: string;
}

export interface RewardLedgerSummary {
  status: 'disabled' | 'ok' | 'corrupt_state';
  entryCount: number;
  pendingCount: number;
  acceptedCount: number;
  rejectedCount: number;
  totalTokenAmount: number;
  error?: string;
}

function initialState(): HokusaiRewardLedgerState {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    entries: [],
  };
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function assertIsoTimestamp(value: string, field: string): void {
  if (!isIsoTimestamp(value)) {
    throw new Error(`Invalid ${field}: expected ISO timestamp`);
  }
}

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Invalid ${field}: expected non-empty string`);
  }
}

function sanitizeTokenAmount(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return value ?? null;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Invalid tokenAmount: expected a non-negative number or null');
  }
  return value;
}

function sanitizeRowCount(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Invalid rowCount: expected a non-negative integer');
  }
  return value;
}

function sanitizeJobIds(jobIds: string[] | undefined): string[] {
  if (!jobIds) {
    return [];
  }
  return [...new Set(jobIds.filter((jobId) => typeof jobId === 'string' && jobId.trim().length > 0))];
}

function sanitizeRewardMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }

  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function truncateReason(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }
  const trimmed = reason.trim();
  return trimmed.length <= MAX_REASON_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_REASON_LENGTH - 1)}...`;
}

function validateEntry(entry: HokusaiRewardLedgerEntry): void {
  assertNonEmptyString(entry.contributionId, 'contributionId');
  assertNonEmptyString(entry.idempotencyKey, 'idempotencyKey');
  sanitizeRowCount(entry.rowCount);
  assertIsoTimestamp(entry.submittedAt, 'submittedAt');
  if (entry.acceptedAt !== null) {
    assertIsoTimestamp(entry.acceptedAt, 'acceptedAt');
  }
  sanitizeTokenAmount(entry.tokenAmount);
}

function readState(repoDir?: string): HokusaiRewardLedgerState {
  const paths = resolveHokusaiRewardLedgerPaths(repoDir);
  if (!existsSync(paths.ledgerPath)) {
    return initialState();
  }

  try {
    const parsed = JSON.parse(readFileSync(paths.ledgerPath, 'utf-8')) as HokusaiRewardLedgerState;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw new Error('reward ledger state must be an object with entries[]');
    }
    for (const entry of parsed.entries) {
      validateEntry(entry);
    }
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      entries: parsed.entries,
    };
  } catch (error) {
    throw new StateParseError(paths.ledgerPath, error);
  }
}

function findEntryIndex(
  entries: HokusaiRewardLedgerEntry[],
  contributionId: string,
  idempotencyKey?: string,
): number {
  return entries.findIndex((entry) => (
    entry.contributionId === contributionId
      || (idempotencyKey ? entry.idempotencyKey === idempotencyKey : false)
  ));
}

function enforceTransition(
  current: HokusaiRewardLedgerStatus,
  next: HokusaiRewardLedgerStatus,
): HokusaiRewardLedgerStatus {
  if (current === next) {
    return current;
  }
  if (current === 'pending') {
    return next;
  }
  throw new Error(`Invalid ledger status transition: ${current} -> ${next}`);
}

async function mutateLedgerState(
  opts: RewardLedgerAccessOptions,
  transform: (current: HokusaiRewardLedgerState) => HokusaiRewardLedgerState,
): Promise<HokusaiRewardLedgerState> {
  const paths = resolveHokusaiRewardLedgerPaths(opts.repoDir);
  return mutateJsonState(paths.ledgerPath, transform, {
    createIfMissing: true,
    initial: initialState(),
  });
}

export async function recordPendingAcceptedBatch(
  input: PendingAcceptedBatchInput,
  opts: RewardLedgerAccessOptions = {},
): Promise<RewardLedgerMutationResult> {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { status: 'disabled' };
  }

  assertNonEmptyString(input.contributionId, 'contributionId');
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  sanitizeRowCount(input.rowCount);
  assertIsoTimestamp(input.submittedAt, 'submittedAt');
  assertIsoTimestamp(input.acceptedAt, 'acceptedAt');

  let entry: HokusaiRewardLedgerEntry | undefined;
  await mutateLedgerState(opts, (current) => {
    const entries = [...current.entries];
    const index = findEntryIndex(entries, input.contributionId, input.idempotencyKey);
    const existing = index >= 0 ? entries[index] : undefined;
    const nextStatus = existing ? existing.status : 'pending';
    entry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      contributionId: existing?.contributionId ?? input.contributionId,
      batchId: existing?.batchId ?? input.batchId ?? null,
      idempotencyKey: existing?.idempotencyKey ?? input.idempotencyKey,
      rowCount: existing?.rowCount ?? input.rowCount,
      submittedAt: existing?.submittedAt ?? input.submittedAt,
      acceptedAt: existing?.acceptedAt ?? input.acceptedAt,
      status: nextStatus,
      tokenAmount: existing?.tokenAmount ?? null,
      hokusaiJobIds: sanitizeJobIds([
        ...(existing?.hokusaiJobIds ?? []),
        ...(input.hokusaiJobIds ?? []),
      ]),
      queueProvenance: [
        ...(existing?.queueProvenance ?? []),
        ...(input.queueProvenance ?? []),
      ],
      ...(existing?.rewardMetadata ? { rewardMetadata: existing.rewardMetadata } : {}),
      ...(existing?.rejectionReason ? { rejectionReason: existing.rejectionReason } : {}),
    };
    validateEntry(entry);

    if (index >= 0) {
      entries[index] = entry;
    } else {
      entries.push(entry);
    }

    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      entries,
    };
  });

  return { status: 'recorded', entry };
}

export async function updateRewardStatus(
  input: RewardLedgerUpdateInput,
  opts: RewardLedgerAccessOptions = {},
): Promise<RewardLedgerMutationResult> {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { status: 'disabled' };
  }

  assertNonEmptyString(input.contributionId, 'contributionId');
  if (input.acceptedAt !== undefined && input.acceptedAt !== null) {
    assertIsoTimestamp(input.acceptedAt, 'acceptedAt');
  }
  const tokenAmount = sanitizeTokenAmount(input.tokenAmount);
  const rewardMetadata = sanitizeRewardMetadata(input.rewardMetadata);
  const rejectionReason = truncateReason(input.rejectionReason);

  let entry: HokusaiRewardLedgerEntry | undefined;
  await mutateLedgerState(opts, (current) => {
    const entries = [...current.entries];
    const index = findEntryIndex(entries, input.contributionId);
    if (index < 0) {
      throw new Error(`Reward ledger entry not found for contributionId ${input.contributionId}`);
    }

    const existing = entries[index];
    const status = enforceTransition(existing.status, input.status);
    entry = {
      ...existing,
      status,
      acceptedAt: input.acceptedAt === undefined ? existing.acceptedAt : input.acceptedAt,
      tokenAmount: input.tokenAmount === undefined ? existing.tokenAmount : tokenAmount,
      hokusaiJobIds: sanitizeJobIds([
        ...existing.hokusaiJobIds,
        ...(input.hokusaiJobIds ?? []),
      ]),
      ...(rewardMetadata ? { rewardMetadata } : existing.rewardMetadata ? { rewardMetadata: existing.rewardMetadata } : {}),
      ...(rejectionReason ? { rejectionReason } : existing.rejectionReason ? { rejectionReason: existing.rejectionReason } : {}),
    };
    validateEntry(entry);
    entries[index] = entry;

    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      entries,
    };
  });

  return { status: 'updated', entry };
}

export function listRewardLedgerEntries(
  opts: RewardLedgerAccessOptions & { status?: HokusaiRewardLedgerStatus } = {},
): RewardLedgerListResult {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { status: 'disabled', entries: [] };
  }

  try {
    const state = readState(opts.repoDir);
    const entries = opts.status
      ? state.entries.filter((entry) => entry.status === opts.status)
      : state.entries;
    return { status: 'ok', entries };
  } catch (error) {
    return {
      status: 'corrupt_state',
      entries: [],
      error: error instanceof StateParseError ? error.message : errorMessage(error),
    };
  }
}

export function summarizeRewardLedger(opts: RewardLedgerAccessOptions = {}): RewardLedgerSummary {
  const listed = listRewardLedgerEntries(opts);
  if (listed.status !== 'ok') {
    return {
      status: listed.status,
      entryCount: 0,
      pendingCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      totalTokenAmount: 0,
      ...(listed.error ? { error: listed.error } : {}),
    };
  }

  const pendingCount = listed.entries.filter((entry) => entry.status === 'pending').length;
  const acceptedCount = listed.entries.filter((entry) => entry.status === 'accepted').length;
  const rejectedCount = listed.entries.filter((entry) => entry.status === 'rejected').length;
  const totalTokenAmount = listed.entries.reduce((sum, entry) => (
    entry.tokenAmount === null ? sum : sum + entry.tokenAmount
  ), 0);

  return {
    status: 'ok',
    entryCount: listed.entries.length,
    pendingCount,
    acceptedCount,
    rejectedCount,
    totalTokenAmount,
  };
}
