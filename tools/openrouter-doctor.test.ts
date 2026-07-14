import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CERTIFICATION_SCHEMA_VERSION,
  buildCertificationPath,
  resolveCertificationStorageIdentity,
} from '../shared/lib/native-agent/certification/index.ts';

const OPENROUTER_CERTIFICATION_SUITE_VERSION = 'v2';

function makeRepoDir(): string {
  return mkdtempSync(join(tmpdir(), 'openrouter-doctor-tool-'));
}

function cleanup(repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
}

function writeConfig(repoDir: string): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
        models: ['glm-5.2'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
    nativeAgent: {
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'TEST_OPENROUTER_KEY',
          models: ['z-ai/glm-5.2'],
        },
      },
    },
    router: {
      defaultAgent: 'claude',
      models: ['glm-5.2'],
      availableModels: {
        planner: ['glm-5.2'],
        coder: ['glm-5.2'],
        reviewer: ['glm-5.2'],
      },
      agentMap: {
        'glm-5.2': 'claude-openrouter',
      },
    },
  }, null, 2));
}

function writeCert(repoDir: string): void {
  const path = buildCertificationPath(repoDir, 'openrouter', 'z-ai/glm-5.2', OPENROUTER_CERTIFICATION_SUITE_VERSION);
  mkdirSync(dirname(path), { recursive: true });
  const identity = resolveCertificationStorageIdentity('openrouter', 'z-ai/glm-5.2');
  writeFileSync(path, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: identity.provider,
    model: identity.model,
    phase: 'workflow',
    suiteVersion: OPENROUTER_CERTIFICATION_SUITE_VERSION,
    certifiedAt: '2026-07-10T00:00:00.000Z',
    scenarios: [{ scenarioId: 's1', passed: true }],
  }));
}

function runTool(args: string[], repoDir: string, env: Record<string, string | undefined> = {}) {
  return spawnSync('npx', ['tsx', 'tools/openrouter-doctor.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      TEST_OPENROUTER_KEY: '',
      OPENROUTER_DIRECT_AGENTS_ENABLED: '',
      ...env,
    },
    maxBuffer: 1024 * 1024,
  });
}

describe('openrouter-doctor tool', () => {
  it('emits a single JSON object', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeCert(repoDir);
      const result = runTool(['--json', '--repo-dir', repoDir], repoDir, { TEST_OPENROUTER_KEY: 'sk-test' });
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.repoDir, repoDir);
      assert.equal(Array.isArray(parsed.models), true);
    } finally {
      cleanup(repoDir);
    }
  });

  it('human output includes alias and native provider ID', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeCert(repoDir);
      const result = runTool(['--repo-dir', repoDir], repoDir, { TEST_OPENROUTER_KEY: 'sk-test' });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /alias=glm-5\.2 raw=z-ai\/glm-5\.2/);
    } finally {
      cleanup(repoDir);
    }
  });

  it('exits 0 when a configured model has an eligible stage', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeCert(repoDir);
      const result = runTool(['--repo-dir', repoDir], repoDir, { TEST_OPENROUTER_KEY: 'sk-test' });
      assert.equal(result.status, 0);
    } finally {
      cleanup(repoDir);
    }
  });

  it('exits 1 when a configured model is fully blocked', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      const result = runTool(['--repo-dir', repoDir], repoDir, { TEST_OPENROUTER_KEY: '' });
      assert.equal(result.status, 1);
    } finally {
      cleanup(repoDir);
    }
  });

  it('exits 2 on unreadable config', () => {
    const repoDir = makeRepoDir();
    try {
      writeFileSync(join(repoDir, '.wavemill-config.json'), '{');
      const result = runTool(['--repo-dir', repoDir], repoDir);
      assert.equal(result.status, 2);
    } finally {
      cleanup(repoDir);
    }
  });
});
