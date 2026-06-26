#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  serializeCodingComplete,
  validateCodingArtifacts,
  type CodingArtifacts,
} from './coding-artifacts.ts';
import { runWavemillLoop, type AgentContext, type LoopResult, type WavemillLoopConfig } from './loop.ts';
import { registerScriptedPiProvider, type ScriptedPiProviderTurn } from './provider.ts';
import { createApplyPatchTool, applyPatchAfterToolCall, type ApplyPatchDetails } from './tools/apply-patch-tool.ts';
import { toPiAgentTool, type AgentTool } from './tools/pi-adapter.ts';
import { createToolRegistry } from './tools/registry.ts';
import { writeStageResult, type StageResult } from '../stage-result.ts';

function setupFixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'native-coding-smoke-'));

  execFileSync('git', ['init', repo], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'smoke@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Smoke Test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'branch', '-m', 'main'], { stdio: 'pipe' });

  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/app.ts'), 'export const value = 1;\n', 'utf-8');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'initial commit'], { stdio: 'pipe' });

  return repo;
}

function makeTurns(): ScriptedPiProviderTurn[] {
  return [
    {
      content: [
        {
          type: 'tool_call',
          id: 'tc-1',
          name: 'apply_patch',
          arguments: {
            patch: {
              version: 1,
              atomic: true,
              operations: [
                {
                  op: 'edit',
                  path: 'src/app.ts',
                  oldText: 'export const value = 0;\n',
                  newText: 'export const value = 2;\n',
                },
              ],
            },
          },
        },
      ],
      stopReason: 'tool_calls',
    },
    {
      content: [
        {
          type: 'tool_call',
          id: 'tc-2',
          name: 'apply_patch',
          arguments: {
            patch: {
              version: 1,
              atomic: true,
              operations: [
                {
                  op: 'edit',
                  path: 'src/app.ts',
                  oldText: 'export const value = 1;\n',
                  newText: 'export const value = 2;\n',
                },
              ],
            },
          },
        },
      ],
      stopReason: 'tool_calls',
    },
    {
      content: [{ type: 'text', text: 'Coding complete.' }],
      stopReason: 'stop',
    },
  ];
}

function getToolResults(result: LoopResult) {
  return result.messages.filter((message) => (message as { role?: string }).role === 'toolResult') as Array<{
    role: 'toolResult';
    details?: unknown;
    isError?: boolean;
  }>;
}

async function writeCompletionArtifacts(featureDir: string, details: ApplyPatchDetails): Promise<void> {
  if (!details.ok) {
    throw new Error('expected a successful apply_patch result before writing completion artifacts');
  }

  const artifacts: CodingArtifacts = {
    type: 'coding',
    filesChanged: details.changedFiles.length,
    linesAdded: details.linesAdded,
    linesRemoved: details.linesRemoved,
    commitCount: 0,
  };
  const validatedArtifacts = validateCodingArtifacts(artifacts);
  assert.equal(validatedArtifacts.ok, true);

  const now = new Date().toISOString();
  const stageResult: StageResult = {
    stage: 'coding',
    status: 'completed',
    startedAt: now,
    finishedAt: now,
    agent: 'native-agent',
    model: 'smoke-model',
    notes: 'Native patch coding smoke completed.',
    artifacts,
  };
  await writeStageResult(featureDir, stageResult);

  writeFileSync(
    join(featureDir, '.coding-complete'),
    serializeCodingComplete({ confidence: 'high', fields: { producer: 'native-agent' } }),
    'utf-8',
  );
}

function assertCompletionArtifacts(featureDir: string): void {
  const markerPath = join(featureDir, '.coding-complete');
  const resultPath = join(featureDir, '.coding-result.json');

  assert.equal(existsSync(markerPath), true, 'coding completion marker must exist');
  assert.equal(
    readFileSync(markerPath, 'utf-8'),
    'confidence=high\nproducer=native-agent\n',
  );

  assert.equal(existsSync(resultPath), true, 'coding result artifact must exist');
  const parsed = JSON.parse(readFileSync(resultPath, 'utf-8')) as StageResult;
  assert.equal(parsed.stage, 'coding');
  assert.equal(parsed.status, 'completed');
  assert.ok(parsed.finishedAt, 'coding result must be terminal');
  assert.ok(parsed.artifacts, 'coding result must include aggregated artifacts');
  const validated = validateCodingArtifacts(parsed.artifacts);
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.deepEqual(validated.value, {
      type: 'coding',
      filesChanged: 1,
      linesAdded: 1,
      linesRemoved: 1,
      commitCount: 0,
    });
  }
}

async function main() {
  const api = `smoke-native-coding-${Date.now()}`;
  const worktree = setupFixtureRepo();
  const featureDir = mkdtempSync(join(tmpdir(), 'native-coding-feature-'));

  try {
    registerScriptedPiProvider({ api, turns: makeTurns() });

    const registry = createToolRegistry([createApplyPatchTool(worktree, { phase: 'coding' })]);
    const tools: AgentTool<unknown, unknown>[] = registry
      .getTools()
      .map((descriptor) => toPiAgentTool(descriptor) as AgentTool<unknown, unknown>);

    const context: AgentContext = {
      systemPrompt: 'You are a coding agent. Apply patches to source files and stop once complete.',
      messages: [{ role: 'user', content: 'Apply the requested coding patch and finish.', timestamp: 0 }],
      tools,
    };

    const config: WavemillLoopConfig = {
      model: { id: 'smoke-model', api, provider: 'scripted' },
      context,
      convertToLlm: (messages) => messages as any,
      afterToolCall: applyPatchAfterToolCall,
      toolPolicy: {
        phase: 'coding',
        worktreePath: worktree,
        registry: registry.list(),
      },
    };

    const result = await runWavemillLoop(config);
    const toolResults = getToolResults(result);

    assert.equal(result.stopReason, 'stop');
    assert.equal(result.toolCallsExecuted, 2);
    assert.equal(toolResults.length, 2);

    const firstDetails = toolResults[0].details as ApplyPatchDetails;
    assert.equal(toolResults[0].isError, true);
    assert.equal(firstDetails.ok, false);
    if (!firstDetails.ok) {
      assert.equal(firstDetails.error, 'patch_rejected');
      assert.equal(firstDetails.retryHint, 'Refresh the patch against the latest file contents.');
      assert.equal(firstDetails.diagnostics?.code, 'old_text_not_found');
    }

    const secondDetails = toolResults[1].details as ApplyPatchDetails;
    assert.equal(toolResults[1].isError, false);
    assert.equal(secondDetails.ok, true);
    if (secondDetails.ok) {
      assert.deepEqual(secondDetails.changedFiles, ['src/app.ts']);
      assert.equal(secondDetails.linesAdded, 1);
      assert.equal(secondDetails.linesRemoved, 1);
    }

    assert.equal(readFileSync(join(worktree, 'src/app.ts'), 'utf-8'), 'export const value = 2;\n');

    await writeCompletionArtifacts(featureDir, secondDetails);
    assertCompletionArtifacts(featureDir);

    console.log('[smoke] Native coding lifecycle smoke passed');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(featureDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
