import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { acquireTendLock, computeLockKey, getLockPath } from './tend-singleton.ts';

const tempDirs: string[] = [];

function createRepoDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tend-singleton-'));
  tempDirs.push(dir);
  return dir;
}

function captureLogs(): { logs: string[]; logger: (message: string) => void } {
  const logs: string[] = [];
  return {
    logs,
    logger: (message: string) => {
      logs.push(message);
    },
  };
}

afterEach(() => {
  delete process.env.WAVEMILL_TEND_SINGLETON_DISABLE;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('tend-singleton', () => {
  it('first acquisition returns started and writes the current pid', () => {
    const repoDir = createRepoDir();
    const { logs, logger } = captureLogs();

    const result = acquireTendLock({ repoDir, session: 'session-a', logger });
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir, 'session-a'));

    assert.equal(result.outcome, 'started');
    assert.equal(readFileSync(lockPath, 'utf-8'), `${process.pid}\n`);
    assert.match(logs[0], /\[tend-singleton\] started /);

    result.release();
  });

  it('duplicate acquisition skips when the recorded holder pid is alive', () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir, 'session-a'));

    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n`, 'utf-8');

    const result = acquireTendLock({ repoDir, session: 'session-a', logger });
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.holderPid, process.pid);
  });

  it('recovers a stale lock when the holder pid is gone', () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir, 'session-a'));

    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '2147483647\n', 'utf-8');

    const result = acquireTendLock({ repoDir, session: 'session-a', logger });
    assert.equal(result.outcome, 'recovered-stale');
    assert.equal(result.holderPid, 2147483647);
    assert.equal(readFileSync(lockPath, 'utf-8'), `${process.pid}\n`);

    result.release();
  });

  it('release removes the owned lock file', () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();
    const result = acquireTendLock({ repoDir, session: 'session-a', logger });
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir, 'session-a'));

    result.release();

    assert.equal(existsSync(lockPath), false);
  });

  it('release leaves the file in place if ownership changed', () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();
    const result = acquireTendLock({ repoDir, session: 'session-a', logger });
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir, 'session-a'));

    writeFileSync(lockPath, '999999\n', 'utf-8');
    result.release();

    assert.equal(readFileSync(lockPath, 'utf-8'), '999999\n');
  });

  it('concurrent acquisition yields one started and one skipped result', async () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => acquireTendLock({ repoDir, session: 'session-a', logger })),
      Promise.resolve().then(() => acquireTendLock({ repoDir, session: 'session-a', logger })),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    assert.deepEqual(outcomes, ['skipped', 'started']);

    first.release();
    second.release();
  });

  it('throws on an invalid session name', () => {
    const repoDir = createRepoDir();
    assert.throws(
      () => acquireTendLock({ repoDir, session: '../etc/passwd', logger: () => {} }),
      /invalid session/
    );
  });

  it('uses the default session suffix when none is provided', () => {
    const repoDir = createRepoDir();
    const { logger } = captureLogs();
    const result = acquireTendLock({ repoDir, logger });
    const lockPath = getLockPath(repoDir, computeLockKey(repoDir));

    assert.equal(result.outcome, 'started');
    assert.equal(existsSync(lockPath), true);

    result.release();
  });

  it('disables singleton behavior when the escape hatch env var is set', () => {
    process.env.WAVEMILL_TEND_SINGLETON_DISABLE = '1';
    const repoDir = createRepoDir();

    const result = acquireTendLock({ repoDir, session: 'session-a', logger: () => {} });
    assert.equal(result.outcome, 'started');
    assert.equal(result.release(), undefined);
  });
});
