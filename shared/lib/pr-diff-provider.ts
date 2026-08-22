import { execFileSync, spawnSync } from 'node:child_process';
import { ensureLocalComparisonObjects, prNumberFromValue, resolvePrIdentityMetadata } from './pr-comparison.ts';
import { errorMessage } from './error-utils.ts';

export const PR_DIFF_MAX_BYTES = 64 * 1024 * 1024;

export type PrDiffUnavailableReason =
  | 'gh_too_large'
  | 'gh_error'
  | 'buffer_overrun'
  | 'local_diff_failed'
  | 'pr_metadata_missing';

export type PrDiffResult =
  | { kind: 'diff'; text: string; source: 'gh-pr-diff' | 'local-git'; bytes: number; attempts: string[] }
  | { kind: 'unavailable'; reason: PrDiffUnavailableReason; detail: string; attempts: string[] };

export interface PrDiffRunOptions {
  encoding?: 'utf8' | 'buffer';
  maxBytes?: number;
}

export interface PrDiffFetchDeps {
  runGh?: (args: string[], options?: PrDiffRunOptions) => string | Buffer;
  runGit?: (args: string[], options?: PrDiffRunOptions) => string | Buffer;
  maxBytes?: number;
}

type CommandSuccess = { ok: true; stdout: Buffer };
type CommandFailure = { ok: false; stderr: string; error?: Error; status?: number | null };

function configuredMaxBytes(deps?: PrDiffFetchDeps): number {
  if (deps?.maxBytes && Number.isFinite(deps.maxBytes) && deps.maxBytes > 0) {
    return Math.floor(deps.maxBytes);
  }
  const raw = process.env.WAVEMILL_PR_DIFF_MAX_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PR_DIFF_MAX_BYTES;
}

function commandFailureMessage(failure: CommandFailure): string {
  const parts = [failure.stderr.trim(), failure.error?.message].filter(Boolean);
  return parts.join(' ').trim() || `exit ${failure.status ?? 'unknown'}`;
}

function isBufferOverrunFailure(failure: CommandFailure): boolean {
  const code = (failure.error as NodeJS.ErrnoException | undefined)?.code;
  const message = `${failure.error?.message ?? ''}\n${failure.stderr}`;
  return code === 'ENOBUFS' || /maxBuffer|ENOBUFS/i.test(message);
}

export function isTooLargeDiffError(stderr: string): boolean {
  return /HTTP\s+406/i.test(stderr) || /PullRequest\.diff\s+too_large/i.test(stderr) || /\btoo_large\b/i.test(stderr);
}

