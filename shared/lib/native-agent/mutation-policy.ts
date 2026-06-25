import type {
  NormalizedWholeFileWriteAllowlistInput,
  WholeFileWriteAllowlistInput,
} from './coding-artifacts.ts';
import { validateWholeFileWriteAllowlistInput } from './coding-artifacts.ts';
import {
  normalizeWorktreeRoot,
  resolveCandidatePath,
} from './tools/policies.ts';

export type MutationWriteKind = 'patch' | 'whole-file';
export type MutationPolicyReason = 'path_denied' | 'whole_file_source_write_denied';

export interface MutationPolicyInput {
  worktreePath: string;
  targetPath: string;
  writeKind: MutationWriteKind;
  wholeFileAllowlist?: WholeFileWriteAllowlistInput | NormalizedWholeFileWriteAllowlistInput;
}

export interface MutationPolicyAllowDecision {
  kind: 'allow';
  resolvedPath: string;
}

export interface MutationPolicyDenyDecision {
  kind: 'deny';
  reason: MutationPolicyReason;
  message: string;
  resolvedPath?: string;
}

export type MutationPolicyDecision = MutationPolicyAllowDecision | MutationPolicyDenyDecision;

export function evaluateMutationWritePolicy(input: MutationPolicyInput): MutationPolicyDecision {
  const worktreeRoot = normalizeWorktreeRoot(input.worktreePath);
  const resolved = resolveCandidatePath(worktreeRoot, input.targetPath);

  if (resolved.kind === 'outside') {
    return {
      kind: 'deny',
      reason: 'path_denied',
      message: `path_denied: '${resolved.displayPath}' resolves outside the active worktree`,
      resolvedPath: resolved.displayPath,
    };
  }

  if (input.writeKind === 'patch') {
    return {
      kind: 'allow',
      resolvedPath: resolved.relativePath,
    };
  }

  const allowlist = normalizeWholeFileAllowlist(input.wholeFileAllowlist);
  if (matchesAllowlistPattern(allowlist.generatedPaths, resolved.relativePath)
    || matchesAllowlistPattern(allowlist.wavemillOwnedPaths, resolved.relativePath)) {
    return {
      kind: 'allow',
      resolvedPath: resolved.relativePath,
    };
  }

  return {
    kind: 'deny',
    reason: 'whole_file_source_write_denied',
    message: `whole_file_source_write_denied: '${resolved.relativePath}' is not generated or Wavemill-owned`,
    resolvedPath: resolved.relativePath,
  };
}

function normalizeWholeFileAllowlist(
  input: MutationPolicyInput['wholeFileAllowlist'],
): NormalizedWholeFileWriteAllowlistInput {
  const result = validateWholeFileWriteAllowlistInput(input ?? {});
  if (!result.ok) {
    const [firstError] = result.errors;
    throw new Error(firstError?.message ?? 'Whole-file allowlist input is invalid.');
  }
  return result.value;
}

function matchesAllowlistPattern(patterns: readonly string[], candidate: string): boolean {
  for (const pattern of patterns) {
    if (pattern === candidate) {
      return true;
    }
    if (containsGlobChar(pattern) && matchesGlob(pattern, candidate)) {
      return true;
    }
  }
  return false;
}

function containsGlobChar(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/**
 * Match a POSIX glob pattern against a normalized POSIX path.
 *
 * Supports `*` (no `/`), `**` (any path including `/`), and `?` (single char,
 * no `/`). Patterns and candidates are assumed to be repo-relative POSIX paths
 * already normalized by `normalizePatchPath`.
 */
function matchesGlob(pattern: string, candidate: string): boolean {
  const regex = globPatternToRegex(pattern);
  return regex.test(candidate);
}

function globPatternToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        regex += '.*';
        i += 2;
        if (pattern[i] === '/') {
          i += 1;
        }
        continue;
      }
      regex += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      regex += '[^/]';
      i += 1;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      regex += `\\${ch}`;
      i += 1;
      continue;
    }
    regex += ch;
    i += 1;
  }
  return new RegExp(`^${regex}$`);
}
