import { getHokusaiContributionsConfig } from './config.ts';
import { getContributionConsentStatus } from './hokusai-consent.ts';
import {
  createSafeFailure,
  markBatchAccepted,
  markBatchPermanentFailure,
  markBatchTransientFailure,
  readPending,
  type QueueAccessOptions,
} from './hokusai-queue.ts';
import { exportPendingContributions } from './hokusai-queue-export.ts';
import {
  recordPendingAcceptedBatch,
  updateRewardStatus,
} from './hokusai-reward-ledger.ts';

export interface DrainQueueOptions extends QueueAccessOptions {
  fetchImpl?: typeof fetch;
  random?: () => number;
}

export interface DrainQueueResult {
  status:
    | 'disabled'
    | 'empty'
    | 'waiting'
    | 'uploaded'
    | 'retry_scheduled'
    | 'dead_lettered'
    | 'permanent_failure'
    | 'exported'
    | 'unconfigured'
    | 'corrupt_state';
  uploadedCount?: number;
  exportedCount?: number;
  nextAttemptAt?: string;
  jobIds?: string[];
  error?: string;
}

function classifyResponse(status: number): 'accepted' | 'transient' | 'permanent' {
  if (status >= 200 && status < 300) {
    return 'accepted';
  }
  if (status === 408 || status === 429 || status >= 500) {
    return 'transient';
  }
  return 'permanent';
}

function computeBackoffMs(
  attempts: number,
  initialMs: number,
  maxMs: number,
  random: () => number,
): number {
  const cappedBase = Math.min(initialMs * (2 ** Math.max(attempts - 1, 0)), maxMs);
  return Math.floor(random() * cappedBase);
}

function normalizeJobIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const candidates = [record.jobIds, record.job_ids];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((jobId): jobId is string => typeof jobId === 'string');
    }
  }

  const single = [record.jobId, record.job_id].find((value) => typeof value === 'string');
  return typeof single === 'string' ? [single] : [];
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseTokenAmount(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizeRewardMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => (
      typeof entry === 'string'
        || typeof entry === 'number'
        || typeof entry === 'boolean'
        || entry === null
    )),
  );
}

function normalizeAcceptedPayload(payload: unknown): {
  jobIds: string[];
  contributionId?: string;
  rewardDetected: boolean;
  tokenAmount?: number | null;
  rewardMetadata?: Record<string, unknown>;
} {
  if (!payload || typeof payload !== 'object') {
    return { jobIds: [], rewardDetected: false };
  }

  const record = payload as Record<string, unknown>;
  const rewards = record.rewards && typeof record.rewards === 'object' && !Array.isArray(record.rewards)
    ? record.rewards as Record<string, unknown>
    : undefined;
  const directTokenAmount = hasOwn(record, 'tokenAmount')
    ? parseTokenAmount(record.tokenAmount)
    : hasOwn(record, 'token_amount')
      ? parseTokenAmount(record.token_amount)
      : undefined;
  const nestedTokenAmount = rewards && hasOwn(rewards, 'tokenAmount')
    ? parseTokenAmount(rewards.tokenAmount)
    : rewards && hasOwn(rewards, 'token_amount')
      ? parseTokenAmount(rewards.token_amount)
      : undefined;
  const tokenAmount = directTokenAmount !== undefined ? directTokenAmount : nestedTokenAmount;
  const contributionId = [record.contributionId, record.contribution_id]
    .find((value): value is string => typeof value === 'string' && value.length > 0);

  return {
    jobIds: normalizeJobIds(record),
    ...(contributionId ? { contributionId } : {}),
    rewardDetected: tokenAmount !== undefined || rewards !== undefined,
    ...(tokenAmount !== undefined ? { tokenAmount } : {}),
    ...(rewards ? { rewardMetadata: sanitizeRewardMetadata(rewards) } : {}),
  };
}

async function postBatch(
  batch: PendingBatch,
  opts: DrainQueueOptions,
): Promise<
  | {
    status: 'accepted';
    jobIds: string[];
    contributionId?: string;
    rewardDetected: boolean;
    tokenAmount?: number | null;
    rewardMetadata?: Record<string, unknown>;
  }
  | { status: 'transient' | 'permanent'; error: string; httpStatus?: number }
