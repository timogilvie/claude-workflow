/**
 * Shell execution utilities for safe command execution.
 *
 * Fixes DEP0190 warning by properly escaping shell arguments.
 * Use these utilities instead of execSync(..., { shell: '/bin/bash' }) with string interpolation.
 */

import { execSync, execFileSync } from "node:child_process";
import type { ExecSyncOptions, ExecFileSyncOptions } from "node:child_process";

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
 * Default argv-based process execution implementation.
 *
 * Runs an executable directly (no shell) with a literal argv array, so paths and
 * package names containing shell-significant characters (spaces, parentheses,
 * quotes, brackets, glob characters, semicolons, pipes, dollar signs, backticks,
 * and leading dashes) are passed through verbatim.
 */
const defaultExecFileCommand = (
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions
): Buffer | string => {
  // execFileSync never invokes a shell, so argv entries stay literal.
  return execFileSync(file, [...args], options);
};

// Internal seam: tests can override this to inspect argv without spawning real
// grep/git processes. Production code should call execFileCommand(), which always
// dispatches through this mutable reference.
let execFileCommandImpl: typeof defaultExecFileCommand = defaultExecFileCommand;

/**
 * Execute an executable with a literal argv array, without invoking a shell.
 *
 * This is the safe alternative to `execShellCommand` for any command that
 * interpolates dynamic values such as repository paths or package names. Because
 * no shell is involved, metacharacters in arguments cannot break command parsing
 * or trigger command injection.
 *
 * @param file - Executable name or path
 * @param args - Literal argv entries (each passed to the child process verbatim)
 * @param options - Options forwarded to `execFileSync` (cwd, encoding, env, stdio, ...)
 * @returns The command stdout (Buffer by default, string when `encoding` is set)
 */
export function execFileCommand(
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions
): Buffer | string {
  return execFileCommandImpl(file, args, options);
}

/**
 * @internal Test-only seam to override the argv execution helper.
 *
 * Pass `null` to restore the default implementation. Production code must not
 * call this; it exists so tests can assert that callers construct argv with
 * exact literal values without spawning real grep/git processes.
 */
export function _setExecFileCommandForTest(
  fn:
    | ((file: string, args: readonly string[], options?: ExecFileSyncOptions) => Buffer | string)
    | null
): void {
  execFileCommandImpl = fn ?? defaultExecFileCommand;
}
