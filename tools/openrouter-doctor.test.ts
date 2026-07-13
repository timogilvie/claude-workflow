import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { clearConfigCache } from '../shared/lib/config.ts';
import { clearChallengeSchedulerCache } from '../shared/lib/challenge-scheduler.ts';

const TOOL_PATH = resolve(process.cwd(), 'tools/openrouter-doctor.ts');

function makeRepo(): string {
  const repoDir = join(tmpdir(), `openrouter-doctor-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: ['qwen-3-coder'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
    router: {
      availableModels: {
        planner: ['qwen-3-coder'],
        coder: ['qwen-3-coder'],
        reviewer: ['qwen-3-coder'],
      },
    },
    challenge: {
      models: ['qwen-3-coder'],
    },
  }, null, 2));
  clearConfigCache(repoDir);
  clearChallengeSchedulerCache(repoDir);
  return repoDir;
}

function cleanupRepo(repoDir: string): void {
  clearConfigCache(repoDir);
  clearChallengeSchedulerCache(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
}

function runCli(repoDir: string, args: string[]) {
  return spawnSync('npx', ['tsx', TOOL_PATH, ...args, '--repo', repoDir], {
    encoding: 'utf-8',
    cwd: process.cwd(),
    env: { ...process.env },
  });
}

test('openrouter-doctor CLI supports json, strict, warning-only, and invalid-stage errors', () => {
  const repoDir = makeRepo();
  try {
    const jsonRun = runCli(repoDir, ['--json']);
    assert.equal(jsonRun.status, 0);
    assert.equal(jsonRun.stderr, '');
    assert.doesNotThrow(() => JSON.parse(jsonRun.stdout));

    const strictRun = runCli(repoDir, ['--strict']);
    assert.equal(strictRun.status, 1);
    assert.match(strictRun.stdout, /OpenRouter doctor/);

    const warningRun = runCli(repoDir, ['--warning-only']);
    assert.equal(warningRun.status, 0);
    assert.match(warningRun.stdout.trim(), /wavemill doctor openrouter/);
    assert.equal(warningRun.stdout.trim().split('\n').length, 1);

    const invalidStage = runCli(repoDir, ['--stage', 'bad-stage']);
    assert.equal(invalidStage.status, 1);
    assert.match(invalidStage.stderr, /invalid --stage "bad-stage"/);
  } finally {
    cleanupRepo(repoDir);
  }
});
