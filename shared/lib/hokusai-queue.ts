import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getHokusaiContributionsConfig } from './config.ts';
import {
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
  validateContributionRow,
  type ContributionRow,
} from './hokusai-contribution-schema.ts';
import { getContributionConsentStatus } from './hokusai-consent.ts';
import { errorMessage } from './error-utils.ts';
import { resolveHokusaiQueuePaths } from './hokusai-queue-paths.ts';
import { mutateJsonState, StateParseError } from './state-mutex.ts';

const STATE_SCHEMA_VERSION = '1.0';
const MAX_RECENT_IDEMPOTENCY_KEYS = 1000;

export type QueueRowShape =
  | 'submit_data'
  | typeof TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION
  | typeof TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2;

export interface HokusaiQueueEnvelope {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  entryId: string;
  rowShape: QueueRowShape;
  row: ContributionRow;
  idempotencyKey: string;
  enqueuedAt: string;
  attempts: number;
  nextAttemptAt: string;
}

export interface HokusaiQueueFailureDetail {
  code: string;
  message: string;
  status?: number;
  at: string;
}

export interface AcceptedBatchRecord {
  batchId: string;
  idempotencyKey: string;
  acceptedAt: string;
  rowCount: number;
  jobIds: string[];
}

export interface HokusaiQueueState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  processedLineCount: number;
  exportLineCount: number;
  recentIdempotencyKeys: string[];
  acceptedBatches: AcceptedBatchRecord[];
  lastError: HokusaiQueueFailureDetail | null;
}

export interface QueueAccessOptions {
  repoDir?: string;
  configDir?: string;
  now?: Date;
}

export interface EnqueueResult {
  status: 'disabled' | 'enqueued' | 'duplicate';
  entry?: HokusaiQueueEnvelope;
}

export interface PendingBatch {
  entries: HokusaiQueueEnvelope[];
  lineCount: number;
  idempotencyKey: string;
}

export interface ReadPendingResult {
  status: 'disabled' | 'ready' | 'waiting' | 'empty' | 'corrupt_state';
  batch?: PendingBatch;
  nextAttemptAt?: string;
  error?: string;
}

export interface HokusaiQueueStatus {
  enabled: boolean;
  consentValid: boolean;
  queueExists: boolean;
  endpointConfigured: boolean;
  exportConfigured: boolean;
  pendingCount: number;
  deadLetterCount: number;
  processedLineCount: number;
  exportLineCount: number;
  lastError: HokusaiQueueFailureDetail | null;
}

function initialState(): HokusaiQueueState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    processedLineCount: 0,
    exportLineCount: 0,
    recentIdempotencyKeys: [],
    acceptedBatches: [],
    lastError: null,
  };
}

function toStableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => toStableJson(entry)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${toStableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function getRowShape(row: ContributionRow): QueueRowShape {
  return 'schema_version' in row ? row.schema_version : 'submit_data';
}

export function computeContributionRowIdempotencyKey(
  row: ContributionRow,
  explicitSeed?: string,
): string {
  const hash = createHash('sha256');
  hash.update(explicitSeed ?? '');
  hash.update(':');
  hash.update(toStableJson(row));
  return hash.digest('hex').slice(0, 32);
}

export function computeBatchIdempotencyKey(entries: HokusaiQueueEnvelope[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.idempotencyKey);
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 32);
}

function appendJsonlLine(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
}

function readLines(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function loadStateOrDefault(statePath: string): HokusaiQueueState {
  if (!existsSync(statePath)) {
    return initialState();
  }

  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as HokusaiQueueState;
  } catch (error) {
    throw new StateParseError(statePath, error);
  }
}

function appendEnvelope(paths: ReturnType<typeof resolveHokusaiQueuePaths>, envelope: HokusaiQueueEnvelope): void {
  appendJsonlLine(paths.pendingPath, envelope);
}

function sanitizeRecentKeys(keys: string[]): string[] {
  return keys.slice(-MAX_RECENT_IDEMPOTENCY_KEYS);
}

function safeFailure(code: string, message: string, now: Date, status?: number): HokusaiQueueFailureDetail {
  return {
    code,
    message,
    ...(status !== undefined ? { status } : {}),
    at: now.toISOString(),
  };
}

