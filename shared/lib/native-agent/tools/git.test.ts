import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';
import { runWavemillLoop } from '../loop.ts';
import { evaluateBeforeToolCallPolicy } from './policies.ts';
import { createToolRegistry } from './registry.ts';
import { toPiAgentTool } from './pi-adapter.ts';
import {
  createGitDiffTool,
  createGitStatusTool,
  createGitTools,
  gitAfterToolCall,
  gitToolPolicyConfig,
  type GitDiffDetails,
  type GitStatusDetails,
} from './git.ts';

const reposToClean = new Set<string>();
const piIdentity = (messages: any[]): any[] => messages;

after(() => {
  for (const repoPath of reposToClean) {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

describe('native-agent git tools', () => {
  it('exposes read-only git inspection descriptors and path policy metadata', () => {
    const registry = createToolRegistry(createGitTools('/repo'));
    const metadata = registry.list();

    assert.deepEqual(
      metadata.map((entry) => entry.name),
      ['git_status', 'git_diff'],
    );
    assert.deepEqual(gitToolPolicyConfig, { pathFieldsByTool: { git_diff: ['path'] } });
    assert.equal(metadata[0]!.class, 'read-only');
    assert.equal(metadata[1]!.class, 'read-only');
    assert.deepEqual(metadata[0]!.allowedPhases, ['planning', 'coding', 'review']);
    assert.deepEqual(metadata[1]!.outputCapPolicy, { strategy: 'truncate', maxBytes: 64 * 1024 });
  });

  it('returns structured status for a clean repo and does not mutate repository state', async () => {
    const repo = createRepo('git-status-clean-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);

    const tool = createGitStatusTool(repo);
    const before = repoSnapshot(repo);
    const result = await tool.execute('call-1', {});
    const afterState = repoSnapshot(repo);

    assertRepoUnchanged(before, afterState);
    const details = result.details as GitStatusDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.branch.head, 'main');
      assert.equal(details.isClean, true);
      assert.deepEqual(details.staged, []);
      assert.deepEqual(details.unstaged, []);
      assert.deepEqual(details.untracked, []);
    }
  });

  it('reports staged, unstaged, and untracked files deterministically', async () => {
    const repo = createRepo('git-status-dirty-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'tracked.txt', 'base\nworktree\n');
    writeFile(repo, 'staged.txt', 'staged\n');
    git(repo, ['add', 'staged.txt']);
    writeFile(repo, 'untracked.txt', 'untracked\n');

    const tool = createGitStatusTool(repo);
    const before = repoSnapshot(repo);
    const result = await tool.execute('call-2', {});
    const afterState = repoSnapshot(repo);

    assertRepoUnchanged(before, afterState);
    const details = result.details as GitStatusDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.isClean, false);
      assert.deepEqual(details.staged.map((entry) => entry.path), ['staged.txt']);
      assert.deepEqual(details.unstaged.map((entry) => entry.path), ['tracked.txt']);
      assert.deepEqual(details.untracked.map((entry) => entry.path), ['untracked.txt']);
    }
  });

  it('returns HEAD-relative diff by default and preserves repository state', async () => {
    const repo = createRepo('git-diff-head-');
    writeFile(repo, 'app.txt', 'base\n');
    git(repo, ['add', 'app.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'app.txt', 'base\nstaged\n');
    git(repo, ['add', 'app.txt']);
    writeFile(repo, 'app.txt', 'base\nstaged\nunstaged\n');

    const tool = createGitDiffTool(repo);
    const before = repoSnapshot(repo);
    const result = await tool.execute('call-3', {});
    const afterState = repoSnapshot(repo);

    assertRepoUnchanged(before, afterState);
    const details = result.details as GitDiffDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.base, 'HEAD');
      assert.match(details.diff, /\+staged/);
      assert.match(details.diff, /\+unstaged/);
      assert.equal(details.truncated, false);
      assert.equal(result.content[0]!.text, details.diff);
    }
  });

  it('supports path-scoped diffs inside the worktree', async () => {
    const repo = createRepo('git-diff-path-');
    writeFile(repo, 'src/one.txt', 'one\n');
    writeFile(repo, 'src/two.txt', 'two\n');
    git(repo, ['add', 'src/one.txt', 'src/two.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'src/one.txt', 'one\nchanged\n');
    writeFile(repo, 'src/two.txt', 'two\nchanged\n');

    const tool = createGitDiffTool(repo);
    const result = await tool.execute('call-4', { path: './src/../src/one.txt' });
    const details = result.details as GitDiffDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.match(details.diff, /src\/one.txt/);
      assert.doesNotMatch(details.diff, /src\/two.txt/);
      assert.equal(details.path, 'src/one.txt');
    }
  });

  it('truncates oversized diff output with byte metadata', async () => {
    const repo = createRepo('git-diff-truncate-');
    writeFile(repo, 'utf8.txt', 'start\n');
    git(repo, ['add', 'utf8.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'utf8.txt', `start\n${'é'.repeat(80)}\n`);

    const tool = createGitDiffTool(repo);
    const result = await tool.execute('call-5', { maxBytes: 64 });
    const details = result.details as GitDiffDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.truncated, true);
      assert.equal(details.retainedBytes <= 64, true);
      assert.equal(details.originalBytes > details.retainedBytes, true);
      assert.equal(Buffer.byteLength(details.diff, 'utf8'), details.retainedBytes);
    }
  });

  it('returns structured invalid-base errors and marks loop tool results as isError', async () => {
    const repo = createRepo('git-diff-error-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);
    writeFile(repo, 'tracked.txt', 'base\nchanged\n');

    const tool = createGitDiffTool(repo);
    const direct = await tool.execute('call-6', { base: 'missing-ref' });
    const directDetails = direct.details as GitDiffDetails;

    assert.equal(directDetails.ok, false);
    if (!directDetails.ok) {
      assert.equal(directDetails.error.code, 'git_failed');
      assert.match(directDetails.error.message, /missing-ref|bad revision|unknown revision/i);
    }

    const loopResult = await executeViaLoop(repo, toPiAgentTool(tool), {
      type: 'tool_call',
      id: 'diff-1',
      name: 'git_diff',
      arguments: { base: 'missing-ref' },
    });

    const toolResult = loopResult.messages.find(
      (message: any) => message.role === 'toolResult' && message.toolName === 'git_diff',
    ) as any;
    assert.ok(toolResult);
    assert.equal(toolResult.isError, true);
  });

  it('returns structured not-a-repo errors', async () => {
    const nonRepo = mkdtempSync(path.join(tmpdir(), 'git-not-repo-'));
    reposToClean.add(nonRepo);

    const result = await createGitStatusTool(nonRepo).execute('call-7', {});
    const details = result.details as GitStatusDetails;

    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error.code, 'not_git_repository');
      assert.match(details.error.message, /not a git repository/i);
    }
  });

  it('blocks out-of-bounds diff paths before execution', () => {
    const decision = evaluateBeforeToolCallPolicy({
      phase: 'coding',
      worktreePath: '/repo',
      registry: createToolRegistry(createGitTools('/repo')).list(),
      config: gitToolPolicyConfig,
      toolCall: {
        name: 'git_diff',
        arguments: { path: '../secret.txt' },
      },
    });

    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'path_denied',
      message: "path_denied: '../secret.txt' resolves outside the worktree",
    });
  });
});

