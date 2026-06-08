import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { refreshBaseForMigration } from './ready-migration-base.ts';

test('refreshBaseForMigration reports success after fetch', async () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'ready-migration-base-'));
  try {
    const result = await refreshBaseForMigration(repoDir, 'main', {}, {
      execFile: async () => ({ stdout: '', stderr: '' }),
    });
    assert.deepEqual(result, { refreshed: true });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('refreshBaseForMigration converts fetch failures into skipped outcomes', async () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'ready-migration-base-'));
  try {
    const result = await refreshBaseForMigration(repoDir, 'main', {}, {
      execFile: async () => {
        throw new Error('fatal: unable to access origin');
      },
    });
    assert.equal(result.refreshed, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'fetch-failed');
    assert.match(result.rawError ?? '', /unable to access origin/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('refreshBaseForMigration respects disabled config', async () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'ready-migration-base-'));
  try {
    const result = await refreshBaseForMigration(repoDir, 'main', { enabled: false }, {
      execFile: async () => {
        throw new Error('should not run');
      },
    });
    assert.deepEqual(result, {
      refreshed: false,
      skipped: true,
      reason: 'disabled-by-config',
    });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('refreshBaseForMigration caches successful fetches per repo/base pair', async () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'ready-migration-base-'));
  let calls = 0;
  try {
    const deps = {
      execFile: async () => {
        calls += 1;
        return { stdout: '', stderr: '' };
      },
    };
    const first = await refreshBaseForMigration(repoDir, 'main', {}, deps);
    const second = await refreshBaseForMigration(repoDir, 'main', {}, deps);
    assert.equal(first.refreshed, true);
    assert.equal(second.refreshed, true);
    assert.equal(second.reason, 'already-refreshed');
    assert.equal(calls, 1);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
