import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  LinearApiError,
  classifyLinearError,
  type LinearBatchFailure,
} from './linear.ts';
import {
  compact,
  drain,
  enqueue,
  type PendingRetryRecord,
} from './linear-retry-queue.ts';

const queuePath = (repoDir: string) => join(repoDir, '.wavemill', 'registry', 'linear-retry-queue.jsonl');

function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeRepoDir(): string {
  return mkdtempSync(join(tmpdir(), 'linear-retry-queue-'));
}

function writeRecords(repoDir: string, records: unknown[]): void {
  const path = queuePath(repoDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8');
}

function failure(overrides: Partial<LinearBatchFailure> = {}): LinearBatchFailure {
  return {
    issueId: 'HOK-1',
    error: 'rate limited',
    category: 'rate_limit',
    httpStatus: 429,
    graphqlErrors: [],
    isRetryable: true,
    message: 'rate limited',
    ...overrides,
  };
}

test('classifyLinearError categorizes network, rate limit, auth, graphql, server, client, and unknown errors', () => {
  const network = classifyLinearError(new TypeError('fetch failed'));
  assert.equal(network.category, 'network');
  assert.equal(network.isRetryable, true);

  const rateLimit = classifyLinearError(new LinearApiError('slow down', { httpStatus: 429 }));
  assert.equal(rateLimit.category, 'rate_limit');
  assert.equal(rateLimit.isRetryable, true);

  const auth = classifyLinearError(new LinearApiError('forbidden', { httpStatus: 403 }));
  assert.equal(auth.category, 'auth');
  assert.equal(auth.isRetryable, false);

  const graphql = classifyLinearError(new LinearApiError('invalid transition', {
    category: 'graphql',
    httpStatus: 200,
    graphqlErrors: ['invalid transition'],
  }));
  assert.equal(graphql.category, 'graphql');
  assert.deepEqual(graphql.graphqlErrors, ['invalid transition']);

  const server = classifyLinearError(new LinearApiError('oops', { httpStatus: 500 }));
  assert.equal(server.category, 'server');
  assert.equal(server.isRetryable, true);

  const client = classifyLinearError(new LinearApiError('bad request', { httpStatus: 400 }));
  assert.equal(client.category, 'client');
  assert.equal(client.isRetryable, false);

  const unknown = classifyLinearError('mystery failure');
  assert.equal(unknown.category, 'unknown');
  assert.equal(unknown.isRetryable, false);
});

test('enqueue writes a pending JSONL record', () => {
  const repoDir = makeRepoDir();
  const originalRandom = Math.random;
  Math.random = () => 0;

  try {
    const record = enqueue({
      repoDir,
      now: new Date('2026-05-12T12:00:00.000Z'),
      issueIds: ['HOK-1', 'HOK-2'],
      targetState: 'In Progress',
      lastError: {
        category: 'rate_limit',
        httpStatus: 429,
        graphqlErrors: [],
        isRetryable: true,
        message: 'rate limited',
        error: 'rate limited',
      },
    });

    const records = readJsonl(queuePath(repoDir)) as PendingRetryRecord[];
    assert.equal(records.length, 1);
    assert.equal(records[0].recordType, 'pending');
    assert.deepEqual(records[0].issueIds, ['HOK-1', 'HOK-2']);
    assert.equal(records[0].targetState, 'In Progress');
    assert.equal(records[0].attempts, 1);
    assert.equal(record.id, records[0].id);
    assert.equal(records[0].nextRetryAt, '2026-05-12T12:01:00.000Z');
  } finally {
    Math.random = originalRandom;
  }
});

test('drain appends a tombstone after a successful retry', async () => {
  const repoDir = makeRepoDir();
  writeRecords(repoDir, [{
    schemaVersion: '1.0',
    recordType: 'pending',
    id: 'retry-1',
    enqueuedAt: '2026-05-12T12:00:00.000Z',
    issueIds: ['HOK-1'],
    targetState: 'In Progress',
    attempts: 1,
    nextRetryAt: '2026-05-12T12:00:10.000Z',
    lastError: failure(),
  }]);

  const result = await drain({
    repoDir,
    now: new Date('2026-05-12T12:01:00.000Z'),
    setIssuesStateImpl: async () => ({ updated: ['HOK-1'], failed: [] }),
  });

  const records = readJsonl(queuePath(repoDir)) as Array<{ recordType: string; id: string }>;
  assert.equal(result.succeeded, 1);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.recordType), ['pending', 'tombstone']);
});

