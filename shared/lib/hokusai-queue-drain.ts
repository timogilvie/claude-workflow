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

  const jobIds = (payload as { jobIds?: unknown }).jobIds;
  if (!Array.isArray(jobIds)) {
    return [];
  }

  return jobIds.filter((jobId): jobId is string => typeof jobId === 'string');
}

async function postBatch(
  batch: PendingBatch,
  opts: DrainQueueOptions,
): Promise<{ status: 'accepted'; jobIds: string[] } | { status: 'transient' | 'permanent'; error: string; httpStatus?: number }> {
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

    return { status: 'accepted', jobIds: normalizeJobIds(parsed) };
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
