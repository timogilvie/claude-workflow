import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readStageResult } from '../stage-result.ts';
import { registerScriptedPiProvider, type ScriptedPiProviderTurn } from './provider.ts';
import { getCodingFailureHandoffPath, readCodingFailureHandoff } from './coding-failure-handoff.ts';
import { launchNativeCoding, renderCodingSystemPrompt } from './launch-coding.ts';
import type { ToolDescriptor, WavemillToolResult } from './tools/types.ts';

const repos: string[] = [];

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo(): { repoDir: string; featureDir: string; slug: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'native-coding-launch-'));
  repos.push(repoDir);
  const slug = 'native-coding-demo';
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(repoDir, 'src', 'app.ts'), "export const message = 'before';\n", 'utf-8');
  writeFileSync(join(featureDir, 'plan.md'), '# Plan\n\nUpdate src/app.ts.\n', 'utf-8');
  writeFileSync(join(featureDir, 'task-packet.md'), '# Task Packet\n\nImplement the change.\n', 'utf-8');
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.name', 'Wavemill Test']);
  git(repoDir, ['config', 'user.email', 'wavemill@example.com']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'fixture']);
  return { repoDir, featureDir, slug };
}

function scriptedModel(turns: ScriptedPiProviderTurn[], label: string) {
  const api = `native-coding-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  registerScriptedPiProvider({ api, provider: 'scripted', turns });
  return {
    id: `scripted:${api}`,
    name: `scripted:${api}`,
    api,
    provider: 'scripted',
  };
}

function toolTurn(id: string, name: string, args: Record<string, unknown>): ScriptedPiProviderTurn {
  return {
    content: [{ type: 'tool_call', id, name, arguments: args }],
    usage: {
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 60,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
  };
}

function finalTurn(text: string): ScriptedPiProviderTurn {
  return {
    content: [{ type: 'text', text }],
    usage: {
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 60,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
  };
}

function rawWriteTool(repoDir: string): ToolDescriptor<{ path: string; content: string }, { ok: true }> {
  return {
    metadata: {
      name: 'raw_write',
      description: 'Test-only raw write that bypasses mutation artifact validation.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params): Promise<WavemillToolResult<{ ok: true }>> {
      writeFileSync(join(repoDir, params.path), params.content, 'utf-8');
      return {
        content: [{ type: 'text', text: `raw_write wrote ${params.path}` }],
        details: { ok: true },
      };
    },
  };
}

afterEach(() => {
  for (const repoDir of repos.splice(0)) {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

describe('launchNativeCoding', () => {
  it('renders NativePatch guidance in the native coding system prompt', () => {
    const prompt = renderCodingSystemPrompt({
      template: 'Implement {{SLUG}} at {{FEATURE_DIR}} with {{CODE_DEPTH}}.',
      codeDepth: 'medium',
      operatingMode: 'normal',
      featureDir: '/repo/features/demo',
      planPath: '/repo/features/demo/plan.md',
      slug: 'demo',
      blockedCompletionPath: 'features/demo/.coding-blocked-completion.json',
    });

    assert.match(prompt, /NativePatch envelope/);
    assert.match(prompt, /version/);
    assert.match(prompt, /atomic/);
    assert.match(prompt, /operations/);
    assert.match(prompt, /edit-diff/);
    assert.match(prompt, /"version": 1/);
  });

  it('runs a scripted native coding loop, commits a scoped patch, and records completion', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('read-1', 'read_file', { path: 'src/app.ts' }),
      toolTurn('patch-1', 'apply_patch', {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'after';\n",
          }],
        },
      }),
      toolTurn('test-1', 'run_tests', { command: 'node -e "process.stdout.write(\\\"ok\\\")"' }),
      toolTurn('add-1', 'git_add', { paths: ['src/app.ts'] }),
      toolTurn('commit-1', 'git_commit', { message: 'feat: update native coding fixture' }),
      toolTurn('artifact-1', 'write_artifact', {
        path: `features/${slug}/.coding-result.json`,
        content: JSON.stringify({
          type: 'coding',
          filesChanged: 1,
          linesAdded: 1,
          linesRemoved: 1,
          commitCount: 1,
        }),
      }),
      toolTurn('marker-1', 'create_marker', {
        path: `features/${slug}/.coding-complete`,
        content: 'confidence=high\nproducer=native-agent\n',
      }),
      finalTurn('Coding complete.'),
    ], 'complete');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2542',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
      branch: 'task/native-coding',
    });

    assert.equal(result.completion, 'complete');
    assert.equal(readFileSync(join(repoDir, 'src', 'app.ts'), 'utf-8'), "export const message = 'after';\n");
    assert.equal(git(repoDir, ['log', '--format=%s', '-n', '1']), 'feat: update native coding fixture');
    assert.ok(existsSync(join(featureDir, '.coding-complete')));
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'completed');
    assert.equal(stageResult?.artifacts?.type, 'coding');
    assert.equal(stageResult?.artifacts?.filesChanged, 1);
    assert.equal(stageResult?.artifacts?.commitCount, 1);
  });

  it('accepts a valid blocked-completion handoff without writing .coding-complete', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('patch-1', 'apply_patch', {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'blocked';\n",
          }],
        },
      }),
      toolTurn('test-1', 'run_tests', { command: 'node -e "process.stdout.write(\\\"targeted-ok\\\")"' }),
      toolTurn('add-1', 'git_add', { paths: ['src/app.ts'] }),
      toolTurn('commit-1', 'git_commit', { message: 'feat: blocked verification fixture' }),
      toolTurn('blocked-1', 'write_artifact', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: JSON.stringify({
          stage: 'coding',
          implementationComplete: true,
          committed: true,
          passingChecks: ['node -e targeted-ok'],
          blockingChecks: ['npm run typecheck'],
          blockingReason: 'baseline_tests_failing',
          evidence: 'Repo-level baseline failed outside the scoped change.',
          recommendedAction: 'advance_to_review',
        }),
      }),
      finalTurn('Coding blocked by baseline verification.'),
    ], 'blocked');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2542',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
    });

    assert.equal(result.completion, 'blocked');
    assert.equal(existsSync(join(featureDir, '.coding-complete')), false);
    assert.ok(existsSync(join(featureDir, '.coding-blocked-completion.json')));
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'running');
    assert.match(stageResult?.notes ?? '', /blocked-completion/);
  });

  it('retries invalid completion artifacts written outside mutation validation', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('raw-invalid-marker', 'raw_write', {
        path: `features/${slug}/.coding-complete`,
        content: '{"commit":"abc123"}',
      }),
      finalTurn('Wrote malformed marker.'),
      toolTurn('marker-retry', 'create_marker', {
        path: `features/${slug}/.coding-complete`,
        content: 'confidence=high\n',
      }),
      finalTurn('Rewrote valid marker.'),
    ], 'artifact-retry');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2761',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
      extraDescriptors: [rawWriteTool(repoDir)],
    });

    assert.equal(result.completion, 'complete');
    assert.equal(readFileSync(join(featureDir, '.coding-complete'), 'utf-8'), 'confidence=high\n');
    assert.ok(existsSync(join(featureDir, '.coding-complete.invalid-1')));
    assert.ok(existsSync(result.transcriptPath));
  });

  it('fails only after bounded artifact retries are exhausted', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('raw-invalid-1', 'raw_write', {
        path: `features/${slug}/.coding-complete`,
        content: '{"commit":"abc123"}',
      }),
      finalTurn('Malformed once.'),
      toolTurn('raw-invalid-2', 'raw_write', {
        path: `features/${slug}/.coding-complete`,
        content: '{"commit":"def456"}',
      }),
      finalTurn('Malformed twice.'),
      toolTurn('raw-invalid-3', 'raw_write', {
        path: `features/${slug}/.coding-complete`,
        content: '{"commit":"ghi789"}',
      }),
      finalTurn('Malformed third time.'),
    ], 'artifact-exhausted');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2761',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
        extraDescriptors: [rawWriteTool(repoDir)],
      }),
      /invalid coding-complete/,
    );

    assert.ok(existsSync(join(featureDir, '.coding-complete.invalid-1')));
    assert.ok(existsSync(join(featureDir, '.coding-complete.invalid-2')));
    const handoff = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));
    assert.equal(handoff.ok, true);
    if (handoff.ok) {
      assert.equal(handoff.value.reason, 'invalid_completion_artifact');
      assert.equal(handoff.value.validationErrors?.[0]?.code, 'missing_confidence');
      assert.deepEqual(handoff.value.quarantinedArtifacts, [
        `features/${slug}/.coding-complete.invalid-1`,
        `features/${slug}/.coding-complete.invalid-2`,
      ]);
    }
  });

  it('coerces repeated false blocked-completion claims to implementationComplete=false', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const falseClaim = JSON.stringify({
      stage: 'coding',
      implementationComplete: true,
      committed: true,
      passingChecks: [],
      blockingChecks: ['npm test'],
      blockingReason: 'baseline_tests_failing',
      evidence: 'Claimed complete without running verification.',
      recommendedAction: 'advance_to_review',
    });
    const model = scriptedModel([
      toolTurn('blocked-1', 'write_artifact', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: falseClaim,
      }),
      finalTurn('False complete once.'),
      toolTurn('blocked-2', 'write_artifact', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: falseClaim,
      }),
      finalTurn('False complete twice.'),
      toolTurn('blocked-3', 'write_artifact', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: falseClaim,
      }),
      finalTurn('False complete third time.'),
    ], 'false-completion');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2761',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
    });

    assert.equal(result.completion, 'blocked');
    const saved = JSON.parse(readFileSync(join(featureDir, '.coding-blocked-completion.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(saved.implementationComplete, false);
    assert.match(String(saved.evidence), /passingChecks was empty/);
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'running');
  });

  it('fails closed when a coding agent tries to write outside the worktree', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const outsidePath = join(repoDir, '..', 'outside-native-coding-marker');
    const model = scriptedModel([
      toolTurn('bad-marker-1', 'create_marker', {
        path: '../outside-native-coding-marker',
        content: 'confidence=high\n',
      }),
      finalTurn('Tried to write outside.'),
      finalTurn('Still no completion marker.'),
    ], 'outside');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2542',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
      }),
      /without \.coding-complete or \.coding-blocked-completion\.json/,
    );

    assert.equal(existsSync(outsidePath), false);
    const handoff = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));
    assert.equal(handoff.ok, true);
    if (handoff.ok) {
      assert.equal(handoff.value.lastToolError?.tool, 'create_marker');
      assert.equal(handoff.value.recoveryAttempted, true);
    }
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
    assert.match(stageResult?.failureReason ?? '', /without \.coding-complete/);
  });

  it('recovers from Kimi-like invalid patches with the documented contract after a normal stop', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('bad-patch-1', 'apply_patch', {
        patch: {
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'after';\n",
          }],
        },
      }),
      toolTurn('bad-patch-2', 'apply_patch', {
        patch: { files: [{ path: 'src/app.ts', content: "export const message = 'after';\n" }] },
      }),
      finalTurn('I could not apply the patch.'),
      toolTurn('good-patch-1', 'apply_patch', {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'after';\n",
          }],
        },
      }),
      toolTurn('add-1', 'git_add', { paths: ['src/app.ts'] }),
      toolTurn('commit-1', 'git_commit', { message: 'feat: recover native patch contract' }),
      toolTurn('marker-1', 'create_marker', {
        path: `features/${slug}/.coding-complete`,
        content: 'confidence=high\nproducer=native-agent\n',
      }),
      finalTurn('Recovered and completed.'),
    ], 'kimi-recover');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2580',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
    });

    assert.equal(result.completion, 'complete');
    assert.equal(readFileSync(join(repoDir, 'src', 'app.ts'), 'utf-8'), "export const message = 'after';\n");
    assert.equal(existsSync(getCodingFailureHandoffPath(featureDir)), false);
    const transcript = readFileSync(result.transcriptPath, 'utf-8');
    assert.match(transcript, /Valid NativePatch example/);
    assert.match(transcript, /\\"version\\": 1/);
  });

  it('writes a structured handoff when Kimi-like invalid patches are followed by another normal stop', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('bad-patch-1', 'apply_patch', {
        patch: {
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'after';\n",
          }],
        },
      }),
      finalTurn('I stopped without a marker.'),
      finalTurn('Still stopped without a marker.'),
    ], 'kimi-handoff');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2580',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
      }),
      /without \.coding-complete or \.coding-blocked-completion\.json; last tool error \(apply_patch\/invalid_patch\): Patch payload did not match the NativePatch contract/,
    );

    const handoff = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));
    assert.equal(handoff.ok, true);
    if (!handoff.ok) return;
    assert.equal(handoff.value.lastToolError?.tool, 'apply_patch');
    assert.equal(handoff.value.lastToolError?.error, 'invalid_patch');
    assert.ok(handoff.value.mutationFailures >= 1);
    assert.equal(handoff.value.recoveryAttempted, true);

    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
    assert.match(stageResult?.failureReason ?? '', /last tool error \(apply_patch\/invalid_patch\)/);
  });
});
