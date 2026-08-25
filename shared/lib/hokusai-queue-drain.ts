import { clearConfigCache, getHokusaiContributionsConfig } from './config.ts';
import { resolveEnvValue } from './env-file.ts';
import { getContributionConsentStatus } from './hokusai-consent.ts';
import {
  HOKUSAI_CONTRIBUTION_ENDPOINT,
  isLegacyUnscopedContributionEndpoint,
  migrateContributionEndpoint,
} from './hokusai-local-config.ts';
import { appendHokusaiLedgerEntry, type HokusaiRewardStatus } from './hokusai-ledger.ts';
import {
  createSafeFailure,
  markBatchAccepted,
  markBatchPermanentFailure,
  markBatchTransientFailure,
  readPending,
  type PendingBatch,
  type QueueAccessOptions,
} from './hokusai-queue.ts';
import { exportPendingContributions } from './hokusai-queue-export.ts';

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


function normalizeStringField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeTokenReward(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as { tokenReward?: unknown }).tokenReward;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function deriveRewardStatus(tokenReward: number | undefined): HokusaiRewardStatus {
  if (tokenReward === undefined) {
    return 'pending';
  }
  if (tokenReward === 0) {
    return 'none';
  }
  return 'awarded';
}

function earliestQueuedAt(batch: PendingBatch): string | undefined {
  const timestamps = batch.entries
    .map((entry) => entry.enqueuedAt)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) {
    return undefined;
  }
  return new Date(Math.min(...timestamps)).toISOString();
}

