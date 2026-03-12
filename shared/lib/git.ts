/**
 * Git utilities for branch management and repository state checks.
 *
 * @module git
 */

import { toKebabCase } from './string-utils.js';
import { execShellCommand } from './shell-utils.ts';

/**
 * Sanitize a string for use as a git branch name.
 *
 * Converts the input to kebab-case and prefixes it with the specified prefix.
 *
 * @param name - The name to sanitize
 * @param prefix - The branch prefix (default: 'feature')
 * @returns The sanitized branch name
 *
 * @example
 * ```typescript
 * sanitizeBranchName('Add User Auth', 'feature');
 * // Returns: 'feature/add-user-auth'
 * ```
 */
export const sanitizeBranchName = (name: string, prefix: string = 'feature'): string => {
  const sanitized = toKebabCase(name, 50);
  return `${prefix}/${sanitized}`;
};

/**
 * Ensure the git working tree is clean (no uncommitted changes).
 *
 * @throws {Error} If the working tree has uncommitted changes
 *
 * @example
 * ```typescript
 * ensureCleanTree(); // Throws if working tree is dirty
 * ```
 */
export const ensureCleanTree = (): void => {
  const status = execShellCommand('git status --porcelain', { encoding: 'utf-8' }).trim();
  if (status) {
    throw new Error('Working tree is dirty. Commit or stash changes before proceeding.');
  }
};
