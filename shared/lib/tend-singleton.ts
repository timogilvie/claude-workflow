import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type TendLockOutcome = 'started' | 'skipped' | 'recovered-stale';

export type TendLockResult = {
  outcome: TendLockOutcome;
  holderPid?: number;
  release: () => void;
};

type AcquireTendLockOptions = {
  repoDir: string;
  session?: string;
  logger?: (message: string) => void;
};

const DEFAULT_SESSION = 'default';
const SESSION_PATTERN = /^[A-Za-z0-9_.-]+$/;

function noop(): void {}

export function computeLockKey(repoDir: string, session?: string): string {
  const resolvedRepoDir = path.resolve(repoDir);
  const sessionKey = session ?? DEFAULT_SESSION;
  const repoHash = createHash('sha256').update(resolvedRepoDir).digest('hex').slice(0, 12);
  return `${repoHash}-${sessionKey}`;
}

export function getLockPath(repoDir: string, lockKey: string): string {
  return path.join(repoDir, '.wavemill', 'locks', `tend-${lockKey}.lock`);
}

function validateOptions(repoDir: string, session?: string): void {
  if (!repoDir || !repoDir.trim()) {
    throw new Error('tend-singleton: repoDir is required');
  }
  if (session !== undefined && !SESSION_PATTERN.test(session)) {
    throw new Error(`tend-singleton: invalid session "${session}"`);
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function readRecordedPid(lockPath: string): number | null {
  const raw = readFileSync(lockPath, 'utf-8').trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return Number.parseInt(raw, 10);
}

function releaseOwnedLock(lockPath: string, ownerPid: number): void {
  try {
    const currentPid = readRecordedPid(lockPath);
    if (currentPid !== ownerPid) {
      return;
    }
    unlinkSync(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

function registerCleanup(lockPath: string, ownerPid: number): () => void {
  let released = false;

  const release = () => {
    if (released) {
      return;
    }
    released = true;
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    releaseOwnedLock(lockPath, ownerPid);
  };

  const onExit = () => {
    release();
  };
  const onSigint = () => {
    release();
  };
  const onSigterm = () => {
    release();
  };

  process.once('exit', onExit);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  return release;
}

function logOutcome(
  logger: (message: string) => void,
  repoDir: string,
  session: string,
  outcome: TendLockOutcome,
  holderPid?: number,
): void {
  const details = [`repo=${path.resolve(repoDir)}`, `session=${session}`];
  if (holderPid !== undefined) {
    details.push(`pid=${holderPid}`);
  }
  logger(`[tend-singleton] ${outcome} ${details.join(' ')}`);
}

function tryCreateLock(lockPath: string, ownerPid: number): (() => void) | null {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(fd, `${ownerPid}\n`, 'utf-8');
    } finally {
      closeSync(fd);
    }
    return registerCleanup(lockPath, ownerPid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return null;
    }
    throw error;
  }
}

export function acquireTendLock({ repoDir, session, logger = console.error }: AcquireTendLockOptions): TendLockResult {
  if (process.env.WAVEMILL_TEND_SINGLETON_DISABLE === '1') {
    return { outcome: 'started', release: noop };
  }

  validateOptions(repoDir, session);

  const resolvedRepoDir = path.resolve(repoDir);
  const sessionKey = session ?? DEFAULT_SESSION;
  const lockKey = computeLockKey(resolvedRepoDir, sessionKey);
  const lockPath = getLockPath(resolvedRepoDir, lockKey);
  mkdirSync(path.dirname(lockPath), { recursive: true });

  const release = tryCreateLock(lockPath, process.pid);
  if (release) {
    logOutcome(logger, resolvedRepoDir, sessionKey, 'started', process.pid);
    return { outcome: 'started', release };
  }

  const skip = (holderPid?: number): TendLockResult => {
    logOutcome(logger, resolvedRepoDir, sessionKey, 'skipped', holderPid);
    return { outcome: 'skipped', holderPid, release: noop };
  };

  const recover = (holderPid?: number): TendLockResult => {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return skip(holderPid);
      }
    }

    const retriedRelease = tryCreateLock(lockPath, process.pid);
    if (!retriedRelease) {
      return skip(holderPid);
    }

    logOutcome(logger, resolvedRepoDir, sessionKey, 'recovered-stale', holderPid);
    return {
      outcome: 'recovered-stale',
      holderPid,
      release: retriedRelease,
    };
  };

  let holderPid: number | null = null;
  try {
    holderPid = readRecordedPid(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const retriedRelease = tryCreateLock(lockPath, process.pid);
      if (retriedRelease) {
        logOutcome(logger, resolvedRepoDir, sessionKey, 'started', process.pid);
        return { outcome: 'started', release: retriedRelease };
      }
      return skip();
    }
    throw error;
  }

  if (holderPid === null) {
    return recover();
  }

  if (!pidIsAlive(holderPid)) {
    return recover(holderPid);
  }

  return skip(holderPid);
}
