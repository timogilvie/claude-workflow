/**
 * Base branch resolution with remote fetch.
 *
 * Fetches the configured base branch from a remote, computes merge-base,
 * and detects when the base has advanced compared to a prior resolution.
 *
 * Configuration (defaults in resolveBaseSha/fetchRemoteBase):
 * - remote: 'origin' (use 'upstream' for non-standard remotes)
 * - timeoutSeconds: 30 (network operation timeout)
 * - Fails closed: any fetch error blocks verification with diagnostics
 *
 * Error Handling:
 * - Network errors (timeout, unreachable): FetchError with network_error type
 * - Auth errors (SSH/HTTPS credential): FetchError with auth_error type
 * - Ref not found: FetchError with ref_not_found type
 * - All include diagnostics for troubleshooting
 */

import { execSync } from 'node:child_process';

// ────────────────────────────────────────────────────────────────
// Error Types
// ────────────────────────────────────────────────────────────────

export class FetchError extends Error {
  constructor(
    public type: 'fetch_failed' | 'ref_not_found' | 'network_error' | 'auth_error' | 'unknown',
    public message: string,
    public baseBranch: string,
    public remote: string,
    public diagnostics: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

// ────────────────────────────────────────────────────────────────
// Core Functions
// ────────────────────────────────────────────────────────────────

/**
 * Fetch the remote base branch and return its SHA.
 *
 * @param opts Options including cwd, baseBranch, remote, timeout
 * @returns Object with SHA, remote, and fetchedAt timestamp
 * @throws FetchError on failure
 */
export function fetchRemoteBase(opts: {
  cwd?: string;
  baseBranch: string;
  remote?: string;
  timeoutSeconds?: number;
}): {
  sha: string;
  remote: string;
  fetchedAt: string;
} {
  const cwd = opts.cwd || process.cwd();
  const remote = opts.remote || 'origin';
  const baseBranch = opts.baseBranch;
  const timeoutSeconds = opts.timeoutSeconds || 30;

  try {
    // Fetch the remote branch with timeout (in seconds for git).
    // This updates the local remote-tracking ref (origin/<baseBranch>).
    execSync(`git fetch ${remote} ${baseBranch}`, {
      cwd,
      stdio: 'pipe',
      timeout: timeoutSeconds * 1000,
      encoding: 'utf-8',
    });
  } catch (err) {
    const execErr = err as any;
    let fetchErrorType: FetchError['type'] = 'fetch_failed';
    let diagnostics = '';

    if (execErr.signal === 'SIGTERM' || execErr.message?.includes('timeout')) {
      fetchErrorType = 'network_error';
      diagnostics = `Fetch timed out after ${timeoutSeconds}s. Network may be slow or remote unreachable.`;
    } else if (execErr.message?.includes('not found') || execErr.status === 128) {
      fetchErrorType = 'ref_not_found';
      diagnostics = `Branch '${baseBranch}' not found on remote '${remote}'. Check branch name and remote configuration.`;
    } else if (
      execErr.message?.includes('Permission denied') ||
      execErr.message?.includes('authentication')
    ) {
      fetchErrorType = 'auth_error';
      diagnostics = `Authentication failed for remote '${remote}'. Check credentials and SSH key configuration.`;
    } else {
      diagnostics = execErr.message || 'Unknown fetch error';
    }

    throw new FetchError(
      fetchErrorType,
      `Unable to fetch ${remote}/${baseBranch}: ${fetchErrorType}`,
      baseBranch,
      remote,
      diagnostics,
    );
  }

  // Get the SHA of the fetched remote ref
  let sha: string;
  try {
    sha = execSync(`git rev-parse ${remote}/${baseBranch}`, {
      cwd,
      encoding: 'utf-8',
    }).trim();
  } catch (err) {
    throw new FetchError(
      'ref_not_found',
      `Unable to resolve SHA for ${remote}/${baseBranch}`,
      baseBranch,
      remote,
      `Fetch succeeded but ref is not available. This may indicate a race condition.`,
    );
  }

  return {
    sha,
    remote,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Resolve base branch SHA using fetched remote ref.
 *
 * Fetches the remote base branch, then computes merge-base using the
 * remote-tracking ref (not local).
 *
 * @param opts Options including cwd, baseBranch, remote
 * @returns Object with baseSha and fetchedRef
 * @throws FetchError on fetch failure
 */
export function resolveBaseSha(opts: {
  cwd?: string;
  baseBranch: string;
  remote?: string;
  timeoutSeconds?: number;
}): {
  baseSha: string;
  fetchedRef: string;
} {
  const cwd = opts.cwd || process.cwd();
  const remote = opts.remote || 'origin';
  const baseBranch = opts.baseBranch;

  // Fetch the remote base
  const { sha: fetchedSha } = fetchRemoteBase(opts);

  // Compute merge-base against remote-tracking ref
  let baseSha: string;
  try {
    baseSha = execSync(`git merge-base HEAD ${remote}/${baseBranch}`, {
      cwd,
      encoding: 'utf-8',
    }).trim();
  } catch (err) {
    throw new FetchError(
      'unknown',
      `Unable to compute merge-base with ${remote}/${baseBranch}`,
      baseBranch,
      remote,
      `${(err as Error).message}`,
    );
  }

  return {
    baseSha,
    fetchedRef: `${remote}/${baseBranch}`,
  };
}

/**
 * Detect if the base has advanced by comparing old and new SHAs.
 *
 * @param oldBaseSha Previous base SHA
 * @param newBaseSha Current base SHA
 * @returns True if base has advanced (SHAs differ)
 */
export function detectBaseAdvance(oldBaseSha: string, newBaseSha: string): boolean {
  return oldBaseSha !== newBaseSha;
}