export async function enqueueContribution(
  row: ContributionRow,
  opts: QueueAccessOptions = {},
): Promise<EnqueueResult> {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { status: 'disabled' };
  }

  const validatedRow = validateContributionRow(row);
  const now = opts.now ?? new Date();
  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const explicitSeed = 'task_id' in validatedRow && validatedRow.task_id ? validatedRow.task_id : undefined;
  const idempotencyKey = computeContributionRowIdempotencyKey(validatedRow, explicitSeed);
  let status: EnqueueResult['status'] = 'enqueued';
  let entry: HokusaiQueueEnvelope | undefined;

  await mutateJsonState<HokusaiQueueState>(
    paths.statePath,
    (current) => {
      if (current.recentIdempotencyKeys.includes(idempotencyKey)) {
        status = 'duplicate';
        return current;
      }

      entry = {
        schemaVersion: STATE_SCHEMA_VERSION,
        entryId: randomUUID(),
        rowShape: getRowShape(validatedRow),
        row: validatedRow,
        idempotencyKey,
        enqueuedAt: now.toISOString(),
        attempts: 0,
        nextAttemptAt: now.toISOString(),
      };
      appendEnvelope(paths, entry);

      return {
        ...current,
        recentIdempotencyKeys: sanitizeRecentKeys([...current.recentIdempotencyKeys, idempotencyKey]),
      };
    },
    { createIfMissing: true, initial: initialState() },
  );

  return status === 'duplicate'
    ? { status }
    : { status, entry };
}

export async function enqueueBatch(
  rows: ContributionRow[],
  opts: QueueAccessOptions = {},
): Promise<EnqueueResult[]> {
  const results: EnqueueResult[] = [];
  for (const row of rows) {
    results.push(await enqueueContribution(row, opts));
  }
  return results;
}

export function readPending(opts: QueueAccessOptions = {}): ReadPendingResult {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { status: 'disabled' };
  }

  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const config = getHokusaiContributionsConfig(opts.repoDir);
  const now = opts.now ?? new Date();
  let state: HokusaiQueueState;

  try {
    state = loadStateOrDefault(paths.statePath);
  } catch (error) {
    return {
      status: 'corrupt_state',
      error: error instanceof StateParseError ? error.message : errorMessage(error),
    };
  }

  const lines = readLines(paths.pendingPath);
  if (state.processedLineCount >= lines.length) {
    return { status: 'empty' };
  }

  const slice = lines.slice(state.processedLineCount);
  const entries: HokusaiQueueEnvelope[] = [];
  let lineCount = 0;

  for (const line of slice) {
    lineCount += 1;
    let parsed: HokusaiQueueEnvelope;
    try {
      parsed = JSON.parse(line) as HokusaiQueueEnvelope;
      validateContributionRow(parsed.row);
    } catch (error) {
      return {
        status: 'ready',
        batch: {
          entries: [{
            schemaVersion: STATE_SCHEMA_VERSION,
            entryId: 'malformed-entry',
            rowShape: 'submit_data',
            row: { success_under_budget: false },
            idempotencyKey: 'malformed-entry',
            enqueuedAt: now.toISOString(),
            attempts: 0,
            nextAttemptAt: now.toISOString(),
          }],
          lineCount: 1,
          idempotencyKey: 'malformed-entry',
        },
      };
    }

    if (new Date(parsed.nextAttemptAt).getTime() > now.getTime()) {
      if (entries.length === 0) {
        return { status: 'waiting', nextAttemptAt: parsed.nextAttemptAt };
      }
      break;
    }

    entries.push(parsed);
    if (entries.length >= config.batchSize) {
      break;
    }
  }

  if (entries.length === 0) {
    return { status: 'waiting', nextAttemptAt: undefined };
  }

  return {
    status: 'ready',
    batch: {
      entries,
      lineCount: entries.length,
      idempotencyKey: computeBatchIdempotencyKey(entries),
    },
  };
}

async function mutateQueueState(
  opts: QueueAccessOptions,
  transform: (current: HokusaiQueueState) => HokusaiQueueState,
): Promise<HokusaiQueueState> {
  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  return mutateJsonState(paths.statePath, transform, {
    createIfMissing: true,
    initial: initialState(),
  });
}

export async function markBatchAccepted(
  batch: PendingBatch,
  result: { jobIds?: string[] },
  opts: QueueAccessOptions = {},
): Promise<void> {
  await mutateQueueState(opts, (current) => ({
    ...current,
    processedLineCount: current.processedLineCount + batch.lineCount,
    acceptedBatches: [
      ...current.acceptedBatches.slice(-49),
      {
        batchId: batch.entries[0]?.entryId ?? randomUUID(),
        idempotencyKey: batch.idempotencyKey,
        acceptedAt: (opts.now ?? new Date()).toISOString(),
        rowCount: batch.entries.length,
        jobIds: result.jobIds ?? [],
      },
    ],
    lastError: null,
  }));
}

