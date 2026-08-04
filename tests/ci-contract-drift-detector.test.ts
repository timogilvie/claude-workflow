import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  detectContractDrift,
  extractWorkflowJobNames,
} from '../shared/lib/ci-contract-drift-detector.ts';
import { buildDriftProposal } from '../shared/lib/drift-proposal-builder.ts';
import { GitHubPermissionError } from '../shared/lib/github-ci-discovery.ts';
import type { PrePrVerificationConfigSchema } from '../shared/lib/config.ts';

const tempDirs: string[] = [];
const repoRoot = process.cwd();

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ci-contract-drift-'));
  tempDirs.push(repoDir);
  mkdirSync(path.join(repoDir, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(repoDir, '.github', 'workflows', 'ci.yml'), `name: CI
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
  return repoDir;
}

function recipe(checks: NonNullable<PrePrVerificationConfigSchema['checks']>): PrePrVerificationConfigSchema {
  return {
    enabled: true,
    required: true,
    source: 'github-enforced',
    recipe: {
      commands: ['npm test'],
    },
    checks,
  };
}

describe('ci-contract-drift-detector', () => {
  it('reports aligned workflow and acknowledged remote-only checks', async () => {
    const repoDir = makeRepo();
    const report = await detectContractDrift({
      repoDir,
      repo: 'owner/repo',
      branch: 'auto/integration',
      githubChecks: ['ci / test', 'security/vendor-scan'],
      recipe: recipe({
        'ci / test': {
          type: 'workflow',
          localEquivalent: 'npm test',
          workflowFile: '.github/workflows/ci.yml',
          workflowJob: 'test',
        },
        'security/vendor-scan': {
          type: 'remote-only',
          rationale: 'Vendor scan has no local executable equivalent.',
          acknowledgedBy: 'maintainer@example.com',
          acknowledgedDate: '2026-08-04',
        },
      }),
    });

    assert.strictEqual(report.status, 'ALIGNED');
    assert.strictEqual(report.checksAligned, 2);
    assert.strictEqual(report.checksRemoteOnly, 1);
  });

  it('reports CHECK_MISSING for an enforced check without a mapping', async () => {
    const repoDir = makeRepo();
    const report = await detectContractDrift({
      repoDir,
      repo: 'owner/repo',
      branch: 'auto/integration',
      githubChecks: ['ci / test', 'lint'],
      workflows: [{ name: 'test', path: '.github/workflows/ci.yml', triggers: ['pull_request'] }],
      recipe: recipe({
        'ci / test': {
          type: 'workflow',
          workflowFile: '.github/workflows/ci.yml',
          workflowJob: 'test',
        },
      }),
    });

    assert.strictEqual(report.status, 'REQUIRES_REVIEW');
    const finding = report.findings.find((item) => item.checkName === 'lint');
    assert.strictEqual(finding?.state, 'CHECK_MISSING');
    assert.strictEqual(finding?.action, 'REVIEW_MAPPING');
  });

  it('reports WORKFLOW_CHANGED when the configured job is renamed or removed', async () => {
    const repoDir = makeRepo();
    const report = await detectContractDrift({
      repoDir,
      repo: 'owner/repo',
      branch: 'auto/integration',
      githubChecks: ['ci / test'],
      recipe: recipe({
        'ci / test': {
          type: 'workflow',
          workflowFile: '.github/workflows/ci.yml',
          workflowJob: 'unit',
        },
      }),
    });

    assert.strictEqual(report.status, 'REQUIRES_REVIEW');
    assert.strictEqual(report.findings[0].state, 'WORKFLOW_CHANGED');
  });

  it('reports CHECK_UNMAPPED when remote-only acknowledgement is incomplete', async () => {
    const repoDir = makeRepo();
    const report = await detectContractDrift({
      repoDir,
      repo: 'owner/repo',
      branch: 'auto/integration',
      githubChecks: ['security/vendor-scan'],
      recipe: recipe({
        'security/vendor-scan': {
          type: 'remote-only',
          rationale: 'Vendor scan has no local executable equivalent.',
        },
      }),
    });

    assert.strictEqual(report.status, 'REQUIRES_REVIEW');
    assert.strictEqual(report.findings[0].state, 'CHECK_UNMAPPED');
    assert.strictEqual(report.findings[0].action, 'ADD_RATIONALE');
  });

  it('reports METADATA_UNAVAILABLE on missing GitHub permission', async () => {
    const repoDir = makeRepo();
    const report = await detectContractDrift({
      repoDir,
      repo: 'owner/repo',
      branch: 'auto/integration',
      useCache: false,
      recipe: recipe({}),
      discoverChecks: async () => {
        throw new GitHubPermissionError('GitHub API permission denied for owner/repo.');
      },
    });

    assert.strictEqual(report.status, 'METADATA_UNAVAILABLE');
    assert.strictEqual(report.findings[0].state, 'METADATA_UNAVAILABLE');
  });

  it('writes and reuses GitHub metadata cache', async () => {
    const repoDir = makeRepo();
    let calls = 0;
    await detectContractDrift({
      repoDir,
      repo: 'owner/repo',
      branch: 'auto/integration',
      recipe: recipe({}),
      discoverChecks: async () => {
        calls++;
        return {
          checks: ['ci / test'],
          source: 'protection',
          timestamp: new Date().toISOString(),
        };
      },
    });
    await detectContractDrift({
      repoDir,
      repo: 'owner/repo',
      branch: 'auto/integration',
      recipe: recipe({}),
      discoverChecks: async () => {
        calls++;
        return {
          checks: ['other'],
          source: 'protection',
          timestamp: new Date().toISOString(),
        };
      },
    });

    assert.strictEqual(calls, 1);
    assert.ok(existsSync(path.join(repoDir, '.wavemill', 'github-checks-cache.json')));
  });

  it('builds read-only proposal changes for unmapped checks', async () => {
    const repoDir = makeRepo();
    const report = await detectContractDrift({
      repoDir,
      repo: 'owner/repo',
      branch: 'auto/integration',
      githubChecks: ['ci / test'],
      workflows: [{ name: 'test', path: '.github/workflows/ci.yml', triggers: ['pull_request'] }],
      recipe: recipe({}),
    });

    const proposal = buildDriftProposal(report);
    assert.deepEqual(proposal.proposedChanges[0], {
      action: 'ADD',
      checkName: 'ci / test',
      type: 'workflow',
      workflowFile: '.github/workflows/ci.yml',
      workflowJob: 'test',
    });
  });

  it('extracts workflow job keys without executing workflow YAML', () => {
    const jobs = extractWorkflowJobNames(`name: CI
jobs:
  test:
    runs-on: ubuntu-latest
  lint:
    runs-on: ubuntu-latest
`);
    assert.deepEqual(jobs, ['test', 'lint']);
  });

  it('validate-drift --propose writes a proposal file without editing config', () => {
    const repoDir = makeRepo();
    const configPath = path.join(repoDir, '.wavemill-config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        prePrVerification: {
          enabled: true,
          required: true,
          source: 'explicit',
          recipe: { commands: ['npm test'] },
          checks: {},
        },
      }, null, 2)
    );
    mkdirSync(path.join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(
      path.join(repoDir, '.wavemill', 'github-checks-cache.json'),
      JSON.stringify({
        repository: 'owner/repo',
        branch: 'auto/integration',
        checks: ['ci / test'],
        source: 'protection',
        timestamp: Date.now(),
      }, null, 2)
    );
    const before = readFileSync(configPath, 'utf-8');

    const result = spawnSync('npx', [
      'tsx',
      path.join(repoRoot, 'tools', 'validate-drift.ts'),
      repoDir,
      '--repo',
      'owner/repo',
      '--branch',
      'auto/integration',
      '--propose',
      '--json',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        WAVEMILL_DISABLE_AJV_VALIDATION: '1',
      },
    });

    assert.strictEqual(result.status, 1);
    assert.strictEqual(readFileSync(configPath, 'utf-8'), before);
    assert.ok(existsSync(path.join(repoDir, '.wavemill', 'drift-update-proposal.json')));
  });
});
