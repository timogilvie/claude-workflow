import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  classifyTree,
  createCleanupTracker,
  rollbackPatches,
  runCleanup,
  terminateProcesses,
} from './cleanup.ts';

const dirsToClean = new Set<string>();

after(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(prefix: string, git = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirsToClean.add(dir);
  if (git) {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  }
  return dir;
}

describe('cleanup', () => {
  it('terminates a running process', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const terminated = await terminateProcesses([child], 200);
    assert.equal(terminated.length, 1);
    assert.equal(terminated[0]?.pid, child.pid);
    assert.ok(terminated[0]?.signal === 'SIGTERM' || terminated[0]?.signal === 'SIGKILL');
  });

  it('rolls back snapshots and classifies a clean tree', async () => {
    const repo = createRepo('cleanup-rollback-clean-');
    writeFileSync(path.join(repo, 'src.ts'), 'const value = 1;\n', 'utf8');
    execFileSync('git', ['add', 'src.ts'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(path.join(repo, 'src.ts'), 'const value = 2;\n', 'utf8');

    const rollbackResults = await rollbackPatches(repo, [{
      path: 'src.ts',
      originalDiskText: 'const value = 1;\n',
      postImage: 'const value = 2;\n',
    }]);

    assert.equal(readFileSync(path.join(repo, 'src.ts'), 'utf8'), 'const value = 1;\n');
    assert.deepEqual(rollbackResults, [{ path: 'src.ts', status: 'restored' }]);

    const classified = await classifyTree(repo, ['src.ts'], rollbackResults);
    assert.equal(classified.finalTreeState, 'clean');
    assert.equal(classified.cleanupDecision, 'rolled-back');
  });

  it('leaves externally modified files in place and reports dirty-unrecoverable', async () => {
    const repo = createRepo('cleanup-rollback-dirty-');
    writeFileSync(path.join(repo, 'src.ts'), 'const value = 1;\n', 'utf8');
    execFileSync('git', ['add', 'src.ts'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(path.join(repo, 'src.ts'), 'const value = 3;\n', 'utf8');

    const rollbackResults = await rollbackPatches(repo, [{
      path: 'src.ts',
      originalDiskText: 'const value = 1;\n',
      postImage: 'const value = 2;\n',
    }]);

    assert.equal(readFileSync(path.join(repo, 'src.ts'), 'utf8'), 'const value = 3;\n');
    assert.deepEqual(rollbackResults, [{ path: 'src.ts', status: 'skipped' }]);

    const classified = await classifyTree(repo, ['src.ts'], rollbackResults);
    assert.equal(classified.finalTreeState, 'dirty-unrecoverable');
    assert.equal(classified.cleanupDecision, 'left-in-place');
  });

  it('ignores unrelated dirty files outside the run change-set', async () => {
    const repo = createRepo('cleanup-unrelated-dirty-');
    writeFileSync(path.join(repo, 'tracked.ts'), 'const tracked = 1;\n', 'utf8');
    writeFileSync(path.join(repo, 'unrelated.ts'), 'const unrelated = 1;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(path.join(repo, 'unrelated.ts'), 'const unrelated = 2;\n', 'utf8');

    const classified = await classifyTree(repo, ['tracked.ts'], []);
    assert.equal(classified.finalTreeState, 'clean');
    assert.equal(readFileSync(path.join(repo, 'unrelated.ts'), 'utf8'), 'const unrelated = 2;\n');
  });

  it('reports non-git worktrees as dirty-unrecoverable without throwing', async () => {
    const repo = createRepo('cleanup-non-git-', false);
    writeFileSync(path.join(repo, 'src.ts'), 'const value = 1;\n', 'utf8');
    const classified = await classifyTree(repo, ['src.ts'], []);
    assert.equal(classified.finalTreeState, 'dirty-unrecoverable');
    assert.equal(classified.cleanupDecision, 'left-in-place');
    assert.match(classified.notes.join('\n'), /git status failed|not a git repository/i);
  });

  it('is idempotent when cleanup runs twice', async () => {
    const repo = createRepo('cleanup-idempotent-');
    const tracker = createCleanupTracker();
    tracker.recordMutation({ tool: 'write_artifact', status: 'completed', path: 'features/demo/out.txt' });

    const first = await runCleanup(tracker, { worktreePath: repo, reason: 'aborted' });
    const second = await runCleanup(tracker, { worktreePath: repo, reason: 'aborted' });

    assert.equal(first.cleanupDecision, 'no-action-needed');
    assert.equal(second.cleanupDecision, 'no-action-needed');
    assert.match(second.notes.join('\n'), /already consumed/i);
  });
});