test('drain failure increments attempts and updates nextRetryAt', async () => {
  const repoDir = makeRepoDir();
  const originalRandom = Math.random;
  Math.random = () => 0;
  writeRecords(repoDir, [{
    schemaVersion: '1.0',
    recordType: 'pending',
    id: 'retry-2',
    enqueuedAt: '2026-05-12T12:00:00.000Z',
    issueIds: ['HOK-2'],
    targetState: 'In Progress',
    attempts: 1,
    nextRetryAt: '2026-05-12T12:00:10.000Z',
    lastError: failure(),
  }]);

  try {
    const result = await drain({
      repoDir,
      now: new Date('2026-05-12T12:01:00.000Z'),
      setIssuesStateImpl: async () => ({ updated: [], failed: [failure()] }),
    });

    const records = readJsonl(queuePath(repoDir)) as PendingRetryRecord[];
    assert.equal(result.failed, 1);
    assert.equal(records.length, 2);
    assert.equal(records[1].recordType, 'pending');
    assert.equal(records[1].attempts, 2);
    assert.equal(records[1].nextRetryAt, '2026-05-12T12:03:00.000Z');
  } finally {
    Math.random = originalRandom;
  }
});

test('drain skips entries whose nextRetryAt is still in the future', async () => {
  const repoDir = makeRepoDir();
  writeRecords(repoDir, [{
    schemaVersion: '1.0',
    recordType: 'pending',
    id: 'retry-3',
    enqueuedAt: '2026-05-12T12:00:00.000Z',
    issueIds: ['HOK-3'],
    targetState: 'In Progress',
    attempts: 1,
    nextRetryAt: '2026-05-12T12:05:00.000Z',
    lastError: failure({ issueId: 'HOK-3' }),
  }]);

  const result = await drain({
    repoDir,
    now: new Date('2026-05-12T12:01:00.000Z'),
    setIssuesStateImpl: async () => {
      throw new Error('should not run');
    },
  });

  assert.equal(result.processed, 0);
  assert.equal(readJsonl(queuePath(repoDir)).length, 1);
});

test('drain marks entries permanently failed at five attempts', async () => {
  const repoDir = makeRepoDir();
  const errors: string[] = [];
  writeRecords(repoDir, [{
    schemaVersion: '1.0',
    recordType: 'pending',
    id: 'retry-4',
    enqueuedAt: '2026-05-12T12:00:00.000Z',
    issueIds: ['HOK-4'],
    targetState: 'In Progress',
    attempts: 4,
    nextRetryAt: '2026-05-12T12:00:10.000Z',
    lastError: failure({ issueId: 'HOK-4' }),
  }]);

  const result = await drain({
    repoDir,
    now: new Date('2026-05-12T12:01:00.000Z'),
    setIssuesStateImpl: async () => ({ updated: [], failed: [failure({ issueId: 'HOK-4' })] }),
    log: { error: (message: string) => { errors.push(message); } },
  });

  const records = readJsonl(queuePath(repoDir)) as Array<{ recordType: string; attempts?: number }>;
  assert.equal(result.permanentFailures, 1);
  assert.equal(records.length, 2);
  assert.equal(records[1].recordType, 'permanently_failed');
  assert.equal(records[1].attempts, 5);
  assert.equal(errors.length, 1);
});

test('compact removes stale tombstones and permanently failed entries older than 24h', async () => {
  const repoDir = makeRepoDir();
  writeRecords(repoDir, [
    {
      schemaVersion: '1.0',
      recordType: 'pending',
      id: 'keep-pending',
      enqueuedAt: '2026-05-12T12:00:00.000Z',
      issueIds: ['HOK-5'],
      targetState: 'In Progress',
      attempts: 1,
      nextRetryAt: '2026-05-12T12:05:00.000Z',
      lastError: failure({ issueId: 'HOK-5' }),
    },
    {
      schemaVersion: '1.0',
      recordType: 'tombstone',
      id: 'drop-tombstone',
      settledAt: '2026-05-10T10:00:00.000Z',
    },
    {
      schemaVersion: '1.0',
      recordType: 'permanently_failed',
      id: 'drop-permanent',
      failedAt: '2026-05-10T10:00:00.000Z',
      issueIds: ['HOK-6'],
      targetState: 'In Progress',
      attempts: 5,
      lastError: failure({ issueId: 'HOK-6', isRetryable: false, category: 'client', httpStatus: 400 }),
    },
  ]);

  await compact(repoDir, new Date('2026-05-12T12:01:00.000Z'));

  const records = readJsonl(queuePath(repoDir)) as Array<{ id: string; recordType: string }>;
  assert.deepEqual(records, [{
    schemaVersion: '1.0',
    recordType: 'pending',
    id: 'keep-pending',
    enqueuedAt: '2026-05-12T12:00:00.000Z',
    issueIds: ['HOK-5'],
    targetState: 'In Progress',
    attempts: 1,
    nextRetryAt: '2026-05-12T12:05:00.000Z',
    lastError: failure({ issueId: 'HOK-5' }),
  }]);
});
