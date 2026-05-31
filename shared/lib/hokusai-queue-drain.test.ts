import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import type { ContributionRow } from './hokusai-contribution-schema.ts';
import { drainContributionQueue } from './hokusai-queue-drain.ts';
import { enqueueContribution, hokusaiQueueStatus, readPending } from './hokusai-queue.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepo(overrides: Record<string, unknown> = {}): { repoDir: string; configDir: string } {
  const repoDir = makeTempDir('hokusai-drain-repo-');
  const configDir = makeTempDir('hokusai-drain-config-');
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify({
    hokusai: {
      dataSubmission: { consentVersion: '1.0' },
      contributions: {
        enabled: true,
        endpoint: 'https://example.com/contributions',
        batchSize: 2,
        maxRetries: 2,
        backoffInitialMs: 1000,
        backoffMaxMs: 1000,
        timeoutMs: 2000,
        ...overrides,
      },
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

function makeRow(taskId: string): ContributionRow {
  return {
    success_under_budget: true,
    task_id: taskId,
    harness: 'wavemill',
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

describe('hokusai-queue-drain', () => {
  it('does not fetch when consent/config gate is disabled', async () => {
    const { repoDir, configDir } = makeRepo({ enabled: false });
    let called = false;

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => {
        called = true;
        return new Response(null, { status: 204 });
      },
    });

    assert.equal(result.status, 'disabled');
    assert.equal(called, false);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai')), false);
  });

  it('accepts 200 responses and records returned job ids', async () => {
    const { repoDir, configDir } = makeRepo({ batchSize: 1 });
    await enqueueContribution(makeRow('a'), { repoDir, configDir });

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(JSON.stringify({ jobIds: ['job-1'] }), { status: 200 }),
    });

    assert.equal(result.status, 'uploaded');
    assert.deepEqual(result.jobIds, ['job-1']);
    assert.equal(hokusaiQueueStatus({ repoDir, configDir }).processedLineCount, 1);
  });

  it('accepts 204 empty responses', async () => {
    const { repoDir, configDir } = makeRepo();
    await enqueueContribution(makeRow('a'), { repoDir, configDir });

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    assert.equal(result.status, 'uploaded');
    assert.deepEqual(result.jobIds, []);
  });

  it('drains more than batchSize in bounded batches', async () => {
    const { repoDir, configDir } = makeRepo();
    await enqueueContribution(makeRow('a'), { repoDir, configDir });
    await enqueueContribution(makeRow('b'), { repoDir, configDir });
    await enqueueContribution(makeRow('c'), { repoDir, configDir });

    const first = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    const second = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    assert.equal(first.uploadedCount, 2);
    assert.equal(second.uploadedCount, 1);
  });

  it('retries transient network failures with backoff', async () => {
    const { repoDir, configDir } = makeRepo();
    const now = new Date('2026-05-31T12:00:00.000Z');
    await enqueueContribution(makeRow('a'), { repoDir, configDir, now });

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      now,
      random: () => 1,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });

    assert.equal(result.status, 'retry_scheduled');
    const pending = readPending({
      repoDir,
      configDir,
      now: new Date('2026-05-31T12:00:00.500Z'),
    });
    assert.equal(pending.status, 'waiting');
  });

  it('moves exhausted transient failures to dead-letter', async () => {
    const { repoDir, configDir } = makeRepo({ maxRetries: 1 });
    await enqueueContribution(makeRow('a'), { repoDir, configDir });

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response('oops', { status: 503 }),
    });

    assert.equal(result.status, 'dead_lettered');
    const deadLetterPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'dead-letter.jsonl');
    assert.equal(readFileSync(deadLetterPath, 'utf-8').trim().split('\n').length, 1);
  });

  it('moves permanent failures to dead-letter and allows later batches to continue', async () => {
    const { repoDir, configDir } = makeRepo({ batchSize: 1 });
    await enqueueContribution(makeRow('a'), { repoDir, configDir });
    await enqueueContribution(makeRow('b'), { repoDir, configDir });

    const first = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { rows: Array<{ task_id?: string }> };
        const firstTask = body.rows[0]?.task_id;
        return firstTask === 'a'
          ? new Response(JSON.stringify({ error: 'bad row' }), { status: 422 })
          : new Response(null, { status: 204 });
      },
    });
    const second = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    assert.equal(first.status, 'permanent_failure');
    assert.equal(second.status, 'uploaded');
  });
});
