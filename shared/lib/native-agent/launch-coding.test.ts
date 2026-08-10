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
import { launchNativeCoding } from './launch-coding.ts';
import { getNoMarkerHandoffPath, readNoMarkerHandoff } from './coding-handoff.ts';
import { NATIVE_PATCH_EXAMPLE } from './patch-contract.ts';

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

afterEach(() => {
  for (const repoDir of repos.splice(0)) {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

describe('launchNativeCoding', () => {
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

  it('fails closed when a coding agent tries to write outside the worktree', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const outsidePath = join(repoDir, '..', 'outside-native-coding-marker');
    const model = scriptedModel([
      toolTurn('bad-marker-1', 'create_marker', {
        path: '../outside-native-coding-marker',
        content: 'confidence=high\n',
      }),
      finalTurn('Tried to write outside.'),
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
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
    assert.match(stageResult?.failureReason ?? '', /without \.coding-complete/);
    const handoff = readNoMarkerHandoff(getNoMarkerHandoffPath(featureDir));
    assert.equal(handoff.ok, true);
    if (handoff.ok) {
      assert.equal(handoff.value.lastMutationFailure?.tool, 'create_marker');
    }
  });

  it('writes a structured no-marker handoff after Kimi-like invalid patches and normal stop', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const invalidPatch = {
      patch: {
        operations: [
          {
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'after';\n",
          },
        ],
      },
    };
    const model = scriptedModel([
      toolTurn('bad-patch-1', 'apply_patch', invalidPatch),
      toolTurn('bad-patch-2', 'apply_patch', invalidPatch),
      finalTurn('I am done.'),
    ], 'kimi-invalid');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2577',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
      }),
      /Native coding completed without \.coding-complete or \.coding-blocked-completion\.json\. Last mutation tool failure: apply_patch invalid_patch/,
    );

    const handoffPath = getNoMarkerHandoffPath(featureDir);
    assert.ok(existsSync(handoffPath));
    const handoff = readNoMarkerHandoff(handoffPath);
    assert.equal(handoff.ok, true);
    if (!handoff.ok) return;
    assert.equal(handoff.value.reason, 'no_completion_marker');
    assert.equal(handoff.value.mutationFailureCount, 2);
    assert.equal(handoff.value.lastMutationFailure?.tool, 'apply_patch');
    assert.equal(handoff.value.lastMutationFailure?.error, 'invalid_patch');
    assert.deepEqual(
      (handoff.value.lastMutationFailure?.diagnostics as Array<{ path: string }>).map((diagnostic) => diagnostic.path).slice(0, 2),
      ['$.version', '$.atomic'],
    );
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
    assert.match(stageResult?.failureReason ?? '', /Last mutation tool failure: apply_patch invalid_patch/);
  });

  it('recovers after an invalid apply_patch when the documented contract is used', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    writeFileSync(getNoMarkerHandoffPath(featureDir), '{"stale":true}\n', 'utf-8');
    const validPatch = {
      ...NATIVE_PATCH_EXAMPLE,
      operations: [
        {
          op: 'edit',
          path: 'src/app.ts',
          oldText: "export const message = 'before';\n",
          newText: "export const message = 'after';\n",
        },
      ],
    };
    const model = scriptedModel([
      toolTurn('bad-patch-1', 'apply_patch', {
        patch: {
          operations: [{ path: 'src/app.ts', oldText: 'before', newText: 'after' }],
        },
      }),
      toolTurn('patch-1', 'apply_patch', { patch: validPatch }),
      toolTurn('test-1', 'run_tests', { command: 'node -e "process.stdout.write(\\\"ok\\\")"' }),
      toolTurn('add-1', 'git_add', { paths: ['src/app.ts'] }),
      toolTurn('commit-1', 'git_commit', { message: 'feat: recover native patch' }),
      toolTurn('marker-1', 'create_marker', {
        path: `features/${slug}/.coding-complete`,
        content: 'confidence=high\nproducer=native-agent\n',
      }),
      finalTurn('Coding complete.'),
    ], 'recover');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2577',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
    });

    assert.equal(result.completion, 'complete');
    assert.equal(existsSync(getNoMarkerHandoffPath(featureDir)), false);
    assert.equal(readFileSync(join(repoDir, 'src', 'app.ts'), 'utf-8'), "export const message = 'after';\n");
  });
});
