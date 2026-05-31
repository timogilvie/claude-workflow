import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import type { ContributionRow } from './hokusai-contribution-schema.ts';
import {
  enqueueContribution,
  hokusaiQueueStatus,
  readPending,
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
});
