import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { validateNativeOpenRouterConfig } from './native-openrouter-config-validation.ts';

function makeRepo(config: Record<string, unknown>): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'native-openrouter-config-'));
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2), 'utf-8');
  clearConfigCache(repoDir);
  return repoDir;
}

function cleanup(repoDir: string): void {
  clearConfigCache(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: ['z-ai/glm-5.2'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
    nativeAgent: {
      enabled: true,
      allowedPhases: ['planning', 'review'],
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'OPENROUTER_API_KEY',
          models: ['glm-5.2'],
        },
      },
    },
    router: {
      agentMap: {
        'glm-5.2': 'native-openrouter',
      },
    },
    ...overrides,
  };
}

describe('validateNativeOpenRouterConfig', () => {
  it('accepts equivalent Kimi/Qwen/GLM aliases and provider ids and returns launcher metadata', () => {
    const repoDir = makeRepo(baseConfig());
    try {
      const result = validateNativeOpenRouterConfig({
        repoDir,
        model: 'z-ai/glm-5.2',
        phase: 'planning',
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.blockers, []);
      assert.equal(result.identity?.wavemillAlias, 'glm-5.2');
      assert.equal(result.identity?.openrouterId, 'z-ai/glm-5.2');
      assert.equal(result.command?.agent, 'native-openrouter');
      assert.equal(result.command?.commandModel, 'z-ai/glm-5.2');
      assert.equal(result.command?.providerName, 'z-ai');
      assert.equal(result.command?.providerModel, 'glm-5.2');
    } finally {
      cleanup(repoDir);
    }
  });

  it('rejects unknown native OpenRouter models before launch', () => {
    const repoDir = makeRepo(baseConfig());
    try {
      const result = validateNativeOpenRouterConfig({
        repoDir,
        model: 'qwen/not-in-launch-priority',
        phase: 'coding',
      });

      assert.equal(result.ok, false);
      assert.equal(result.blockers[0]?.code, 'unknown-openrouter-model');
      assert.equal(result.blockers[0]?.surface, 'launch.model');
    } finally {
      cleanup(repoDir);
    }
  });

  it('reports provider-stage mismatches with actionable config surface', () => {
    const repoDir = makeRepo(baseConfig({
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'OPENROUTER_API_KEY',
          models: ['glm-5.2'],
          stages: ['coder'],
        },
      },
    }));
    try {
      const result = validateNativeOpenRouterConfig({
        repoDir,
        model: 'glm-5.2',
        phase: 'planning',
      });

      assert.equal(result.ok, false);
      assert.equal(result.blockers[0]?.code, 'provider-stage-mismatch');
      assert.equal(result.blockers[0]?.surface, 'providers.openrouter.stages');
      assert.match(result.blockers[0]?.detail ?? '', /does not include planner/);
    } finally {
      cleanup(repoDir);
    }
  });

  it('reports challenge/router agent-map mismatches before launch', () => {
    const repoDir = makeRepo(baseConfig({
      router: {
        agentMap: {
          'glm-5.2': 'codex',
        },
      },
    }));
    try {
      const result = validateNativeOpenRouterConfig({
        repoDir,
        model: 'z-ai/glm-5.2',
        phase: 'review',
      });

      assert.equal(result.ok, false);
      const mismatch = result.blockers.find((blocker) => blocker.code === 'agent-map-mismatch');
      assert.ok(mismatch, 'expected an agent-map mismatch blocker');
      assert.equal(mismatch?.surface, 'router.agentMap.glm-5.2');
      assert.match(mismatch?.detail ?? '', /maps glm-5.2 to codex/);
    } finally {
      cleanup(repoDir);
    }
  });
});