export async function markBatchTransientFailure(
  batch: PendingBatch,
  failure: HokusaiQueueFailureDetail,
  opts: QueueAccessOptions & {
    maxRetries?: number;
    nextAttemptAt: string;
  },
): Promise<'retry_scheduled' | 'dead_lettered'> {
  const now = opts.now ?? new Date();
  const maxRetries = opts.maxRetries ?? getHokusaiContributionsConfig(opts.repoDir).maxRetries;
  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const exhausted = batch.entries.some((entry) => entry.attempts + 1 >= maxRetries);

  if (exhausted) {
    for (const entry of batch.entries) {
      appendJsonlLine(paths.deadLetterPath, {
        entry,
        failure: { ...failure, code: 'transient_exhausted' },
      });
    }
    await mutateQueueState(opts, (current) => ({
      ...current,
      processedLineCount: current.processedLineCount + batch.lineCount,
      lastError: { ...failure, code: 'transient_exhausted', at: now.toISOString() },
    }));
    return 'dead_lettered';
  }

  for (const entry of batch.entries) {
    appendEnvelope(paths, {
      ...entry,
      entryId: randomUUID(),
      attempts: entry.attempts + 1,
      nextAttemptAt: opts.nextAttemptAt,
    });
  }

  await mutateQueueState(opts, (current) => ({
    ...current,
    processedLineCount: current.processedLineCount + batch.lineCount,
    lastError: failure,
  }));
  return 'retry_scheduled';
}

export async function markBatchPermanentFailure(
  batch: PendingBatch,
  failure: HokusaiQueueFailureDetail,
  opts: QueueAccessOptions = {},
): Promise<void> {
  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  for (const entry of batch.entries) {
    appendJsonlLine(paths.deadLetterPath, {
      entry,
      failure,
    });
  }
  await mutateQueueState(opts, (current) => ({
    ...current,
    processedLineCount: current.processedLineCount + batch.lineCount,
    lastError: failure,
  }));
}

export async function updateExportCursor(
  lineCount: number,
  opts: QueueAccessOptions = {},
): Promise<void> {
  await mutateQueueState(opts, (current) => ({
    ...current,
    exportLineCount: current.exportLineCount + lineCount,
  }));
}

export function listUnexportedEntries(opts: QueueAccessOptions = {}): HokusaiQueueEnvelope[] {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return [];
  }
  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const state = loadStateOrDefault(paths.statePath);
  return readLines(paths.pendingPath)
    .slice(state.exportLineCount)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HokusaiQueueEnvelope];
      } catch {
        return [];
      }
    });
}

export function createSafeFailure(
  code: string,
  message: string,
  now: Date,
  status?: number,
): HokusaiQueueFailureDetail {
  return safeFailure(code, message, now, status);
}

export function hokusaiQueueStatus(opts: QueueAccessOptions = {}): HokusaiQueueStatus {
  const consent = getContributionConsentStatus(opts);
  const config = getHokusaiContributionsConfig(opts.repoDir);
  if (!consent.submissionAllowed) {
    return {
      enabled: false,
      consentValid: consent.consentValid,
      queueExists: false,
      endpointConfigured: Boolean(config.endpoint),
      exportConfigured: Boolean(config.exportPath),
      pendingCount: 0,
      deadLetterCount: 0,
      processedLineCount: 0,
      exportLineCount: 0,
      lastError: null,
    };
  }

  const paths = resolveHokusaiQueuePaths(opts.repoDir);
  const queueExists = existsSync(paths.rootDir);
  let state = initialState();
  if (queueExists) {
    try {
      state = loadStateOrDefault(paths.statePath);
    } catch (error) {
      return {
        enabled: true,
        consentValid: consent.consentValid,
        queueExists,
        endpointConfigured: Boolean(config.endpoint),
        exportConfigured: Boolean(config.exportPath),
        pendingCount: 0,
        deadLetterCount: 0,
        processedLineCount: 0,
        exportLineCount: 0,
        lastError: safeFailure('state_parse_error', errorMessage(error), opts.now ?? new Date()),
      };
    }
  }
  const pendingLines = queueExists ? readLines(paths.pendingPath) : [];
  const deadLetterLines = queueExists ? readLines(paths.deadLetterPath) : [];

  return {
    enabled: true,
    consentValid: consent.consentValid,
    queueExists,
    endpointConfigured: Boolean(config.endpoint),
    exportConfigured: Boolean(config.exportPath),
    pendingCount: Math.max(pendingLines.length - state.processedLineCount, 0),
    deadLetterCount: deadLetterLines.length,
    processedLineCount: state.processedLineCount,
    exportLineCount: state.exportLineCount,
    lastError: state.lastError,
  };
}
