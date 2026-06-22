import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateBeforeToolCallPolicy,
  type ToolPolicyConfig,
} from './policies.ts';
import type { ToolMetadata, ToolPhase } from './types.ts';

function makeMetadata(
  name: string,
  toolClass: ToolMetadata['class'],
  allowedPhases: readonly ToolPhase[] = ['planning', 'coding', 'review'],
): ToolMetadata {
  return {
    name,
    description: `${name} description`,
    class: toolClass,
    allowedPhases,
    executionMode: 'sequential',
    outputCapPolicy: { strategy: 'none' },
  };
}

function evaluate(args: {
  phase: ToolPhase;
  name: string;
  arguments?: Record<string, unknown>;
  registry?: readonly ToolMetadata[];
  worktreePath?: string;
  config?: ToolPolicyConfig;
}) {
  return evaluateBeforeToolCallPolicy({
    phase: args.phase,
    worktreePath: args.worktreePath ?? '/repo',
    registry: args.registry ?? [],
    config: args.config,
    toolCall: {
      name: args.name,
      arguments: args.arguments ?? {},
    },
  });
}

describe('native-agent tool policies', () => {
  it('denies mutation tools in planning', () => {
    const decision = evaluate({
      phase: 'planning',
      name: 'patch_file',
      registry: [makeMetadata('patch_file', 'mutation')],
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'phase_denied',
      message: 'phase_denied: tool "patch_file" is not allowed in planning',
    });
  });

  it('denies unknown tools in review', () => {
    const decision = evaluate({
      phase: 'review',
      name: 'Read_File',
      registry: [makeMetadata('read_file', 'read-only')],
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'phase_denied',
      message: 'phase_denied: tool "Read_File" is not allowed in review',
    });
  });

  it('allows read-only tools in planning', () => {
    const decision = evaluate({
      phase: 'planning',
      name: 'read_file',
      registry: [makeMetadata('read_file', 'read-only', ['planning', 'coding', 'review'])],
    });

    assert.deepEqual(decision, { kind: 'allow' });
  });

  it('denies paths outside the worktree', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'read_file',
      arguments: { path: '../secrets.env' },
      registry: [makeMetadata('read_file', 'read-only')],
      config: { pathFieldsByTool: { read_file: ['path'] } },
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'path_denied',
      message: "path_denied: '../secrets.env' resolves outside the worktree",
    });
  });

  it('allows paths inside the worktree', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'read_file',
      arguments: { path: 'docs/notes.md' },
      registry: [makeMetadata('read_file', 'read-only')],
      config: { pathFieldsByTool: { read_file: ['path'] } },
    });

    assert.deepEqual(decision, { kind: 'allow' });
  });

  it('allows the worktree root path', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'list_dir',
      arguments: { path: '.' },
      registry: [makeMetadata('list_dir', 'read-only')],
      config: { pathFieldsByTool: { list_dir: ['path'] } },
    });

    assert.deepEqual(decision, { kind: 'allow' });
  });

  it('normalizes trailing slashes before boundary checks', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'list_dir',
      arguments: { path: 'docs/' },
      registry: [makeMetadata('list_dir', 'read-only')],
      config: { pathFieldsByTool: { list_dir: ['path'] } },
    });

    assert.deepEqual(decision, { kind: 'allow' });
  });

  it('normalizes Windows-style separators deterministically', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'read_file',
      arguments: { path: '..\\secrets.env' },
      registry: [makeMetadata('read_file', 'read-only')],
      config: { pathFieldsByTool: { read_file: ['path'] } },
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'path_denied',
      message: "path_denied: '../secrets.env' resolves outside the worktree",
    });
  });

  it('denies malformed configured path values without throwing', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'read_file',
      arguments: { path: null },
      registry: [makeMetadata('read_file', 'read-only')],
      config: { pathFieldsByTool: { read_file: ['path'] } },
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'path_denied',
      message: 'path_denied: tool "read_file" field "path" must be a string or string[]',
    });
  });

  it('throws for a missing worktree path', () => {
    assert.throws(
      () => evaluate({ phase: 'coding', name: 'read_file', worktreePath: '   ' }),
      /non-empty worktreePath/,
    );
  });
});
