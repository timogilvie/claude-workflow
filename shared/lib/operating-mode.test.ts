import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ModelRegistry } from './model-registry.ts';
import { deriveOperatingMode, getCurrentOperatingMode } from './operating-mode.ts';
import type { QuotaSnapshot, QuotaStatus } from './quota-state.ts';
import { recordLimitError } from './quota-state.ts';

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

function snapshotFromStatuses(models: Record<string, QuotaStatus>): QuotaSnapshot {
  return {
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, status]) => [modelId, {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 0.5,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
      }]),
    ),
    snapshotAt: '2026-04-17T00:00:00.000Z',
  };
}

const TEST_REGISTRY: ModelRegistry = {
  models: {
    'frontier-a': {
      vendor: 'test',
      class: 'frontier',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 1, planning: 1, coding: 1, review: 1, classify: 1 },
    },
    'frontier-b': {
      vendor: 'test',
      class: 'frontier',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 1, planning: 1, coding: 1, review: 1, classify: 1 },
    },
    'strong-a': {
      vendor: 'test',
      class: 'strong_generalist',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 1, planning: 1, coding: 1, review: 1, classify: 1 },
    },
  },
  ladders: {},
};

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

  it('returns normal for an empty snapshot', () => {
    const mode = deriveOperatingMode(snapshotFromStatuses({}), TEST_REGISTRY);
    assert.equal(mode, 'normal');
  });

  it('returns normal when all frontier models are healthy', () => {
    const mode = deriveOperatingMode(
      snapshotFromStatuses({
        'frontier-a': 'healthy',
        'frontier-b': 'healthy',
      }),
      TEST_REGISTRY,
    );

    assert.equal(mode, 'normal');
  });

  it('returns normal when only non-frontier models degrade', () => {
    const mode = deriveOperatingMode(
      snapshotFromStatuses({
        'strong-a': 'degrading',
      }),
      TEST_REGISTRY,
    );

    assert.equal(mode, 'normal');
  });

  it('returns constrained when one frontier model is degrading', () => {
    const mode = deriveOperatingMode(
      snapshotFromStatuses({
        'frontier-a': 'degrading',
        'frontier-b': 'healthy',
      }),
      TEST_REGISTRY,
    );

    assert.equal(mode, 'constrained');
  });

  it('returns survival when one frontier model is exhausted', () => {
    const mode = deriveOperatingMode(
      snapshotFromStatuses({
        'frontier-a': 'exhausted',
      }),
      TEST_REGISTRY,
    );

    assert.equal(mode, 'survival');
  });

  it('returns survival when exhausted and healthy frontier models are mixed', () => {
    const mode = deriveOperatingMode(
      snapshotFromStatuses({
        'frontier-a': 'healthy',
        'frontier-b': 'exhausted',
      }),
      TEST_REGISTRY,
    );

    assert.equal(mode, 'survival');
  });

  it('returns constrained when degrading and healthy frontier models are mixed', () => {
    const mode = deriveOperatingMode(
      snapshotFromStatuses({
        'frontier-a': 'healthy',
        'frontier-b': 'degrading',
      }),
      TEST_REGISTRY,
    );

    assert.equal(mode, 'constrained');
  });

  it('ignores unknown models when deriving operating mode', () => {
    const mode = deriveOperatingMode(
      snapshotFromStatuses({
        'unknown-model': 'exhausted',
      }),
      TEST_REGISTRY,
    );

    assert.equal(mode, 'normal');
  });

  it('reads constrained mode from quota snapshot on disk', () => {
    recordLimitError({ modelId: 'claude-opus-4-7', reason: '429 rate_limit' }, repoDir);

    const mode = getCurrentOperatingMode(repoDir);
    assert.equal(mode, 'constrained');
  });

  it('returns normal when quota snapshot file is missing', () => {
    const mode = getCurrentOperatingMode(repoDir);
    assert.equal(mode, 'normal');
  });
});
