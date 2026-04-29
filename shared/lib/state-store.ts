/**
 * Locked state-file operations with atomic writes.
 *
 * Replaces shell `jq > tmp && mv` patterns with file-lock-protected mutations.
 * All write operations acquire an exclusive lock before reading/modifying/writing state.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

export interface LockOptions {
  /** Maximum time to wait for lock acquisition (milliseconds). Default: 5000 */
  timeout?: number;
  /** Base backoff delay (milliseconds). Default: 50 */
  backoffMs?: number;
  /** Max backoff delay (milliseconds). Default: 200 */
  maxBackoffMs?: number;
}

export interface LockInfo {
  pid: number;
  hostname: string;
  timestamp: number;
}

/**
 * Exit code sentinel for lock timeout failures.
 * Used by CLI to signal lock contention.
 */
export const LOCK_TIMEOUT_EXIT_CODE = 2;

/**
 * Maximum age of a lock file before it's considered stale (milliseconds).
 * Locks older than this with a dead PID can be reclaimed.
 */
const STALE_LOCK_MS = 30_000; // 30 seconds

/**
 * Parse lock file content into structured info.
 */
function parseLockInfo(content: string): LockInfo | null {
  const lines = content.trim().split('\n');
  if (lines.length < 3) return null;

  const pid = parseInt(lines[0], 10);
  const hostname = lines[1];
  const timestamp = parseInt(lines[2], 10);

  if (isNaN(pid) || isNaN(timestamp)) return null;
  return { pid, hostname, timestamp };
}

/**
 * Check if a process is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't actually send a signal, just checks if the process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a lock is stale and can be reclaimed.
 */
function isLockStale(lockInfo: LockInfo): boolean {
  const age = Date.now() - lockInfo.timestamp;
  if (age < STALE_LOCK_MS) return false;

  // Only reclaim if the process is dead
  return !isProcessAlive(lockInfo.pid);
}

/**
 * Acquire an exclusive file lock with retry and stale detection.
 *
 * @param lockPath - Path to the lock file (typically `${targetFile}.lock`)
 * @param opts - Lock acquisition options
 * @returns Cleanup function to release the lock
 * @throws Error with code LOCK_TIMEOUT_EXIT_CODE on timeout
 */
async function acquireLock(lockPath: string, opts: LockOptions = {}): Promise<() => Promise<void>> {
  const timeout = opts.timeout ?? 5000;
  const backoffMs = opts.backoffMs ?? 50;
  const maxBackoffMs = opts.maxBackoffMs ?? 200;

  const startTime = Date.now();
  const lockContent = `${process.pid}\n${os.hostname()}\n${Date.now()}\n`;

  let currentBackoff = backoffMs;

  while (true) {
    try {
      // Try to create lock file exclusively (atomic on POSIX)
      await fs.writeFile(lockPath, lockContent, { flag: 'wx', mode: 0o644 });

      // Success! Return cleanup function
      return async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // Ignore cleanup errors
        }
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;

      // If file exists, check if it's stale
      if (error.code === 'EEXIST') {
        try {
          const existingLock = await fs.readFile(lockPath, 'utf-8');
          const lockInfo = parseLockInfo(existingLock);

          if (lockInfo && isLockStale(lockInfo)) {
            // Reclaim stale lock
            await fs.unlink(lockPath);
            continue; // Try acquiring again immediately
          }
        } catch {
          // If we can't read the lock file, just retry with backoff
        }

        // Check timeout
        if (Date.now() - startTime >= timeout) {
          const timeoutError = new Error(`Lock acquisition timeout after ${timeout}ms`);
          (timeoutError as NodeJS.ErrnoException).code = 'LOCK_TIMEOUT';
          throw timeoutError;
        }

        // Exponential backoff with jitter
        const jitter = Math.random() * 0.3 * currentBackoff; // ±30% jitter
        const sleepTime = Math.min(currentBackoff + jitter, maxBackoffMs);
        await new Promise(resolve => setTimeout(resolve, sleepTime));
        currentBackoff = Math.min(currentBackoff * 1.5, maxBackoffMs);
        continue;
      }

      // Other errors (permission denied, etc.) - propagate
      throw error;
    }
  }
}

