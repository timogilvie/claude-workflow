import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const toolPath = path.join(repoRoot, 'tools', 'check-ci-verification.ts');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'check-ci-verification-'));
  tempDirs.push(repoDir);
  return repoDir;
}

function runTool(repoDir: string, args: string[]) {
  const env = { ...process.env };
  delete env.npm_config_verify_deps_before_run;
  delete env.npm_config__jsr_registry;
  delete env.npm_config_prefix;

  return spawnSync('npx', ['tsx', toolPath, '--repo', repoDir, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env,
  });
}

describe('check-ci-verification tool', () => {
  it('prints actionable unmapped check diagnostics from fixture metadata', () => {
    const repoDir = makeRepo();
    writeFileSync(path.join(repoDir, '.wavemill-config.json'), JSON.stringify({
      prePrVerification: {
        enabled: true,
        source: 'github-enforced',
        requiredChecks: ['Lint Check'],
        recipe: {
          commands: ['npm run lint'],
        },
      },
    }));
    writeFileSync(path.join(repoDir, 'discovery.json'), JSON.stringify({
      checks: ['Lint Check', 'Security Scan'],
      source: 'ruleset',
      timestamp: '2026-08-04T12:00:00Z',
      workflows: [
        {
          name: 'Lint Check',
          path: '.github/workflows/ci.yml',
          triggers: ['pull_request'],
        },
      ],
    }));

    const result = runTool(repoDir, ['--discovery-fixture', 'discovery.json', '--propose-mapping']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Verification Contract Drift Report/);
    assert.match(result.stdout, /Security Scan: unmapped-check/);
    assert.match(result.stdout, /Action required/);
    assert.match(result.stdout, /"Lint Check": "npm run lint"/);
  });

  it('returns JSON with metadata-unavailable finding for permission fixtures', () => {
    const repoDir = makeRepo();
    writeFileSync(path.join(repoDir, '.wavemill-config.json'), JSON.stringify({
      prePrVerification: {
        enabled: true,
        source: 'github-enforced',
        requiredChecks: ['Lint Check'],
        recipe: {
          commands: ['npm run lint'],
        },
      },
    }));
    writeFileSync(path.join(repoDir, 'permission.json'), JSON.stringify({
      error: 'GitHub API permission denied',
    }));

    const result = runTool(repoDir, ['--discovery-fixture', 'permission.json', '--json']);

    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.passed, false);
    assert.equal(parsed.report.findings[0].type, 'metadata-unavailable');
  });
});
