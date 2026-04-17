import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { QuotaSnapshot, QuotaStatus } from './quota-state.ts';
import {
  CONSTRAINED_TRIGGER_STATUS,
  deriveOperatingMode,
  getCurrentOperatingMode,
  PREMIUM_MODEL_CLASS,
  SURVIVAL_TRIGGER_STATUS,
} from './operating-mode.ts';

let tempRoot: string;
let repoDir: string;

function git(command: string, cwd: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}

function createRepoDir(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  git('init', dir);
  git('config user.name "Test User"', dir);
  git('config user.email "test@example.com"', dir);
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf-8');
  git('add README.md', dir);
  git('commit -m "init"', dir);
  return dir;
}

function makeSnapshot(models: Record<string, QuotaStatus>): QuotaSnapshot {
  return {
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, status]) => [modelId, {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
      }]),
    ),
    snapshotAt: '2026-04-17T12:00:00.000Z',
  };
}

function writeQuotaState(models: Record<string, QuotaStatus>): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'quota-state.json'), JSON.stringify({
    version: 1,
    updatedAt: '2026-04-17T12:00:00.000Z',
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, status]) => [modelId, {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      }]),
    ),
  }, null, 2), 'utf-8');
}

describe('operating-mode', () => {
  beforeEach(() => {
    tempRoot = join(
      tmpdir(),
      `operating-mode-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    repoDir = createRepoDir('repo');
  });

  afterEach(() => {
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('exports the premium model class and trigger statuses', () => {
    assert.equal(PREMIUM_MODEL_CLASS, 'frontier');
    assert.equal(CONSTRAINED_TRIGGER_STATUS, 'degrading');
    assert.equal(SURVIVAL_TRIGGER_STATUS, 'exhausted');
  });

  it('returns normal for an empty snapshot', () => {
    assert.equal(deriveOperatingMode(makeSnapshot({}), ['claude-opus-4-7']), 'normal');
  });

  it('returns normal when only non-premium models are tracked', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({
        'claude-sonnet-4-6': 'degrading',
        'claude-haiku-4-5-20251001': 'exhausted',
      }), ['claude-opus-4-7']),
      'normal',
    );
  });

  it('returns normal when tracked premium models are healthy', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({ 'claude-opus-4-7': 'healthy' }), ['claude-opus-4-7']),
      'normal',
    );
  });

  it('returns constrained when a premium model is degrading', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({ 'claude-opus-4-7': 'degrading' }), ['claude-opus-4-7']),
      'constrained',
    );
  });

  it('returns survival when a premium model is exhausted', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({ 'claude-opus-4-7': 'exhausted' }), ['claude-opus-4-7']),
      'survival',
    );
  });

  it('returns constrained when one premium model is degrading and another is healthy', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({
        'claude-opus-4-7': 'degrading',
        'claude-opus-4-6': 'healthy',
      }), ['claude-opus-4-7', 'claude-opus-4-6']),
      'constrained',
    );
  });

  it('returns survival when any premium model is exhausted even if another is degrading', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({
        'claude-opus-4-7': 'degrading',
        'claude-opus-4-6': 'exhausted',
      }), ['claude-opus-4-7', 'claude-opus-4-6']),
      'survival',
    );
  });

  it('returns survival when all premium models are exhausted', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({
        'claude-opus-4-7': 'exhausted',
        'claude-opus-4-6': 'exhausted',
      }), ['claude-opus-4-7', 'claude-opus-4-6']),
      'survival',
    );
  });

  it('treats degrading as the constrained boundary', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({ 'claude-opus-4-7': CONSTRAINED_TRIGGER_STATUS }), ['claude-opus-4-7']),
      'constrained',
    );
  });

  it('treats exhausted as the survival boundary', () => {
    assert.equal(
      deriveOperatingMode(makeSnapshot({ 'claude-opus-4-7': SURVIVAL_TRIGGER_STATUS }), ['claude-opus-4-7']),
      'survival',
    );
  });

  it('reads the persisted quota state and returns the matching mode', () => {
    writeQuotaState({ 'claude-opus-4-7': 'degrading' });

    assert.equal(getCurrentOperatingMode(repoDir), 'constrained');
  });

  it('returns normal when no quota state file exists', () => {
    assert.equal(getCurrentOperatingMode(repoDir), 'normal');
  });
});