function batchQueueProvenance(batch: PendingBatch) {
  const seen = new Set<string>();
  return batch.entries.flatMap((entry) => {
    if (!entry.provenance) {
      return [];
    }
    const key = `${entry.provenance.evalId}:${entry.idempotencyKey}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [entry.provenance];
  });
}

async function postBatch(
  batch: PendingBatch,
  opts: DrainQueueOptions,
  config = getHokusaiContributionsConfig(opts.repoDir),
): Promise<
{ status: 'accepted'; jobIds: string[]; jobId?: string; submissionId?: string; tokenReward?: number }
| { status: 'transient' | 'permanent'; error: string; httpStatus?: number }
> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const token = resolveEnvValue([config.endpointTokenEnv, 'HOKUSAI_API_KEY'], opts.repoDir) || '';

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
      return { status: 'accepted', jobIds: [] };
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

    return {
      status: 'accepted',
      jobIds: normalizeJobIds(parsed),
      jobId: normalizeStringField(parsed, 'jobId'),
      submissionId: normalizeStringField(parsed, 'submissionId'),
      tokenReward: normalizeTokenReward(parsed),
    };
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

  let config = getHokusaiContributionsConfig(opts.repoDir);
  if (config.endpoint && isLegacyUnscopedContributionEndpoint(config.endpoint)) {
    const migration = migrateContributionEndpoint({ repoDir: opts.repoDir });
    if (migration.action === 'migrated') {
      console.warn(`[hokusai] migrated legacy unscoped endpoint -> ${migration.to}`);
    } else {
      console.warn(`[hokusai] legacy unscoped endpoint configured; using canonical endpoint for this drain -> ${HOKUSAI_CONTRIBUTION_ENDPOINT}`);
    }
    clearConfigCache(opts.repoDir);
    config = getHokusaiContributionsConfig(opts.repoDir);
    if (config.endpoint && isLegacyUnscopedContributionEndpoint(config.endpoint)) {
      config = { ...config, endpoint: HOKUSAI_CONTRIBUTION_ENDPOINT };
    }
  }

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
  const submittedAt = now.toISOString();
  const posted = await postBatch(batch, opts, config);

  if (posted.status === 'accepted') {
    await markBatchAccepted(batch, { jobIds: posted.jobIds }, opts);
    const acceptedAt = (opts.now ?? new Date()).toISOString();
    const queueProvenance = batchQueueProvenance(batch);
    appendHokusaiLedgerEntry({
      schemaVersion: 1,
      eventType: 'accepted',
      timestamp: acceptedAt,
      modelId: '30',
      idempotencyKey: batch.idempotencyKey,
      batchId: batch.entries[0]?.entryId ?? batch.idempotencyKey,
      ...(posted.jobId ? { jobId: posted.jobId } : {}),
      ...(posted.jobIds.length > 0 ? { jobIds: posted.jobIds } : {}),
      ...(posted.submissionId ? { submissionId: posted.submissionId } : {}),
      rowCount: batch.entries.length,
      ...(earliestQueuedAt(batch) ? { queuedAt: earliestQueuedAt(batch) } : {}),
      submittedAt,
      acceptedAt,
      rewardStatus: deriveRewardStatus(posted.tokenReward),
      ...(posted.tokenReward !== undefined ? { tokenReward: posted.tokenReward } : {}),
      ...(queueProvenance.length > 0 ? { queueProvenance } : {}),
    }, opts);
    console.log(
      `[hokusai] contribution drain accepted rows=${batch.entries.length}` +
      `${posted.jobIds.length > 0 ? ` jobs=${posted.jobIds.join(',')}` : ''}`,
    );
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
    const rejectedAt = (opts.now ?? new Date()).toISOString();
    const queueProvenance = batchQueueProvenance(batch);
    appendHokusaiLedgerEntry({
      schemaVersion: 1,
      eventType: 'rejected',
      timestamp: rejectedAt,
      modelId: '30',
      idempotencyKey: batch.idempotencyKey,
      batchId: batch.entries[0]?.entryId ?? batch.idempotencyKey,
      rowCount: batch.entries.length,
      ...(earliestQueuedAt(batch) ? { queuedAt: earliestQueuedAt(batch) } : {}),
      submittedAt,
      rejectedAt,
      rewardStatus: 'unknown',
      errorCode: 'permanent_http_failure',
      summary: posted.error,
      ...(queueProvenance.length > 0 ? { queueProvenance } : {}),
    }, opts);
    const endpointHint = posted.httpStatus === 404
      ? ` endpoint=${config.endpoint}` +
        ` hint: the API is model-scoped at /api/v1/models/{model_id}/contributions;` +
        ` run \`wavemill hokusai migrate\` if your overlay pins the legacy path.`
      : '';
    console.warn(
      `[hokusai] contribution drain rejected rows=${batch.entries.length} error=${posted.error}${endpointHint}`,
    );
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
  if (retryStatus === 'dead_lettered') {
    const rejectedAt = (opts.now ?? new Date()).toISOString();
    const queueProvenance = batchQueueProvenance(batch);
    appendHokusaiLedgerEntry({
      schemaVersion: 1,
      eventType: 'rejected',
      timestamp: rejectedAt,
      modelId: '30',
      idempotencyKey: batch.idempotencyKey,
      batchId: batch.entries[0]?.entryId ?? batch.idempotencyKey,
      rowCount: batch.entries.length,
      ...(earliestQueuedAt(batch) ? { queuedAt: earliestQueuedAt(batch) } : {}),
      submittedAt,
      rejectedAt,
      rewardStatus: 'unknown',
      errorCode: 'transient_exhausted',
      summary: 'Contribution submission retries exhausted',
      ...(queueProvenance.length > 0 ? { queueProvenance } : {}),
    }, opts);
    console.warn(
      `[hokusai] contribution drain rejected rows=${batch.entries.length} error=Contribution submission retries exhausted`,
    );
  } else {
    console.warn(
      `[hokusai] contribution drain retry_scheduled rows=${batch.entries.length} nextAttemptAt=${nextAttemptAt} error=${posted.error}`,
    );
  }

  return {
    status: retryStatus,
    nextAttemptAt,
    error: posted.error,
  };
}
