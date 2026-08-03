import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  prePrArtifactPath,
  runPrePrVerification,
  validateArtifactFreshness,
} from './pre-pr-verification.ts';

function git(repo: string, args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

async function makeRepo(): Promise<{ repo: string; featureDir: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'pre-pr-repo-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['remote', 'add', 'origin', 'git@github.com:example/repo.git']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'one\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  git(repo, ['checkout', '-b', 'task/test']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'two\n');
  git(repo, ['commit', '-am', 'change']);
  const featureDir = path.join(repo, 'features', 'test');
  await fs.mkdir(featureDir, { recursive: true });
  return { repo, featureDir };
}

describe('pre-pr-verification', () => {
  let tmp: string | null = null;

  beforeEach(() => {
    tmp = null;
  });

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writes passing artifact and validates freshness', async () => {
    const fixture = await makeRepo();
    tmp = fixture.repo;
    const artifact = await runPrePrVerification({
      worktreeDir: fixture.repo,
      featureDir: fixture.featureDir,
      baseRef: 'main',
      config: {
        enabled: true,
        policy: 'required',
        source: 'explicit',
        commands: [{ name: 'ok', run: 'printf ok' }],
      },
    });
    assert.equal(artifact.status, 'passed');
    assert.equal(existsSync(prePrArtifactPath(fixture.featureDir)), true);

    const freshness = await validateArtifactFreshness({
      artifactPath: prePrArtifactPath(fixture.featureDir),
      worktreeDir: fixture.repo,
      baseRef: 'main',
    });
    assert.equal(freshness.reason, 'passed');
  });

  it('records deterministic command failure and bounded excerpt', async () => {
    const fixture = await makeRepo();
    tmp = fixture.repo;
    const artifact = await runPrePrVerification({
      worktreeDir: fixture.repo,
      featureDir: fixture.featureDir,
      baseRef: 'main',
      config: {
        enabled: true,
        policy: 'required',
        source: 'explicit',
        commands: [{ name: 'fail', run: 'printf failure-message >&2; exit 7' }],
      },
    });
    assert.equal(artifact.status, 'failed');
    assert.equal(artifact.commands[0].exitCode, 7);
    assert.match(artifact.commands[0].logExcerpt ?? '', /failure-message/);
  });

  it('records timeout', async () => {
    const fixture = await makeRepo();
    tmp = fixture.repo;
    const artifact = await runPrePrVerification({
      worktreeDir: fixture.repo,
      featureDir: fixture.featureDir,
      baseRef: 'main',
      config: {
        enabled: true,
        policy: 'required',
        source: 'explicit',
        commands: [{ name: 'slow', run: 'sleep 5', timeoutSeconds: 1 }],
      },
    });
    assert.equal(artifact.status, 'timeout');
    assert.equal(artifact.commands[0].timedOut, true);
  });

  it('detects stale head', async () => {
    const fixture = await makeRepo();
    tmp = fixture.repo;
    await runPrePrVerification({
      worktreeDir: fixture.repo,
      featureDir: fixture.featureDir,
      baseRef: 'main',
      config: {
        enabled: true,
        policy: 'required',
        source: 'explicit',
        commands: [{ name: 'ok', run: 'true' }],
      },
    });
    await fs.writeFile(path.join(fixture.repo, 'file.txt'), 'three\n');
    git(fixture.repo, ['commit', '-am', 'second change']);
    const freshness = await validateArtifactFreshness({
      artifactPath: prePrArtifactPath(fixture.featureDir),
      worktreeDir: fixture.repo,
      baseRef: 'main',
    });
    assert.equal(freshness.reason, 'stale-head');
  });

  it('records override as passing', async () => {
    const fixture = await makeRepo();
    tmp = fixture.repo;
    const artifact = await runPrePrVerification({
      worktreeDir: fixture.repo,
      featureDir: fixture.featureDir,
      baseRef: 'main',
      config: {
        enabled: true,
        policy: 'required',
        source: 'explicit',
        commands: [{ name: 'fail', run: 'exit 1' }],
      },
      override: { operator: 'tester', reason: 'known environmental outage' },
    });
    assert.equal(artifact.status, 'passed');
    assert.equal(artifact.override?.operator, 'tester');
    assert.equal(artifact.commands.length, 0);
  });
});
