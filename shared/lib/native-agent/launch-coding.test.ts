import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function archivedArtifactPath(featureDir: string, artifactName: string): string | undefined {
  const archiveRoot = join(featureDir, '.stale-artifacts');
  if (!existsSync(archiveRoot)) {
    return undefined;
  }
  for (const entry of readdirSync(archiveRoot)) {
    const candidate = join(archiveRoot, entry, artifactName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
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

  it('sweeps a pre-existing .coding-complete before classifying native completion', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    writeFileSync(join(featureDir, '.coding-complete'), 'confidence=high\nproducer=stale\n', 'utf-8');
    const model = scriptedModel([
      finalTurn('Stopped without writing a fresh marker.'),
    ], 'stale-complete');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2757',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
      }),
      /without \.coding-complete or \.coding-blocked-completion\.json/,
    );

    assert.equal(existsSync(join(featureDir, '.coding-complete')), false);
    assert.ok(archivedArtifactPath(featureDir, '.coding-complete'));
    assert.ok(existsSync(getCodingFailureHandoffPath(featureDir)));
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
  });

  it('sweeps a stale blocked-completion and accepts a fresh .coding-complete from the current run', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    writeFileSync(join(featureDir, '.coding-blocked-completion.json'), JSON.stringify({
      stage: 'coding',
      implementationComplete: true,
      committed: true,
      passingChecks: ['old check'],
      blockingChecks: ['old blocker'],
      blockingReason: 'old',
      evidence: 'old run',
      recommendedAction: 'advance_to_review',
    }), 'utf-8');
    const model = scriptedModel([
      toolTurn('marker-1', 'create_marker', {
        path: `features/${slug}/.coding-complete`,
        content: 'confidence=high\nproducer=native-agent\n',
      }),
      finalTurn('Coding complete.'),
    ], 'stale-blocked-fresh-complete');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2757',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
    });

    assert.equal(result.completion, 'complete');
    assert.ok(archivedArtifactPath(featureDir, '.coding-blocked-completion.json'));
    assert.equal(existsSync(join(featureDir, '.coding-blocked-completion.json')), false);
    assert.ok(existsSync(join(featureDir, '.coding-complete')));
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'completed');
  });
});