function createRepo(prefix: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), prefix));
  reposToClean.add(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  return repo;
}

function writeFile(repo: string, relativePath: string, contents: string): void {
  const filePath = path.join(repo, relativePath);
  const parent = path.dirname(filePath);
  execFileSync('mkdir', ['-p', parent]);
  writeFileSync(filePath, contents);
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
  }).trimEnd();
}

function repoSnapshot(repo: string): { head: string; status: string } {
  return {
    head: git(repo, ['rev-parse', 'HEAD']),
    status: git(repo, ['status', '--porcelain=v2', '--branch', '-z']),
  };
}

function assertRepoUnchanged(
  before: { head: string; status: string },
  afterState: { head: string; status: string },
): void {
  assert.deepEqual(afterState, before);
}

async function executeViaLoop(
  repo: string,
  tool: any,
  toolCall: { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> },
) {
  const context = {
    systemPrompt: 'You are a test agent.',
    messages: [{ role: 'user', content: 'Inspect git.', timestamp: 0 }],
    tools: [tool],
  } as any;

  const { registerScriptedPiProvider } = await import('../provider.ts');
  const api = `git-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  registerScriptedPiProvider({
    api,
    turns: [
      { content: [toolCall], stopReason: 'tool_calls' },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
    ],
  });

  return await runWavemillLoop({
    model: { id: 'test-model', api, provider: 'test-provider' },
    context,
    convertToLlm: piIdentity,
    afterToolCall: gitAfterToolCall,
    toolPolicy: {
      phase: 'coding',
      worktreePath: repo,
      registry: createToolRegistry(createGitTools(repo)).list(),
      config: gitToolPolicyConfig,
    },
  });
}
