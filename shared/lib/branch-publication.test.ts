/**
 * Tests for the branch-publication preflight (HOK-2914).
 *
 * Uses a real temporary repository with a bare `origin` — in-memory GitHub
 * fixtures cannot detect a missing remote ref, which is the exact defect this
 * helper exists to prevent.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import os from 'node:os';

import { publishReviewedBranch, translateGitHubHeadError } from './branch-publication.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeAndCommit(repo: string, fileName: string, content: string, message: string): string {
  writeFileSync(join(repo, fileName), content, 'utf-8');
  git(repo, ['add', fileName]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

interface Fixture {
  tmpDir: string;
  repoDir: string;
  remoteDir: string;
  baseSha: string;
  headSha: string;
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function createFixture(): Fixture {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'branch-publication-'));
  tempDirs.push(tmpDir);
  const remoteDir = join(tmpDir, 'origin.git');
  const repoDir = join(tmpDir, 'work');

  execFileSync('git', ['init', '--bare', remoteDir], { encoding: 'utf-8' });
  execFileSync('git', ['init', repoDir], { encoding: 'utf-8' });
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Branch Publication Test']);
  git(repoDir, ['remote', 'add', 'origin', remoteDir]);

  writeAndCommit(repoDir, 'base.txt', 'base\n', 'base');
  git(repoDir, ['branch', '-M', 'auto/integration']);
  const baseSha = git(repoDir, ['rev-parse', 'HEAD']);
  git(repoDir, ['push', '-u', 'origin', 'auto/integration']);

  git(repoDir, ['switch', '-c', 'task/test']);
  const headSha = writeAndCommit(repoDir, 'feature.txt', 'feature\n', 'feature');

  return { tmpDir, repoDir, remoteDir, baseSha, headSha };
}

function remoteBranchSha(repoDir: string, branch: string): string | null {
  const output = git(repoDir, ['ls-remote', 'origin', `refs/heads/${branch}`]);
  return output ? output.split(/\s+/)[0] : null;
}

describe('publishReviewedBranch', () => {
  it('publishes an absent remote head and verifies the exact reviewed SHA', () => {
    const fixture = createFixture();
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), null);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'pushed');
    assert.equal(result.ok && result.remoteSha, fixture.headSha);
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), fixture.headSha);
  });

  it('reuses a matching remote head idempotently without pushing again', () => {
    const fixture = createFixture();
    git(fixture.repoDir, ['push', 'origin', 'task/test']);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'reused');
    assert.equal(result.ok && result.remoteSha, fixture.headSha);
  });

  it('rejects a remote branch whose SHA differs from the reviewed SHA', () => {
    const fixture = createFixture();
    // Remote holds a different commit under the task branch name.
    git(fixture.repoDir, ['push', 'origin', `${fixture.baseSha}:refs/heads/task/test`]);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'remote-divergence');
    assert.equal(!result.ok && result.remoteSha, fixture.baseSha);
    // The remote ref was not overwritten.
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), fixture.baseSha);
    assert.match(!result.ok ? result.recoveryCommand : '', /git .*push/);
  });

  it('rejects a stale reviewed SHA when the local branch has moved after review', () => {
    const fixture = createFixture();
    const movedSha = writeAndCommit(fixture.repoDir, 'unreviewed.txt', 'unreviewed\n', 'unreviewed work');

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'stale-reviewed-sha');
    assert.equal(!result.ok && result.localSha, movedSha);
    // Nothing was published.
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), null);
  });

  it('reports a missing local branch distinctly', () => {
    const fixture = createFixture();
    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/does-not-exist',
      reviewedSha: fixture.headSha,
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'local-ref-missing');
  });

  it('reports no-commits-ahead-of-base distinctly from an unpushed branch', () => {
    const fixture = createFixture();
    // A branch pointing at the base tip has nothing to open a PR for.
    git(fixture.repoDir, ['branch', 'task/empty', fixture.baseSha]);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/empty',
      reviewedSha: fixture.baseSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'no-commits-ahead-of-base');
    // Nothing was published.
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/empty'), null);
  });

  it('reports a failed push distinctly and does not fabricate a proof', () => {
    const fixture = createFixture();
    // ls-remote uses the fetch URL; pushes use pushurl, so pointing pushurl at
    // a nonexistent path fails only the push step.
    git(fixture.repoDir, ['remote', 'set-url', '--push', 'origin', join(fixture.tmpDir, 'missing.git')]);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'push-failed');
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), null);
  });
});

describe('translateGitHubHeadError', () => {
  it('translates the unresolvable-head GraphQL error into a branch-not-pushed diagnostic', () => {
    const translated = translateGitHubHeadError(
      "GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between main and task/x, Head ref must be a branch (createPullRequest)",
    );
    assert.ok(translated);
    assert.match(translated!, /never pushed to origin/);
  });

  it('leaves other GitHub errors untouched', () => {
    assert.equal(translateGitHubHeadError('GraphQL: something else went wrong'), null);
  });
});