> {
  const config = getHokusaiContributionsConfig(opts.repoDir);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const token = config.endpointTokenEnv ? process.env[config.endpointTokenEnv] : '';

  try {
    const response = await fetchImpl(config.endpoint!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': batch.idempotencyKey,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        rows: batch.entries.map((entry) => entry.row),
        metadata: {
          idempotency_key: batch.idempotencyKey,
        },
      }),
      signal: controller.signal,
    });

    const classification = classifyResponse(response.status);
    if (classification !== 'accepted') {
      return {
        status: classification,
        error: `Contribution endpoint returned HTTP ${response.status}`,
        httpStatus: response.status,
      };
    }

    const text = await response.text();
    if (!text.trim()) {
      return { status: 'accepted', jobIds: [], rewardDetected: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        status: 'permanent',
        error: 'Contribution endpoint returned invalid JSON',
        httpStatus: response.status,
      };
    }

    return { status: 'accepted', ...normalizeAcceptedPayload(parsed) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && error.name === 'AbortError'
      ? 'Request timed out'
      : message;
    return { status: 'transient', error: code };
  } finally {
    clearTimeout(timeout);
  }
}

export async function drainContributionQueue(
  opts: DrainQueueOptions = {},
): Promise<DrainQueueResult> {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { status: 'disabled' };
  }

  const config = getHokusaiContributionsConfig(opts.repoDir);
  if (!config.endpoint) {
    if (config.exportPath) {
      const result = await exportPendingContributions(opts);
      return {
        status: result.status === 'exported' ? 'exported' : result.status,
        exportedCount: result.exportedCount,
      };
    }
    return { status: 'unconfigured' };
  }

  const pending = readPending(opts);
  if (pending.status === 'disabled' || pending.status === 'empty' || pending.status === 'waiting' || pending.status === 'corrupt_state') {
    return {
      status: pending.status,
      ...(pending.nextAttemptAt ? { nextAttemptAt: pending.nextAttemptAt } : {}),
      ...(pending.error ? { error: pending.error } : {}),
    };
  }

  const batch = pending.batch!;
  const now = opts.now ?? new Date();
  const posted = await postBatch(batch, opts);

  if (posted.status === 'accepted') {
    await markBatchAccepted(batch, { jobIds: posted.jobIds }, opts);
    const acceptedAt = now.toISOString();
    const contributionId = posted.contributionId ?? batch.idempotencyKey;
    try {
      await recordPendingAcceptedBatch({
        contributionId,
        batchId: batch.entries[0]?.entryId ?? null,
        idempotencyKey: batch.idempotencyKey,
        rowCount: batch.entries.length,
        submittedAt: batch.entries[0]?.enqueuedAt ?? acceptedAt,
        acceptedAt,
        hokusaiJobIds: posted.jobIds,
      }, opts);

      if (posted.rewardDetected) {
        await updateRewardStatus({
          contributionId,
          status: 'accepted',
          acceptedAt,
          ...(posted.tokenAmount !== undefined ? { tokenAmount: posted.tokenAmount } : {}),
          hokusaiJobIds: posted.jobIds,
          ...(posted.rewardMetadata ? { rewardMetadata: posted.rewardMetadata } : {}),
        }, opts);
      }
    } catch (error) {
      console.warn(`[hokusai-ledger] Failed to record accepted contribution batch: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      status: 'uploaded',
      uploadedCount: batch.entries.length,
      jobIds: posted.jobIds,
    };
  }

  const failure = createSafeFailure(
    posted.status === 'transient' ? 'transient_http_failure' : 'permanent_http_failure',
    posted.error,
    now,
    posted.httpStatus,
  );

  if (posted.status === 'permanent') {
    await markBatchPermanentFailure(batch, failure, opts);
    try {
      await recordPendingAcceptedBatch({
        contributionId: batch.idempotencyKey,
        batchId: batch.entries[0]?.entryId ?? null,
        idempotencyKey: batch.idempotencyKey,
        rowCount: batch.entries.length,
        submittedAt: batch.entries[0]?.enqueuedAt ?? now.toISOString(),
        acceptedAt: now.toISOString(),
      }, opts);
      await updateRewardStatus({
        contributionId: batch.idempotencyKey,
        status: 'rejected',
        acceptedAt: null,
        tokenAmount: null,
        rejectionReason: posted.error,
      }, opts);
    } catch (error) {
      console.warn(`[hokusai-ledger] Failed to record rejected contribution batch: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      status: 'permanent_failure',
      error: posted.error,
    };
  }

  const random = opts.random ?? Math.random;
  const nextAttemptAt = new Date(
    now.getTime()
      + computeBackoffMs(
        batch.entries[0].attempts + 1,
        config.backoffInitialMs,
        config.backoffMaxMs,
        random,
      ),
  ).toISOString();

  const retryStatus = await markBatchTransientFailure(batch, failure, {
    ...opts,
    maxRetries: config.maxRetries,
    nextAttemptAt,
  });

  return {
    status: retryStatus,
    nextAttemptAt,
    error: posted.error,
  };
}
