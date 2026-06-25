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
  if (allowlist.generatedPaths.includes(resolved.relativePath)
    || allowlist.wavemillOwnedPaths.includes(resolved.relativePath)) {
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
