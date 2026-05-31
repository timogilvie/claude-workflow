import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import {
  appendHokusaiLedgerEntry,
  readHokusaiLedger,
  summarizeHokusaiLedger,
  type HokusaiLedgerEntry,
} from './hokusai-ledger.ts';

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
      contributions: { enabled: contributionsEnabled, endpoint: 'https://example.com/contributions' },
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

function baseEntry(overrides: Partial<HokusaiLedgerEntry> = {}): HokusaiLedgerEntry {
  return {
    schemaVersion: 1,
    eventType: 'accepted',
    timestamp: '2026-05-31T12:00:00.000Z',
    modelId: '30',
    idempotencyKey: 'idem-1',
    rowCount: 3,
    rewardStatus: 'pending',
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

describe('hokusai-ledger', () => {
  it('appends one JSONL line when enabled', () => {
    const { repoDir, configDir } = makeRepo(true);
    const result = appendHokusaiLedgerEntry(baseEntry(), { repoDir, configDir });
    assert.deepEqual(result, { written: true });

    const ledgerPath = join(repoDir, '.wavemill', 'hokusai', 'ledger.jsonl');
    const lines = readFileSync(ledgerPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
  });

  it('reads append order', () => {
    const { repoDir, configDir } = makeRepo(true);
    appendHokusaiLedgerEntry(baseEntry({ idempotencyKey: 'a' }), { repoDir, configDir });
    appendHokusaiLedgerEntry(baseEntry({ idempotencyKey: 'b' }), { repoDir, configDir });

    const entries = readHokusaiLedger({ repoDir, configDir });
    assert.equal(entries[0]?.idempotencyKey, 'a');
    assert.equal(entries[1]?.idempotencyKey, 'b');
  });

  it('returns empty array when file is missing', () => {
    const { repoDir, configDir } = makeRepo(true);
    assert.deepEqual(readHokusaiLedger({ repoDir, configDir }), []);
  });

  it('skips malformed JSONL lines', () => {
    const { repoDir, configDir } = makeRepo(true);
    const ledgerPath = join(repoDir, '.wavemill', 'hokusai', 'ledger.jsonl');
    mkdirSync(join(repoDir, '.wavemill', 'hokusai'), { recursive: true });
    writeFileSync(ledgerPath, '{bad json}\n');
    appendHokusaiLedgerEntry(baseEntry(), { repoDir, configDir });

    const entries = readHokusaiLedger({ repoDir, configDir });
    assert.equal(entries.length, 1);
  });

  it('deduplicates by idempotency key in summary', () => {
    const { repoDir, configDir } = makeRepo(true);
    appendHokusaiLedgerEntry(baseEntry({ idempotencyKey: 'same', rowCount: 2, rewardStatus: 'awarded', tokenReward: 5 }), { repoDir, configDir });
    appendHokusaiLedgerEntry(baseEntry({ idempotencyKey: 'same', rowCount: 9, rewardStatus: 'awarded', tokenReward: 5 }), { repoDir, configDir });

    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.acceptedSubmissionCount, 1);
    assert.equal(summary.acceptedRowCount, 9);
    assert.equal(summary.tokenRewards.awarded, 5);
  });

  it('deduplicates by job id even with different idempotency keys', () => {
    const { repoDir, configDir } = makeRepo(true);
    appendHokusaiLedgerEntry(baseEntry({ idempotencyKey: 'a', jobId: 'job-1', rowCount: 2 }), { repoDir, configDir });
    appendHokusaiLedgerEntry(baseEntry({ idempotencyKey: 'b', jobId: 'job-1', rowCount: 3 }), { repoDir, configDir });

    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.acceptedSubmissionCount, 1);
    assert.equal(summary.acceptedRowCount, 3);
  });

  it('treats missing tokenReward as pending', () => {
    const { repoDir, configDir } = makeRepo(true);
    appendHokusaiLedgerEntry(baseEntry({ rewardStatus: 'pending' }), { repoDir, configDir });
    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.tokenRewards.pending, 1);
    assert.equal(summary.tokenRewards.awarded, 0);
  });

  it('treats tokenReward 0 with none status as none', () => {
    const { repoDir, configDir } = makeRepo(true);
    appendHokusaiLedgerEntry(baseEntry({ rewardStatus: 'none', tokenReward: 0 }), { repoDir, configDir });
    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.tokenRewards.none, 1);
  });

  it('sums positive token rewards as awarded', () => {
    const { repoDir, configDir } = makeRepo(true);
    appendHokusaiLedgerEntry(baseEntry({ rewardStatus: 'awarded', tokenReward: 1.5 }), { repoDir, configDir });
    appendHokusaiLedgerEntry(baseEntry({ idempotencyKey: 'idem-2', rewardStatus: 'awarded', tokenReward: 2.5 }), { repoDir, configDir });
    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.tokenRewards.awarded, 4);
  });

  it('no-ops append when opt-in is disabled', () => {
    const { repoDir, configDir } = makeRepo(false);
    const result = appendHokusaiLedgerEntry(baseEntry(), { repoDir, configDir });
    assert.deepEqual(result, { written: false, reason: 'consent_disabled' });
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai', 'ledger.jsonl')), false);
  });

  it('reads existing ledger history after disabling opt-in', () => {
    const enabled = makeRepo(true);
    appendHokusaiLedgerEntry(baseEntry({ rewardStatus: 'awarded', tokenReward: 3 }), enabled);

    const disabled = makeRepo(false);
    const ledgerPath = join(enabled.repoDir, '.wavemill', 'hokusai', 'ledger.jsonl');
    const disabledLedgerPath = join(disabled.repoDir, '.wavemill', 'hokusai', 'ledger.jsonl');
    mkdirSync(join(disabled.repoDir, '.wavemill', 'hokusai'), { recursive: true });
    writeFileSync(disabledLedgerPath, readFileSync(ledgerPath, 'utf-8'));

    const summary = summarizeHokusaiLedger(disabled);
    assert.equal(summary.acceptedSubmissionCount, 1);
    assert.equal(summary.tokenRewards.awarded, 3);
  });
});
