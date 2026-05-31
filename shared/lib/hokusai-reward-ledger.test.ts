import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import {
  listRewardLedgerEntries,
  recordPendingAcceptedBatch,
  summarizeRewardLedger,
  updateRewardStatus,
} from './hokusai-reward-ledger.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepo(contributionsEnabled = true): { repoDir: string; configDir: string } {
  const repoDir = makeTempDir('hokusai-ledger-repo-');
  const configDir = makeTempDir('hokusai-ledger-config-');
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify({
    hokusai: {
      dataSubmission: { consentVersion: '1.0' },
      contributions: { enabled: contributionsEnabled },
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

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearConfigCache();
});

describe('hokusai-reward-ledger', () => {
  it('is a no-op and does not touch the filesystem when consent gating is disabled', async () => {
    const { repoDir, configDir } = makeRepo(false);
    const result = await recordPendingAcceptedBatch({
      contributionId: 'contrib-1',
      idempotencyKey: 'idem-1',
      rowCount: 1,
      submittedAt: '2026-05-31T12:00:00.000Z',
      acceptedAt: '2026-05-31T12:05:00.000Z',
    }, { repoDir, configDir });

    assert.equal(result.status, 'disabled');
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai')), false);
    assert.deepEqual(listRewardLedgerEntries({ repoDir, configDir }), { status: 'disabled', entries: [] });
  });

  it('records pending accepted batches and summarizes them', async () => {
    const { repoDir, configDir } = makeRepo();
    const recorded = await recordPendingAcceptedBatch({
      contributionId: 'contrib-1',
      batchId: 'batch-1',
      idempotencyKey: 'idem-1',
      rowCount: 3,
      submittedAt: '2026-05-31T12:00:00.000Z',
      acceptedAt: '2026-05-31T12:05:00.000Z',
      hokusaiJobIds: ['job-1'],
    }, { repoDir, configDir });

    assert.equal(recorded.status, 'recorded');
    assert.equal(recorded.entry?.status, 'pending');
    assert.equal(recorded.entry?.tokenAmount, null);

    assert.deepEqual(summarizeRewardLedger({ repoDir, configDir }), {
      status: 'ok',
      entryCount: 1,
      pendingCount: 1,
      acceptedCount: 0,
      rejectedCount: 0,
      totalTokenAmount: 0,
    });
  });

  it('supports nullable token amounts on accepted entries', async () => {
    const { repoDir, configDir } = makeRepo();
    await recordPendingAcceptedBatch({
      contributionId: 'contrib-1',
      idempotencyKey: 'idem-1',
      rowCount: 1,
      submittedAt: '2026-05-31T12:00:00.000Z',
      acceptedAt: '2026-05-31T12:05:00.000Z',
    }, { repoDir, configDir });

    const updated = await updateRewardStatus({
      contributionId: 'contrib-1',
      status: 'accepted',
      acceptedAt: '2026-05-31T12:05:00.000Z',
      tokenAmount: null,
      rewardMetadata: { reward_type: 'async' },
    }, { repoDir, configDir });

    assert.equal(updated.status, 'updated');
    assert.equal(updated.entry?.status, 'accepted');
    assert.equal(updated.entry?.tokenAmount, null);
    assert.deepEqual(updated.entry?.rewardMetadata, { reward_type: 'async' });
  });

  it('deduplicates repeated accepted batches by idempotency key', async () => {
    const { repoDir, configDir } = makeRepo();
    await recordPendingAcceptedBatch({
      contributionId: 'contrib-1',
      batchId: 'batch-1',
      idempotencyKey: 'idem-1',
      rowCount: 1,
      submittedAt: '2026-05-31T12:00:00.000Z',
      acceptedAt: '2026-05-31T12:05:00.000Z',
      hokusaiJobIds: ['job-1'],
    }, { repoDir, configDir });
    await updateRewardStatus({
      contributionId: 'contrib-1',
      status: 'accepted',
      acceptedAt: '2026-05-31T12:05:00.000Z',
      tokenAmount: 7,
    }, { repoDir, configDir });

    await recordPendingAcceptedBatch({
      contributionId: 'contrib-2',
      batchId: 'batch-2',
      idempotencyKey: 'idem-1',
      rowCount: 99,
      submittedAt: '2026-05-31T12:01:00.000Z',
      acceptedAt: '2026-05-31T12:06:00.000Z',
      hokusaiJobIds: ['job-2'],
    }, { repoDir, configDir });

    const listed = listRewardLedgerEntries({ repoDir, configDir });
    assert.equal(listed.status, 'ok');
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0]?.status, 'accepted');
    assert.equal(listed.entries[0]?.tokenAmount, 7);
    assert.deepEqual(listed.entries[0]?.hokusaiJobIds, ['job-1', 'job-2']);
  });

  it('rejects invalid terminal status transitions', async () => {
    const { repoDir, configDir } = makeRepo();
    await recordPendingAcceptedBatch({
      contributionId: 'contrib-1',
      idempotencyKey: 'idem-1',
      rowCount: 1,
      submittedAt: '2026-05-31T12:00:00.000Z',
      acceptedAt: '2026-05-31T12:05:00.000Z',
    }, { repoDir, configDir });
    await updateRewardStatus({
      contributionId: 'contrib-1',
      status: 'rejected',
      rejectionReason: 'schema mismatch',
      tokenAmount: null,
      acceptedAt: null,
    }, { repoDir, configDir });

    await assert.rejects(() => updateRewardStatus({
      contributionId: 'contrib-1',
      status: 'accepted',
      acceptedAt: '2026-05-31T12:05:00.000Z',
      tokenAmount: 1,
    }, { repoDir, configDir }), /Invalid ledger status transition/);
  });

  it('reports corrupt ledger state safely', () => {
    const { repoDir, configDir } = makeRepo();
    const ledgerDir = join(repoDir, '.wavemill', 'hokusai');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, 'reward-ledger.json'), '{ nope', 'utf-8');

    const listed = listRewardLedgerEntries({ repoDir, configDir });
    assert.equal(listed.status, 'corrupt_state');
    assert.equal(listed.entries.length, 0);

    const summary = summarizeRewardLedger({ repoDir, configDir });
    assert.equal(summary.status, 'corrupt_state');
    assert.match(summary.error ?? '', /Failed to parse JSON state file/);
  });
});
