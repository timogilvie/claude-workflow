import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { clearConfigCache } from '../shared/lib/config.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  getPatchCodingCertificationPath,
} from '../shared/lib/native-agent/coding-certification.ts';
import { PATCH_CODING_SMOKE_SUITE_REVISION } from '../shared/lib/native-agent/smoke.ts';
import { checkNativeAgentLaunch } from './check-native-agent-launch.ts';

const repos: string[] = [];

function makeRepo(config: Record<string, unknown>): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'check-native-agent-launch-'));
  repos.push(repoDir);
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2), 'utf-8');
  clearConfigCache(repoDir);
  return repoDir;
}

function writeOpenRouterCert(repoDir: string, provider: string, model: string, phase = 'workflow'): void {
  const certDir = join(repoDir, '.wavemill', 'native-agent-certifications', provider, model);
  mkdirSync(certDir, { recursive: true });
  writeFileSync(join(certDir, 'v2.json'), JSON.stringify({
    schemaVersion: 2,
    provider,
    model,
    phase,
    suiteVersion: 'v2',
    certifiedAt: '2099-01-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 's1', passed: true }],
  }, null, 2), 'utf-8');
}

function writePatchCodingCertification(repoDir: string): void {
  const path = getPatchCodingCertificationPath(repoDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    certifiedAt: '2099-01-01T00:00:00.000Z',
    providers: [
      { provider: 'openai', model: 'gpt-4o', passed: true },
      { provider: 'openrouter', model: 'qwen/qwen3-coder', passed: true },
    ],
  }, null, 2), 'utf-8');
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
        models: ['z-ai/glm-5.2'],
        stages: ['planner', 'reviewer'],
      },
    },
    nativeAgent: {
      enabled: true,
      allowedPhases: ['planning', 'review'],
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'TEST_OPENROUTER_KEY',
          models: ['z-ai/glm-5.2'],
        },
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.TEST_OPENROUTER_KEY;
  for (const repoDir of repos.splice(0)) {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

describe('checkNativeAgentLaunch', () => {
  it('accepts equivalent native OpenRouter aliases and provider ids before launch', () => {
    const repoDir = makeRepo(baseConfig());
    writeOpenRouterCert(repoDir, 'z-ai', 'glm-5.2');
    process.env.TEST_OPENROUTER_KEY = 'sk-test';

    const result = checkNativeAgentLaunch({
      repoDir,
      phase: 'planning',
      agent: 'native-openrouter',
      model: 'glm-5.2',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.command?.wavemillAlias : undefined, 'glm-5.2');
    assert.equal(result.ok ? result.command?.openrouterId : undefined, 'z-ai/glm-5.2');
    assert.equal(result.ok ? result.command?.apiBaseUrl : undefined, 'https://openrouter.ai/api/v1');
  });

  it('rejects provider-stage mismatches with actionable blocker metadata before launch', () => {
    const repoDir = makeRepo(baseConfig({
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'TEST_OPENROUTER_KEY',
          models: ['z-ai/glm-5.2'],
          stages: ['coder'],
        },
      },
      nativeAgent: {
        enabled: true,
        allowedPhases: ['planning', 'review'],
        providers: {
          openrouter: {
            enabled: true,
            apiKeyEnv: 'TEST_OPENROUTER_KEY',
            models: ['glm-5.2'],
          },
        },
      },
    }));
    process.env.TEST_OPENROUTER_KEY = 'sk-test';

    const result = checkNativeAgentLaunch({
      repoDir,
      phase: 'planning',
      agent: 'native-openrouter',
      model: 'glm-5.2',
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.code, 'provider-stage-mismatch');
    assert.equal(result.ok ? undefined : result.surface, 'providers.openrouter.stages');
    assert.match(result.ok ? '' : result.reason, /does not include planner/);
  });

  it('allows native OpenRouter coding when patch coding and certification are configured', () => {
    const repoDir = makeRepo(baseConfig({
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'TEST_OPENROUTER_KEY',
          models: ['qwen/qwen3-coder'],
          stages: ['coder'],
        },
      },
      nativeAgent: {
        enabled: true,
        allowedPhases: ['coding'],
        patchCoding: {
          enabled: true,
        },
        providers: {
          openrouter: {
            enabled: true,
            apiKeyEnv: 'TEST_OPENROUTER_KEY',
            models: ['qwen-3-coder'],
          },
        },
      },
    }));
    mkdirSync(join(repoDir, 'tools'), { recursive: true });
    writeFileSync(join(repoDir, 'tools', 'launch-native-coding.ts'), 'export {};\n', 'utf-8');
    writeOpenRouterCert(repoDir, 'qwen', 'qwen3-coder', 'patch');
    writePatchCodingCertification(repoDir);
    process.env.TEST_OPENROUTER_KEY = 'sk-test';

    const result = checkNativeAgentLaunch({
      repoDir,
      phase: 'coding',
      agent: 'native-openrouter',
      model: 'qwen/qwen3-coder',
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.ok ? result.launcher : undefined, 'native-coding');
    assert.equal(result.ok ? result.command?.wavemillAlias : undefined, 'qwen-3-coder');
    assert.equal(result.ok ? result.command?.openrouterId : undefined, 'qwen/qwen3-coder');
  });
});
