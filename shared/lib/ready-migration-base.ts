import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const refreshedRefs = new Set<string>();

export interface RefreshBaseForMigrationDeps {
  execFile: typeof execFileAsync;
}

export interface RefreshBaseForMigrationOptions {
  enabled?: boolean;
  timeoutSeconds?: number;
}

const defaultDeps: RefreshBaseForMigrationDeps = {
  execFile: execFileAsync,
};

export async function refreshBaseForMigration(
  repoDir: string,
  baseRef: string,
  options: RefreshBaseForMigrationOptions = {},
  deps: RefreshBaseForMigrationDeps = defaultDeps,
): Promise<{ refreshed: boolean; skipped?: boolean; reason?: string; rawError?: string }> {
  if (options.enabled === false) {
    return { refreshed: false, skipped: true, reason: 'disabled-by-config' };
  }
  if (!baseRef.trim()) {
    return { refreshed: false, skipped: true, reason: 'missing-base-ref' };
  }

  const cacheKey = `${repoDir}::${baseRef}`;
  if (refreshedRefs.has(cacheKey)) {
    return { refreshed: true, skipped: true, reason: 'already-refreshed' };
  }

  try {
    await deps.execFile('git', ['fetch', '--no-tags', 'origin', baseRef], {
      cwd: repoDir,
      timeout: (options.timeoutSeconds ?? 30) * 1000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    refreshedRefs.add(cacheKey);
    return { refreshed: true };
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error);
    return {
      refreshed: false,
      skipped: true,
      reason: 'fetch-failed',
      rawError,
    };
  }
}