/**
 * Execute a function with an exclusive file lock.
 *
 * @param filePath - Path to the target file (lock will be `${filePath}.lock`)
 * @param fn - Function to execute while holding the lock
 * @param opts - Lock acquisition options
 * @returns Result of fn
 * @throws Error with code LOCK_TIMEOUT on timeout
 */
export async function withFileLock<T>(
  filePath: string,
  fn: (current: unknown) => T | Promise<T>,
  opts?: LockOptions
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const releaseLock = await acquireLock(lockPath, opts);

  try {
    // Read current state (if file exists)
    let current: unknown = {};
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      current = JSON.parse(content);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw error;
      // File doesn't exist yet - use empty object
    }

    // Execute user function
    const result = await fn(current);
    return result;
  } finally {
    await releaseLock();
  }
}

/**
 * Atomically write JSON to a file using temp file + rename.
 *
 * @param filePath - Target file path
 * @param value - Value to serialize as JSON
 */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const rand = Math.random().toString(36).substring(2, 8);
  const tempPath = path.join(dir, `.tmp-state-${process.pid}-${rand}.json`);

  try {
    // Write to temp file
    const content = JSON.stringify(value, null, 2) + '\n';
    const handle = await fs.open(tempPath, 'w', 0o644);

    try {
      await handle.writeFile(content, 'utf-8');
      await handle.sync(); // fsync before rename
    } finally {
      await handle.close();
    }

    // Atomic rename (POSIX guarantee when in same directory)
    await fs.rename(tempPath, filePath);
  } catch (err) {
    // Clean up temp file on error
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Read a value at a JSON path (no lock needed - reads are safe).
 *
 * @param filePath - Path to JSON file
 * @param jqPath - jq expression (e.g., '.tasks["HOK-123"]')
 * @returns Parsed JSON value at path, or null if not found
 */
export async function getValue(filePath: string, jqPath: string): Promise<unknown> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const result = execSync(`jq -r '${jqPath}'`, {
      input: content,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    });

    const trimmed = result.trim();
    if (trimmed === 'null') return null;

    try {
      return JSON.parse(trimmed);
    } catch {
      // If it's not valid JSON, return the string
      return trimmed;
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Initialize a file with default JSON if it doesn't exist (locked).
 *
 * @param filePath - Path to JSON file
 * @param defaultValue - Default JSON value
 */
export async function initIfMissing(filePath: string, defaultValue: unknown): Promise<void> {
  await withFileLock(filePath, async (current) => {
    // Check if file exists by trying to stat it
    try {
      await fs.stat(filePath);
      // File exists, do nothing
      return;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        // File doesn't exist, create it
        await atomicWriteJson(filePath, defaultValue);
      } else {
        throw error;
      }
    }
  });
}

/**
 * Run a jq expression on a JSON file with locking.
 *
 * This is the primary workhorse for shell migration. It:
 * 1. Acquires exclusive lock
 * 2. Reads current file content
 * 3. Runs jq subprocess with expression + arguments
 * 4. Writes result atomically
 * 5. Releases lock
 *
 * @param filePath - Path to JSON file
 * @param jqExpression - jq expression to evaluate
 * @param jqArgs - Optional jq arguments (--arg, --argjson, etc.)
 * @returns The transformed JSON value
 *
 * @example
 * ```typescript
 * await runJqLocked('/tmp/state.json',
 *   '.tasks[$issue] = (.tasks[$issue] // {}) + {status: $status}',
 *   ['--arg', 'issue', 'HOK-123', '--arg', 'status', 'complete']
 * );
 * ```
 */
export async function runJqLocked(
  filePath: string,
  jqExpression: string,
  jqArgs: string[] = []
): Promise<unknown> {
  return await withFileLock(filePath, async (current) => {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });

    // Read current content (or use empty object if file doesn't exist)
    let input: string;
    try {
      input = await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        input = '{}';
      } else {
        throw error;
      }
    }

    // Run jq with the expression
    const escapedExpr = jqExpression.replace(/'/g, "'\\''");
    const result = execSync(`jq ${jqArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} '${escapedExpr}'`, {
      input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const parsed = JSON.parse(result);
    await atomicWriteJson(filePath, parsed);
    return parsed;
  });
}
