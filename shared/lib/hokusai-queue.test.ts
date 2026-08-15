import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import type { ContributionRow } from './hokusai-contribution-schema.ts';
import {
  enqueueContribution,
  hokusaiQueueStatus,
  markBatchAccepted,
  markBatchPermanentFailure,
  readPending,
  requeueDeadLetterEntries,
  type HokusaiQueueEnvelope,
  type HokusaiQueueFailureDetail,
} from './hokusai-queue.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepo(contributionsEnabled = true): { repoDir: string; configDir: string } {
  const repoDir = makeTempDir('hokusai-queue-repo-');
  const configDir = makeTempDir('hokusai-queue-config-');
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify({
    hokusai: {
      dataSubmission: { consentVersion: '1.0' },
      contributions: { enabled: contributionsEnabled, batchSize: 2, endpoint: 'https://example.com/contributions' },
    },
  }, null, 2)}\n`);
  saveUserConfig({
    hokusai: {
      enabled: true,
      consentedAt: '2026-05-30T12:00:00.000Z',
      consentVersion: '1.0',
    },
  }, configDir);
  return { repoDir, configDir };
}

function makeRow(overrides: Partial<ContributionRow> = {}): ContributionRow {
  return {
    success_under_budget: true,
    task_id: 'redacted-task-1',
    harness: 'wavemill',
    actual_cost_usd: 1.2,
    wall_clock_seconds: 34,
    ...overrides,
  };
}

function queuePath(repoDir: string, file: 'pending.jsonl' | 'dead-letter.jsonl'): string {
  return join(repoDir, '.wavemill', 'hokusai', 'queue', file);
}

function statePath(repoDir: string): string {
  return join(repoDir, '.wavemill', 'hokusai', 'state.json');
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, 'utf-8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line) as unknown) : [];
}

function readState(repoDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath(repoDir), 'utf-8')) as Record<string, unknown>;
}

function writeDeadLetterRecords(
  repoDir: string,
  records: Array<{ entry: HokusaiQueueEnvelope; failure: HokusaiQueueFailureDetail }>,
): void {
  const path = queuePath(repoDir, 'dead-letter.jsonl');
  mkdirSync(join(repoDir, '.wavemill', 'hokusai', 'queue'), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8');
}

function writeState(repoDir: string, state: Record<string, unknown>): void {
  mkdirSync(join(repoDir, '.wavemill', 'hokusai'), { recursive: true });
  writeFileSync(statePath(repoDir), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

async function enqueueRows(
  repoDir: string,
  configDir: string,
  taskIds: string[],
): Promise<HokusaiQueueEnvelope[]> {
  const entries: HokusaiQueueEnvelope[] = [];
  for (const taskId of taskIds) {
    const result = await enqueueContribution(makeRow({ task_id: taskId }), { repoDir, configDir });
    assert.equal(result.status, 'enqueued');
    assert.ok(result.entry);
    entries.push(result.entry);
  }
  return entries;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearConfigCache();
});

describe('hokusai-queue', () => {
  it('no-ops when contributions consent is disabled', async () => {
    const { repoDir, configDir } = makeRepo(false);
    const result = await enqueueContribution(makeRow(), { repoDir, configDir });

    assert.equal(result.status, 'disabled');
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai')), false);
  });

  it('appends one JSONL line for a valid row', async () => {
    const { repoDir, configDir } = makeRepo();
    const result = await enqueueContribution(makeRow(), { repoDir, configDir });

    assert.equal(result.status, 'enqueued');
    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const lines = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
  });

  it('skips duplicate rows by idempotency key', async () => {
    const { repoDir, configDir } = makeRepo();
    const first = await enqueueContribution(makeRow(), { repoDir, configDir });
    const second = await enqueueContribution(makeRow(), { repoDir, configDir });

    assert.equal(first.status, 'enqueued');
    assert.equal(second.status, 'duplicate');
    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    assert.equal(readFileSync(pendingPath, 'utf-8').trim().split('\n').length, 1);
  });

  it('re-enqueues different rows separately', async () => {
    const { repoDir, configDir } = makeRepo();
    await enqueueContribution(makeRow({ task_id: 'a' }), { repoDir, configDir });
    await enqueueContribution(makeRow({ task_id: 'b' }), { repoDir, configDir });

    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    assert.equal(readFileSync(pendingPath, 'utf-8').trim().split('\n').length, 2);
  });

  it('rejects malformed rows without writing queue data', async () => {
    const { repoDir, configDir } = makeRepo();
    await assert.rejects(
      enqueueContribution({ actual_cost_usd: 2 } as ContributionRow, { repoDir, configDir }),
    );
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl')), false);
  });

  it('recovers pending rows across restarts when cursor is unchanged', async () => {
    const { repoDir, configDir } = makeRepo();
    await enqueueContribution(makeRow(), { repoDir, configDir });

    const first = readPending({ repoDir, configDir });
    const second = readPending({ repoDir, configDir });

    assert.equal(first.status, 'ready');
    assert.equal(second.status, 'ready');
    assert.equal(first.batch?.idempotencyKey, second.batch?.idempotencyKey);
  });

  it('returns a safe error when state is corrupt', async () => {
    const { repoDir, configDir } = makeRepo();
    await enqueueContribution(makeRow(), { repoDir, configDir });
    writeFileSync(join(repoDir, '.wavemill', 'hokusai', 'state.json'), '{ nope', 'utf-8');

    const result = readPending({ repoDir, configDir });
    assert.equal(result.status, 'corrupt_state');
    assert.match(result.error ?? '', /Failed to parse JSON state file/);
  });

  it('reports queue status with pending counts and no filesystem touch when disabled', async () => {
    const { repoDir, configDir } = makeRepo(false);
    const status = hokusaiQueueStatus({ repoDir, configDir });

    assert.deepEqual(status, {
      enabled: false,
      consentValid: true,
      queueExists: false,
      endpointConfigured: true,
      exportConfigured: false,
      pendingCount: 0,
      deadLetterCount: 0,
      processedLineCount: 0,
      exportLineCount: 0,
      lastError: null,
    });
  });

  describe('requeueDeadLetterEntries', () => {
    const failureA: HokusaiQueueFailureDetail = {
      code: 'permanent_http_failure',
      message: 'Contribution endpoint returned HTTP 404',
      status: 404,
      at: '2026-06-01T12:00:00.000Z',
    };
    const failureB: HokusaiQueueFailureDetail = {
      code: 'transient_exhausted',
      message: 'Contribution endpoint returned HTTP 503',
      status: 503,
      at: '2026-06-02T12:00:00.000Z',
    };

    it('no-ops when contributions consent is disabled', async () => {
      const { repoDir, configDir } = makeRepo(false);
      const result = await requeueDeadLetterEntries({}, { repoDir, configDir });

      assert.equal(result.status, 'disabled');
      assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai')), false);
    });

    it('returns nothing_to_requeue for missing or empty dead-letter queues', async () => {
      const { repoDir, configDir } = makeRepo();

      const missing = await requeueDeadLetterEntries({}, { repoDir, configDir });
      assert.equal(missing.status, 'nothing_to_requeue');
      assert.equal(missing.remaining, 0);

      mkdirSync(join(repoDir, '.wavemill', 'hokusai', 'queue'), { recursive: true });
      writeFileSync(queuePath(repoDir, 'dead-letter.jsonl'), '', 'utf-8');
      const empty = await requeueDeadLetterEntries({}, { repoDir, configDir });
      assert.equal(empty.status, 'nothing_to_requeue');
      assert.equal(empty.remaining, 0);
    });

    it('moves all dead-letter entries back to pending without changing cursor or dedupe keys', async () => {
      const { repoDir, configDir } = makeRepo();
      const entries = await enqueueRows(repoDir, configDir, ['a', 'b']);
      const stateBefore = readState(repoDir);
      writeDeadLetterRecords(repoDir, [
        { entry: entries[0], failure: failureA },
        { entry: entries[1], failure: failureB },
      ]);
      writeState(repoDir, {
        ...stateBefore,
        processedLineCount: 2,
        lastError: failureA,
      });

      const result = await requeueDeadLetterEntries({}, {
        repoDir,
        configDir,
        now: new Date('2026-06-03T12:00:00.000Z'),
      });

      assert.equal(result.status, 'requeued');
      assert.equal(result.requeued.length, 2);
      assert.equal(result.remaining, 0);
      assert.equal(readFileSync(queuePath(repoDir, 'dead-letter.jsonl'), 'utf-8'), '');

      const pendingLines = readJsonl(queuePath(repoDir, 'pending.jsonl')) as HokusaiQueueEnvelope[];
      assert.equal(pendingLines.length, 4);
      const requeued = pendingLines.slice(2);
      assert.deepEqual(requeued.map((entry) => entry.entryId), entries.map((entry) => entry.entryId));
      assert.deepEqual(requeued.map((entry) => entry.idempotencyKey), entries.map((entry) => entry.idempotencyKey));
      assert.deepEqual(requeued.map((entry) => entry.row), entries.map((entry) => entry.row));
      assert.deepEqual(requeued.map((entry) => entry.attempts), [0, 0]);
      assert.deepEqual(requeued.map((entry) => entry.nextAttemptAt), [
        '2026-06-03T12:00:00.000Z',
        '2026-06-03T12:00:00.000Z',
      ]);

      const stateAfter = readState(repoDir);
      assert.equal(stateAfter.processedLineCount, 2);
      assert.deepEqual(stateAfter.recentIdempotencyKeys, stateBefore.recentIdempotencyKeys);
      assert.equal(stateAfter.lastError, null);

      const pending = readPending({ repoDir, configDir, now: new Date('2026-06-03T12:00:00.000Z') });
      assert.equal(pending.status, 'ready');
      assert.deepEqual(pending.batch?.entries.map((entry) => entry.entryId), entries.map((entry) => entry.entryId));
    });

    it('filters by entry id and leaves unmatched records in dead-letter', async () => {
      const { repoDir, configDir } = makeRepo();
      const entries = await enqueueRows(repoDir, configDir, ['a', 'b']);
      writeDeadLetterRecords(repoDir, [
        { entry: entries[0], failure: failureA },
        { entry: entries[1], failure: failureB },
      ]);
      writeState(repoDir, { ...readState(repoDir), processedLineCount: 2 });

      const result = await requeueDeadLetterEntries({ entryId: entries[1].entryId }, { repoDir, configDir });

      assert.equal(result.status, 'requeued');
      assert.deepEqual(result.requeued.map((entry) => entry.entryId), [entries[1].entryId]);
      assert.equal(result.remaining, 1);
      const remaining = readJsonl(queuePath(repoDir, 'dead-letter.jsonl')) as Array<{ entry: HokusaiQueueEnvelope }>;
      assert.deepEqual(remaining.map((record) => record.entry.entryId), [entries[0].entryId]);
    });

    it('filters by failure timestamp', async () => {
      const { repoDir, configDir } = makeRepo();
      const entries = await enqueueRows(repoDir, configDir, ['a', 'b']);
      writeDeadLetterRecords(repoDir, [
        { entry: entries[0], failure: failureA },
        { entry: entries[1], failure: failureB },
      ]);
      writeState(repoDir, { ...readState(repoDir), processedLineCount: 2 });

      const result = await requeueDeadLetterEntries(
        { since: '2026-06-02T00:00:00.000Z' },
        { repoDir, configDir },
      );

      assert.equal(result.status, 'requeued');
      assert.deepEqual(result.requeued.map((entry) => entry.entryId), [entries[1].entryId]);
      assert.equal(result.remaining, 1);
    });

    it('dry-runs without changing queue files or state', async () => {
      const { repoDir, configDir } = makeRepo();
      const entries = await enqueueRows(repoDir, configDir, ['a']);
      writeDeadLetterRecords(repoDir, [{ entry: entries[0], failure: failureA }]);
      writeState(repoDir, { ...readState(repoDir), processedLineCount: 1, lastError: failureA });
      const pendingBefore = readFileSync(queuePath(repoDir, 'pending.jsonl'), 'utf-8');
      const deadLetterBefore = readFileSync(queuePath(repoDir, 'dead-letter.jsonl'), 'utf-8');
      const stateBefore = readFileSync(statePath(repoDir), 'utf-8');

      const result = await requeueDeadLetterEntries({}, { repoDir, configDir, dryRun: true });

      assert.equal(result.status, 'dry_run');
      assert.deepEqual(result.requeued.map((entry) => entry.entryId), [entries[0].entryId]);
      assert.equal(readFileSync(queuePath(repoDir, 'pending.jsonl'), 'utf-8'), pendingBefore);
      assert.equal(readFileSync(queuePath(repoDir, 'dead-letter.jsonl'), 'utf-8'), deadLetterBefore);
      assert.equal(readFileSync(statePath(repoDir), 'utf-8'), stateBefore);
    });

    it('preserves malformed dead-letter lines while moving valid entries', async () => {
      const { repoDir, configDir } = makeRepo();
      const entries = await enqueueRows(repoDir, configDir, ['a']);
      const deadLetterPath = queuePath(repoDir, 'dead-letter.jsonl');
      mkdirSync(join(repoDir, '.wavemill', 'hokusai', 'queue'), { recursive: true });
      writeFileSync(
        deadLetterPath,
        `{ nope\n${JSON.stringify({ entry: entries[0], failure: failureA })}\n${JSON.stringify({ missing: 'entry' })}\n`,
        'utf-8',
      );
      writeState(repoDir, { ...readState(repoDir), processedLineCount: 1 });

      const result = await requeueDeadLetterEntries({}, { repoDir, configDir });

      assert.equal(result.status, 'requeued');
      assert.equal(result.skippedMalformed, 2);
      assert.equal(readFileSync(deadLetterPath, 'utf-8'), `{ nope\n${JSON.stringify({ missing: 'entry' })}\n`);
    });

    it('rejects invalid since values before touching queue files', async () => {
      const { repoDir, configDir } = makeRepo();

      await assert.rejects(
        requeueDeadLetterEntries({ since: 'not-a-date' }, { repoDir, configDir }),
        /Invalid --since timestamp: not-a-date/,
      );
      assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai')), false);
    });

    it('is idempotent when run twice', async () => {
      const { repoDir, configDir } = makeRepo();
      const entries = await enqueueRows(repoDir, configDir, ['a']);
      writeDeadLetterRecords(repoDir, [{ entry: entries[0], failure: failureA }]);
      writeState(repoDir, { ...readState(repoDir), processedLineCount: 1 });

      const first = await requeueDeadLetterEntries({}, { repoDir, configDir });
      const second = await requeueDeadLetterEntries({}, { repoDir, configDir });

      assert.equal(first.status, 'requeued');
      assert.equal(second.status, 'nothing_to_requeue');
    });

    it('does not replay accepted rows behind the cursor', async () => {
      const { repoDir, configDir } = makeRepo();
      await enqueueRows(repoDir, configDir, ['accepted', 'dead']);
      const first = readPending({ repoDir, configDir });
      assert.equal(first.status, 'ready');
      await markBatchAccepted({
        entries: [first.batch!.entries[0]],
        lineCount: 1,
        idempotencyKey: first.batch!.entries[0].idempotencyKey,
      }, { jobIds: ['job-accepted'] }, { repoDir, configDir });

      const second = readPending({ repoDir, configDir });
      assert.equal(second.status, 'ready');
      await markBatchPermanentFailure({
        entries: [second.batch!.entries[0]],
        lineCount: 1,
        idempotencyKey: second.batch!.entries[0].idempotencyKey,
      }, failureA, { repoDir, configDir });

      const result = await requeueDeadLetterEntries({}, {
        repoDir,
        configDir,
        now: new Date('2026-06-03T12:00:00.000Z'),
      });
      const pending = readPending({ repoDir, configDir, now: new Date('2026-06-03T12:00:00.000Z') });

      assert.equal(result.status, 'requeued');
      assert.equal(pending.status, 'ready');
      assert.deepEqual(pending.batch?.entries.map((entry) => entry.row.task_id), ['dead']);
    });
  });
});
