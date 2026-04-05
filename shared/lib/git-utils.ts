import { execShellCommand } from './shell-utils.ts';
import * as path from 'path';

/**
 * Detect if current directory is in a git worktree and resolve the main repository path.
 *
 * @param repoDir - Directory to check (defaults to current working directory)
 * @returns The main repository path if in a worktree, null if in main repo or on error
 *
 * @example
 * // In main repo
 * resolveMainRepo('/path/to/main/repo') // returns null
 *
 * // In worktree
 * resolveMainRepo('/path/to/worktree') // returns '/path/to/main/repo'
 */
export function resolveMainRepo(repoDir?: string): string | null {
  try {
    const cwd = repoDir || process.cwd();

    // Get the git common directory
    const gitCommonDir = execShellCommand('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'], // Suppress stderr
    }).trim();

    // If the common dir is just '.git', we're in the main repo
    if (gitCommonDir === '.git') {
      return null;
    }

    // If it's an absolute path or relative path that's not '.git',
    // we're in a worktree. Return the parent of the common dir.
    const absoluteCommonDir = path.isAbsolute(gitCommonDir)
      ? gitCommonDir
      : path.resolve(cwd, gitCommonDir);

    // The main repo is the parent of the .git directory
    return path.dirname(absoluteCommonDir);

  } catch (error) {
    // If git command fails (not in a git repo, etc.), return null
    return null;
  }
}

/**
 * Resolve a path that should be relative to the main repository,
 * even when called from a worktree.
 *
 * @param relativePath - Path relative to repo root (e.g., '.wavemill/evals')
 * @param repoDir - Current repo directory (defaults to cwd)
 * @returns Absolute path, resolved from main repo if in worktree
 *
 * @example
 * // In worktree
 * resolveFromMainRepo('.wavemill/evals')
 * // returns '/path/to/main/repo/.wavemill/evals'
 *
 * // In main repo
 * resolveFromMainRepo('.wavemill/evals')
 * // returns '/path/to/main/repo/.wavemill/evals'
 */
export function resolveFromMainRepo(relativePath: string, repoDir?: string): string {
  const cwd = repoDir || process.cwd();
  const mainRepo = resolveMainRepo(cwd);

  // Use main repo if we're in a worktree, otherwise use current dir
  const baseDir = mainRepo || cwd;

  return path.resolve(baseDir, relativePath);
}
