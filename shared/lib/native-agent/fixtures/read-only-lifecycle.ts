/**
 * Deterministic read-only planning lifecycle fixture.
 *
 * Creates a temporary git repository, seeds fixture files (including a planted
 * fake secret), makes an uncommitted change, then returns helpers to run a mock
 * native read-only planning loop over the scripted sequence:
 *
 *   read_file(task-packet) → read_file(plan) → read_file(source) →
 *   git_status → git_diff → patch_file (denied mutation) → final text
 *
 * No live provider keys are required. All provider interaction uses the
 * scripted Pi provider from `provider.ts`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { registerScriptedPiProvider } from '../provider.ts';
import { runWavemillLoop } from '../loop.ts';
import { TranscriptWriter } from '../transcript.ts';
import { createReadOnlyTools } from '../tools/read-only.ts';
import { createGitTools, gitAfterToolCall } from '../tools/git.ts';
import { createToolRegistry } from '../tools/registry.ts';
import { toPiAgentTool } from '../tools/pi-adapter.ts';
import type { ToolDescriptor } from '../tools/types.ts';
import type { WavemillLoopConfig, LoopResult } from '../loop.ts';

// ---------------------------------------------------------------------------
// Planted secret for redaction verification
// ---------------------------------------------------------------------------

/** A fake API token embedded in fixture files for redaction smoke tests. */
export const PLANTED_SECRET = 'sk-fake1234567890abcdefghijklmnop';

// ---------------------------------------------------------------------------
// Fixture paths (relative to the temp git repo root)
// ---------------------------------------------------------------------------

export const TASK_PACKET_PATH = 'features/mock/task-packet.md';
export const PLAN_PATH = 'features/mock/plan.md';
export const SOURCE_PATH = 'shared/lib/native-agent/fixtures/source-under-test.ts';

// ---------------------------------------------------------------------------
// Scripted provider API name
// ---------------------------------------------------------------------------

let _providerSeq = 0;

function freshApi(): string {
  return `lifecycle-fixture-${++_providerSeq}`;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@test.local',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@test.local',
    },
    stdio: 'ignore',
  });
}

