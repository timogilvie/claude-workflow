import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverCiChecks } from './ci-check-discovery.ts';

let cleanupDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-discovery-'));
  cleanupDirs.push(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/repo.git'], { cwd: repo });
  await fs.mkdir(path.join(repo, '.github', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(repo, '.github', 'workflows', 'ci.yml'), [
    'name: CI',
    'jobs:',
    '  shell:',
    '    name: Shell and Unit Tests',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm test',
  ].join('\n'));
  return repo;
}

async function withFakeGh(script: string): Promise<string> {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-gh-'));
  cleanupDirs.push(bin);
  const gh = path.join(bin, 'gh');
  await fs.writeFile(gh, `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  return bin;
}

describe('ci-check-discovery', () => {
  const originalPath = process.env.PATH;

  afterEach(async () => {
    process.env.PATH = originalPath;
    await Promise.all(cleanupDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs = [];
  });

  it('discovers protected checks and static workflow provenance without execution authority', async () => {
    const repo = await makeRepo();
    await withFakeGh(`
if [[ "$*" == *"/protection"* ]]; then
  printf '{"required_status_checks":{"contexts":["Shell and Unit Tests"]}}'
  exit 0
fi
printf '[]'
`);
    const result = await discoverCiChecks(repo, 'main');
    assert.equal(result.status, 'ok');
    assert.equal(result.requiredChecks?.[0].checkName, 'Shell and Unit Tests');
    assert.equal(result.requiredChecks?.[0].workflowFile, '.github/workflows/ci.yml');
    assert.equal(result.draftRecipe?.[0].run, 'npm test');
    assert.equal(result.draftRecipe?.[0].proposed, true);
  });

  it('reports permission-unavailable for 403 instead of empty checks', async () => {
    const repo = await makeRepo();
    await withFakeGh(`printf 'forbidden' >&2; exit 403`);
    const result = await discoverCiChecks(repo, 'main');
    assert.equal(result.status, 'permission-unavailable');
    assert.match(result.error ?? '', /permission|metadata/i);
  });

  it('allows explicit empty checks only when GitHub APIs succeed', async () => {
    const repo = await makeRepo();
    await withFakeGh(`
if [[ "$*" == *"/protection"* ]]; then
  printf '{"required_status_checks":{"contexts":[]}}'
  exit 0
fi
printf '[]'
`);
    const result = await discoverCiChecks(repo, 'main');
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.requiredChecks, []);
  });

  it('reports no-remote when repository has no GitHub origin', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-no-remote-'));
    cleanupDirs.push(repo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    const result = await discoverCiChecks(repo, 'main');
    assert.equal(result.status, 'no-remote');
  });
});
