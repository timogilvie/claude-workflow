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

  it('denies mutation paths outside the worktree', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'write_file',
      arguments: { path: '../outside.ts', content: 'export const leaked = true;\n' },
      registry: [makeMetadata('write_file', 'mutation')],
      config: { pathFieldsByTool: { write_file: ['path'] } },
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'path_denied',
      message: "path_denied: '../outside.ts' resolves outside the worktree",
    });
  });

  it('denies whole-file source writes by default', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'write_file',
      arguments: { path: 'src/app.ts', content: 'export const value = 1;\n' },
      registry: [makeMetadata('write_file', 'mutation')],
      config: { pathFieldsByTool: { write_file: ['path'] } },
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'write_denied',
      message: 'write_denied: whole-file source writes require a generated or Wavemill-owned allowlist path (src/app.ts)',
    });
  });

  it('allows allowlisted generated whole-file source writes', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'write_file',
      arguments: { path: './src/generated/client.ts', content: 'export const generated = true;\n' },
      registry: [makeMetadata('write_file', 'mutation')],
      config: {
        pathFieldsByTool: { write_file: ['path'] },
        wholeFileWriteAllowlist: { generatedPaths: ['./src/generated/client.ts'] },
      },
    });

    assert.deepEqual(decision, { kind: 'allow' });
  });

  it('allows whole-file source writes matching a glob allowlist pattern', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'write_file',
      arguments: { path: 'shared/lib/foo.generated.ts', content: 'export const generated = true;\n' },
      registry: [makeMetadata('write_file', 'mutation')],
      config: {
        pathFieldsByTool: { write_file: ['path'] },
        wholeFileWriteAllowlist: { generatedPaths: ['**/*.generated.ts', 'dist/*'] },
      },
    });

    assert.deepEqual(decision, { kind: 'allow' });
  });

  it('rejects whole-file source writes not matching any glob allowlist pattern', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'write_file',
      arguments: { path: 'shared/lib/foo.ts', content: 'export const value = 1;\n' },
      registry: [makeMetadata('write_file', 'mutation')],
      config: {
        pathFieldsByTool: { write_file: ['path'] },
        wholeFileWriteAllowlist: { generatedPaths: ['**/*.generated.ts'] },
      },
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'write_denied',
      message: 'write_denied: whole-file source writes require a generated or Wavemill-owned allowlist path (shared/lib/foo.ts)',
    });
  });

  it('matches glob patterns against wavemillOwnedPaths', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'write_file',
      arguments: { path: 'features/foo/plan.md', content: '# Plan\n' },
      registry: [makeMetadata('write_file', 'mutation')],
      config: {
        pathFieldsByTool: { write_file: ['path'] },
        wholeFileWriteAllowlist: { wavemillOwnedPaths: ['features/*'] },
      },
    });

    assert.deepEqual(decision, { kind: 'allow' });
  });

  it('denies patch-style mutation edits outside the worktree even without pathFieldsByTool', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'patch_file',
      arguments: { path: '../escape.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' },
      registry: [makeMetadata('patch_file', 'mutation')],
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'path_denied',
      message: "path_denied: '../escape.ts' resolves outside the worktree",
    });
  });

  it('allows patch-style source edits', () => {
    const decision = evaluate({
      phase: 'coding',
      name: 'patch_file',
      arguments: { path: 'src/app.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' },
      registry: [makeMetadata('patch_file', 'mutation')],
      config: { pathFieldsByTool: { patch_file: ['path'] } },
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

  it('throws for a missing worktree path', () => {
    assert.throws(
      () => evaluate({ phase: 'coding', name: 'read_file', worktreePath: '   ' }),
      /non-empty worktreePath/,
    );
  });

  it('throws for an invalid whole-file allowlist config', () => {
    assert.throws(
      () => evaluate({
        phase: 'coding',
        name: 'write_file',
        arguments: { path: 'src/app.ts', content: 'export const value = 1;\n' },
        registry: [makeMetadata('write_file', 'mutation')],
        config: {
          wholeFileWriteAllowlist: { generatedPaths: ['../bad.ts'] },
        },
      }),
      /repo-relative POSIX path without traversal/,
    );
  });
});