function writeFile(repoPath: string, relPath: string, content: string): void {
  const absPath = join(repoPath, relPath);
  mkdirSync(join(repoPath, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

export interface LifecycleFixture {
  /** Absolute path to the temp git repository. */
  repoPath: string;
  /** Absolute path to the transcript JSONL file. */
  transcriptPath: string;
  /** Cleanup — removes the temp directory. Call in test afterEach/after. */
  cleanup(): void;
}

/**
 * Create a temp git repo seeded with fixture files (including planted secret)
 * and an uncommitted change so git_status / git_diff return meaningful output.
 */
export function createLifecycleFixture(): LifecycleFixture {
  const repoPath = mkdtempSync(join(tmpdir(), 'native-lifecycle-fixture-'));

  // Initialise repo
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'fixture@test.local']);
  git(repoPath, ['config', 'user.name', 'Fixture']);

  // Seed and commit baseline files
  writeFile(
    repoPath,
    TASK_PACKET_PATH,
    [
      '# Task Packet — HOK-MOCK',
      '',
      '## Objective',
      'Implement the mock feature as described.',
      '',
      `## Context`,
      `This file intentionally contains a planted fake credential:`,
      `api_key=${PLANTED_SECRET}`,
      '',
      '## Files to modify',
      `- ${SOURCE_PATH}`,
    ].join('\n') + '\n',
  );

  writeFile(
    repoPath,
    PLAN_PATH,
    [
      '# Implementation Plan',
      '',
      '## Phase 1: Read source',
      '- Read the source file and understand the structure.',
      '',
      '## Phase 2: Apply changes',
      '- Apply the required changes.',
    ].join('\n') + '\n',
  );

  writeFile(
    repoPath,
    SOURCE_PATH,
    [
      '// Source under test — lifecycle fixture',
      'export function mockFunction(): string {',
      "  return 'initial';",
      '}',
    ].join('\n') + '\n',
  );

  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'initial fixture commit']);

  // Make an uncommitted change so git_status and git_diff are non-trivial
  writeFile(
    repoPath,
    SOURCE_PATH,
    [
      '// Source under test — lifecycle fixture',
      'export function mockFunction(): string {',
      "  return 'updated'; // uncommitted change",
      '}',
    ].join('\n') + '\n',
  );

  const transcriptPath = join(repoPath, '.wavemill', 'transcripts', 'lifecycle-smoke.jsonl');

  return {
    repoPath,
    transcriptPath,
    cleanup() {
      rmSync(repoPath, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Mock mutation tool (patch_file)
// ---------------------------------------------------------------------------

/**
 * A mutation tool descriptor that throws if its executor is ever called.
 * Used to verify that policy-blocked calls never reach the executor.
 */
export function createMockMutationTool(onExecute?: () => void): ToolDescriptor {
  return {
    metadata: {
      name: 'patch_file',
      description: 'Apply a patch to a file (write mutation).',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      additionalProperties: false,
    },
    async execute() {
      onExecute?.();
      throw new Error(
        'patch_file executor must never be called during planning phase — policy should block it',
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle runner
// ---------------------------------------------------------------------------

export interface LifecycleRunResult {
  loopResult: LoopResult;
  /** True if the mock mutation executor was ever called. */
  mutationExecutorCalled: boolean;
}

/**
 * Run the deterministic read-only planning lifecycle.
 *
 * Registers a scripted Pi provider that requests tools in the following order:
 *   read_file(task-packet) → read_file(plan) → read_file(source) →
 *   git_status → git_diff → patch_file (blocked by planning policy) →
 *   final text response
 *
 * The loop is wired with a TranscriptWriter that persists events to
 * fixture.transcriptPath.
 */
export async function runLifecycle(fixture: LifecycleFixture): Promise<LifecycleRunResult> {
  const { repoPath, transcriptPath } = fixture;
  const api = freshApi();
  let mutationExecutorCalled = false;

  // Scripted provider: one tool call per turn, then final text
  registerScriptedPiProvider({
    api,
    turns: [
      // Turn 1: read task packet
      {
        content: [{
          type: 'tool_call',
          id: 'lc-read-task',
          name: 'read_file',
          arguments: { path: TASK_PACKET_PATH },
        }],
        stopReason: 'tool_calls',
      },
      // Turn 2: read plan
      {
        content: [{
          type: 'tool_call',
          id: 'lc-read-plan',
          name: 'read_file',
          arguments: { path: PLAN_PATH },
        }],
        stopReason: 'tool_calls',
      },
      // Turn 3: read source
      {
        content: [{
          type: 'tool_call',
          id: 'lc-read-src',
          name: 'read_file',
          arguments: { path: SOURCE_PATH },
        }],
        stopReason: 'tool_calls',
      },
      // Turn 4: git status
      {
        content: [{
          type: 'tool_call',
          id: 'lc-git-status',
          name: 'git_status',
          arguments: {},
        }],
        stopReason: 'tool_calls',
      },
      // Turn 5: git diff
      {
        content: [{
          type: 'tool_call',
          id: 'lc-git-diff',
          name: 'git_diff',
          arguments: {},
        }],
        stopReason: 'tool_calls',
      },
      // Turn 6: denied mutation attempt
      {
        content: [{
          type: 'tool_call',
          id: 'lc-patch',
          name: 'patch_file',
          arguments: { path: SOURCE_PATH, content: 'should not be written' },
        }],
        stopReason: 'tool_calls',
      },
      // Turn 7: final text
      {
        content: [{
          type: 'text',
          text: 'Read-only lifecycle complete. Mutation was correctly denied.',
        }],
        stopReason: 'stop',
      },
    ],
  });

  // Build tool registry
  const readOnlyDescriptors = createReadOnlyTools(repoPath);
  const gitDescriptors = createGitTools(repoPath);
  const mutationDescriptor = createMockMutationTool(() => {
    mutationExecutorCalled = true;
  });

  const registry = createToolRegistry([
    ...readOnlyDescriptors,
    ...gitDescriptors,
    mutationDescriptor,
  ]);

  // Convert to Pi tools
  const piTools = registry.getTools().map(toPiAgentTool);

  // TranscriptWriter — wired via eventSink
  const writer = new TranscriptWriter({
    sessionId: 'lifecycle-smoke',
    model: 'scripted-provider',
    api,
    provider: 'scripted',
    path: transcriptPath,
  });

  const config: WavemillLoopConfig = {
    model: { id: 'scripted-model', api, provider: 'scripted' },
    context: {
      systemPrompt: 'You are a read-only planning agent. Inspect the repository and report findings.',
      messages: [{ role: 'user', content: 'Inspect the repository.', timestamp: 0 }],
      tools: piTools,
    },
    convertToLlm: (messages: unknown[]) => messages as Parameters<WavemillLoopConfig['convertToLlm']>[0],
    afterToolCall: (ctx) => gitAfterToolCall(ctx as Parameters<typeof gitAfterToolCall>[0]),
    toolPolicy: {
      phase: 'planning',
      worktreePath: repoPath,
      registry: registry.list(),
    },
    eventSink: (event) => writer.handleEvent(event),
  };

  const loopResult = await runWavemillLoop(config);

  return { loopResult, mutationExecutorCalled };
}
