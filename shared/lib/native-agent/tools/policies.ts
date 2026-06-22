import path from 'node:path';
import type { ToolMetadata, ToolPhase } from './types.ts';

export type ToolPolicyReason = 'phase_denied' | 'path_denied';

export interface ToolPolicyConfig {
  readOnlyPhases?: readonly ToolPhase[];
  pathFieldsByTool?: Readonly<Record<string, readonly string[]>>;
}

export interface ToolPolicyCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolPolicyInput {
  phase: ToolPhase;
  config?: ToolPolicyConfig;
  worktreePath: string;
  registry: readonly ToolMetadata[];
  toolCall: ToolPolicyCall;
}

export interface ToolPolicyAllowDecision {
  kind: 'allow';
}

export interface ToolPolicyDenyDecision {
  kind: 'deny';
  reason: ToolPolicyReason;
  message: string;
}

export type ToolPolicyDecision = ToolPolicyAllowDecision | ToolPolicyDenyDecision;

const ALLOW: ToolPolicyAllowDecision = { kind: 'allow' };
const DEFAULT_READ_ONLY_PHASES: readonly ToolPhase[] = ['planning', 'review'];

export function evaluateBeforeToolCallPolicy(input: ToolPolicyInput): ToolPolicyDecision {
  const worktreeRoot = normalizeWorktreeRoot(input.worktreePath);

  if (isReadOnlyPhase(input.phase, input.config)) {
    const metadata = input.registry.find((tool) => tool.name === input.toolCall.name);
    if (!metadata || metadata.class !== 'read-only' || !metadata.allowedPhases.includes(input.phase)) {
      return deny(
        'phase_denied',
        `phase_denied: tool "${input.toolCall.name}" is not allowed in ${input.phase}`,
      );
    }
  }

  const pathFields = input.config?.pathFieldsByTool?.[input.toolCall.name] ?? [];
  for (const field of pathFields) {
    const configuredPaths = getConfiguredPaths(input.toolCall, field);
    if ('error' in configuredPaths) {
      return deny('path_denied', configuredPaths.error);
    }

    for (const candidate of configuredPaths.paths) {
      const resolved = resolveCandidatePath(worktreeRoot, candidate);
      if (resolved.kind === 'outside') {
        return deny(
          'path_denied',
          `path_denied: '${resolved.displayPath}' resolves outside the worktree`,
        );
      }
    }
  }

  return ALLOW;
}

function deny(reason: ToolPolicyReason, message: string): ToolPolicyDenyDecision {
  return { kind: 'deny', reason, message };
}

function isReadOnlyPhase(phase: ToolPhase, config: ToolPolicyConfig | undefined): boolean {
  return (config?.readOnlyPhases ?? DEFAULT_READ_ONLY_PHASES).includes(phase);
}

function normalizeWorktreeRoot(worktreePath: string): string {
  if (worktreePath.trim() === '') {
    throw new Error('Tool policy requires a non-empty worktreePath');
  }
  return path.posix.resolve('/', toComparablePath(worktreePath));
}

function getConfiguredPaths(
  toolCall: ToolPolicyCall,
  field: string,
): { paths: string[] } | { error: string } {
  const value = toolCall.arguments[field];
  if (value === undefined) {
    return { paths: [] };
  }
  if (typeof value === 'string') {
    return { paths: [value] };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return { paths: value };
  }
  return {
    error: `path_denied: tool "${toolCall.name}" field "${field}" must be a string or string[]`,
  };
}

function resolveCandidatePath(
  worktreeRoot: string,
  candidatePath: string,
): { kind: 'inside'; displayPath: string } | { kind: 'outside'; displayPath: string } {
  const comparable = toComparablePath(candidatePath);
  const displayPath = toDisplayPath(candidatePath);
  const absoluteCandidate = path.posix.isAbsolute(comparable)
    ? path.posix.normalize(comparable)
    : path.posix.resolve(worktreeRoot, comparable);
  const relativePath = path.posix.relative(worktreeRoot, absoluteCandidate);

  if (
    relativePath === '' ||
    (!relativePath.startsWith('../') && relativePath !== '..' && !path.posix.isAbsolute(relativePath))
  ) {
    return { kind: 'inside', displayPath };
  }

  return { kind: 'outside', displayPath };
}

function toComparablePath(rawPath: string): string {
  const normalizedSeparators = rawPath.replace(/\\/g, '/');
  const driveQualified = /^[A-Za-z]:($|\/)/.test(normalizedSeparators)
    ? `/${normalizedSeparators}`
    : normalizedSeparators;
  return path.posix.normalize(driveQualified);
}

function toDisplayPath(rawPath: string): string {
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
  return normalized === '' ? '.' : normalized;
}