function defaultRunCommand(command: 'gh' | 'git', repoDir: string, args: string[], maxBytes: number): CommandSuccess | CommandFailure {
  const result = spawnSync(command, args, {
    cwd: repoDir,
    encoding: 'buffer',
    maxBuffer: maxBytes + 1,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
  if (result.error) {
    return { ok: false, stderr, error: result.error, status: result.status };
  }
  if (result.status !== 0) {
    return { ok: false, stderr, status: result.status };
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
  if (stdout.length > maxBytes) {
    return {
      ok: false,
      stderr: `output exceeded ${maxBytes} byte limit`,
      error: Object.assign(new Error(`stdout exceeded ${maxBytes} byte limit`), { code: 'ENOBUFS' }),
      status: result.status,
    };
  }
  return { ok: true, stdout };
}

function injectedRun(
  runner: ((args: string[], options?: PrDiffRunOptions) => string | Buffer) | undefined,
  command: 'gh' | 'git',
  repoDir: string,
  args: string[],
  maxBytes: number,
): CommandSuccess | CommandFailure {
  if (!runner) {
    return defaultRunCommand(command, repoDir, args, maxBytes);
  }
  try {
    const output = runner(args, { encoding: 'buffer', maxBytes });
    const stdout = Buffer.isBuffer(output) ? output : Buffer.from(output, 'utf8');
    if (stdout.length > maxBytes) {
      return {
        ok: false,
        stderr: `output exceeded ${maxBytes} byte limit`,
        error: Object.assign(new Error(`stdout exceeded ${maxBytes} byte limit`), { code: 'ENOBUFS' }),
        status: null,
      };
    }
    return { ok: true, stdout };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const stderr = typeof (error as { stderr?: unknown })?.stderr === 'string'
      ? String((error as { stderr?: unknown }).stderr)
      : err.message;
    return { ok: false, stderr, error: err, status: null };
  }
}

function stringRunner(
  runner: ((args: string[], options?: PrDiffRunOptions) => string | Buffer) | undefined,
  command: 'gh' | 'git',
  repoDir: string,
): (args: string[]) => string {
  if (!runner) {
    return (args) => {
      try {
        return execFileSync(command, args, {
          cwd: repoDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      } catch (error) {
        throw new Error(`${command} ${args.join(' ')} failed: ${errorMessage(error)}`);
      }
    };
  }
  return (args) => {
    const output = runner(args, { encoding: 'utf8' });
    return Buffer.isBuffer(output) ? output.toString('utf8').trim() : output.trim();
  };
}

function fallbackReasonFor(
  ghFailure: CommandFailure | undefined,
  localFailure: unknown,
): PrDiffUnavailableReason {
  const localMessage = errorMessage(localFailure);
  if (/Incomplete PR metadata|Failed to parse PR metadata|gh pr view/i.test(localMessage)) {
    return 'pr_metadata_missing';
  }
  if (ghFailure && isTooLargeDiffError(commandFailureMessage(ghFailure))) {
    return 'gh_too_large';
  }
  if (ghFailure && isBufferOverrunFailure(ghFailure)) {
    return 'buffer_overrun';
  }
  if (/maxBuffer|ENOBUFS|byte limit|too_large/i.test(localMessage)) {
    return 'buffer_overrun';
  }
  return ghFailure ? 'gh_error' : 'local_diff_failed';
}

function fetchLocalDiff(input: {
  prNumber: string;
  repoDir: string;
  deps?: PrDiffFetchDeps;
  maxBytes: number;
  attempts: string[];
}): { kind: 'diff'; text: string; source: 'local-git'; bytes: number; attempts: string[] } {
  const runGh = stringRunner(input.deps?.runGh, 'gh', input.repoDir);
  const runGit = stringRunner(input.deps?.runGit, 'git', input.repoDir);
  const metadata = resolvePrIdentityMetadata(input.prNumber, input.repoDir, { runGh });
  ensureLocalComparisonObjects({
    prNumber: input.prNumber,
    metadata,
    runGit,
  });
  const mergeSha = runGit(['merge-base', `refs/remotes/origin/${metadata.baseRefName}`, metadata.head_sha]).trim();
  const diff = injectedRun(input.deps?.runGit, 'git', input.repoDir, ['diff', mergeSha, metadata.head_sha], input.maxBytes);
  if (!diff.ok) {
    const message = commandFailureMessage(diff);
    input.attempts.push(`local-git: ${message}`);
    throw new Error(message);
  }
  input.attempts.push(`local-git: ok ${diff.stdout.length} bytes`);
  return {
    kind: 'diff',
    text: diff.stdout.toString('utf8'),
    source: 'local-git',
    bytes: diff.stdout.length,
    attempts: input.attempts,
  };
}

export function fetchPrDiff(pr: string, repoDir: string, deps?: PrDiffFetchDeps): PrDiffResult {
  const prNumber = prNumberFromValue(pr);
  const maxBytes = configuredMaxBytes(deps);
  const attempts: string[] = [];

  const ghDiff = injectedRun(deps?.runGh, 'gh', repoDir, ['pr', 'diff', prNumber], maxBytes);
  if (ghDiff.ok) {
    attempts.push(`gh pr diff: ok ${ghDiff.stdout.length} bytes`);
    return {
      kind: 'diff',
      text: ghDiff.stdout.toString('utf8'),
      source: 'gh-pr-diff',
      bytes: ghDiff.stdout.length,
      attempts,
    };
  }

  const ghMessage = commandFailureMessage(ghDiff);
  attempts.push(`gh pr diff: ${ghMessage}`);
  console.warn(`[pr-diff] gh pr diff failed for PR ${prNumber}; trying local git fallback: ${ghMessage}`);

  try {
    return fetchLocalDiff({ prNumber, repoDir, deps, maxBytes, attempts });
  } catch (error) {
    const reason = fallbackReasonFor(ghDiff, error);
    const detail = `gh pr diff failed: ${ghMessage}; local git fallback failed: ${errorMessage(error)}`;
    console.warn(`[pr-diff] PR ${prNumber} diff unavailable (${reason}): ${detail}`);
    return {
      kind: 'unavailable',
      reason,
      detail,
      attempts,
    };
  }
}
