/**
 * Shell execution utilities for safe command execution.
 *
 * Fixes DEP0190 warning by properly escaping shell arguments.
 * Use these utilities instead of execSync(..., { shell: '/bin/bash' }) with string interpolation.
 */

import { execFileSync, execSync } from "node:child_process";
import type { ExecFileSyncOptions, ExecSyncOptions } from "node:child_process";

export type ExecArgvCommandOptions = Omit<ExecFileSyncOptions, 'shell'>;

/** Result of an argv-based command invocation. */
export interface ExecArgvCommandResult {
  /** Standard output produced by the child process. */
  stdout: string;
  /** Standard error produced by the child process. */
  stderr: string;
  /** Process exit status, or -1 when the process could not be spawned. */
  exitCode: number;
  /** Whether spawning the executable itself failed (for example ENOENT). */
  failed: boolean;
}

function commandOutputToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString();
  return '';
}

/**
 * Escape a string for safe use as a shell argument.
 *
 * Uses single-quote escaping which is the safest approach for arbitrary strings.
 * Handles embedded single quotes by closing quote, escaping, and reopening.
 *
 * @param arg - The string to escape
 * @returns The escaped string, safe for shell interpolation
 *
 * @example
 * ```typescript
 * const file = "user's file.txt";
 * const cmd = `cat ${escapeShellArg(file)}`;
 * // Result: cat 'user'\''s file.txt'
 * ```
 */
export function escapeShellArg(arg: string): string {
  if (arg === '') {
    return "''";
  }

  // Replace single quotes with '\'' (close quote, escaped quote, open quote)
  // Then wrap the whole thing in single quotes
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Execute a shell command with proper escaping.
 *
 * This is a safer alternative to execSync(..., { shell: '/bin/bash' }) that
 * avoids the DEP0190 deprecation warning.
 *
 * Use escapeShellArg() to escape any variables before interpolating them into
 * the command string.
 *
 * @param command - The shell command to execute (with pre-escaped arguments)
 * @param options - Options to pass to execSync (shell option will be set automatically)
 * @returns The command output
 *
 * @example
 * ```typescript
 * const issueId = 'HOK-123';
 * const output = execShellCommand(
 *   `gh issue view ${escapeShellArg(issueId)} --json title`,
 *   { encoding: 'utf-8', cwd: '/path/to/repo' }
 * );
 * ```
 */
export function execShellCommand(
  command: string,
  options?: ExecSyncOptions
): Buffer | string {
  // Force shell to /bin/bash for consistency
  const shellOptions: ExecSyncOptions = {
    ...options,
    shell: '/bin/bash',
  };

  return execSync(command, shellOptions);
}

/**
 * Execute a command with literal argv and no shell.
 *
 * Use this helper when any executable arguments come from repository paths,
 * package names, user input, or other dynamic values. Pipes and redirections
 * are intentionally unsupported; compose those operations in JavaScript.
 */
export function execArgvCommand(
  file: string,
  args: readonly string[],
  options?: ExecArgvCommandOptions
): ExecArgvCommandResult {
  try {
    const stdout = execFileSync(file, [...args], {
      ...options,
      shell: false,
    });
    return { stdout: commandOutputToString(stdout), stderr: '', exitCode: 0, failed: false };
  } catch (error) {
    const commandError = error as {
      code?: string;
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const failed = commandError.code === 'ENOENT';
    return {
      stdout: commandOutputToString(commandError.stdout),
      stderr: commandOutputToString(commandError.stderr),
      exitCode: typeof commandError.status === 'number' ? commandError.status : -1,
      failed,
    };
  }
}
