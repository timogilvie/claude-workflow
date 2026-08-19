import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CANONICAL_CONFIG_TEMPLATE } from './config-sync.ts';
import { buildLaunchabilityMatrix, LAUNCHABILITY_STAGES, type LaunchabilityStage } from './launchable-models.ts';
import { resolveModelAgent } from './model-agent-resolution.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';
import { buildGlobalCertificationPath } from './native-agent/certification/loader.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './native-agent/certification/storage.ts';
import { loadLaunchPriorityList } from './openrouter-catalog.ts';

const WATCHLIST_STAGE_MAP = {
  'deepseek-coder-v2': ['coder'],
  'qwen-2.5-coder-32b': ['coder'],
  'qwen-3-235b': ['planner', 'coder', 'reviewer'],
  'qwen-2.5-72b': ['coder'],
  'kimi-k2-thinking': ['planner', 'coder', 'reviewer'],
  'gemini-2.0-flash': ['coder'],
  'llama-4-scout': ['coder'],
  'mistral-medium-3': ['coder'],
  'devstral-medium': ['coder'],
  'grok-code-fast': ['coder'],
} satisfies Record<string, LaunchabilityStage[]>;
const RETIRED_MODELS = new Set(['deepseek-coder-v2', 'qwen-2.5-coder-32b', 'gemini-2.0-flash', 'grok-code-fast']);

const NOW = new Date('2026-07-30T12:00:00.000Z');
const priorOpenRouterKey = process.env.OPENROUTER_API_KEY;
const priorCertificationRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];

before(() => {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  // Certification lookup falls back to a global store under the user's home
  // directory. Without this override the matrix reads whatever certifications
  // the developer happens to have run locally, so the suite passes on a
  // populated machine and fails on a clean CI runner. Point it at an empty
  // directory so launchability depends only on what each test writes.
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = mkdtempSync(
    join(tmpdir(), 'wavemill-cert-root-'),
  );
});

after(() => {
  if (priorOpenRouterKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = priorOpenRouterKey;
  }
  if (priorCertificationRoot === undefined) {
    delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  } else {
    process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = priorCertificationRoot;
  }
});

function writeMinimalConfig(repoDir: string): void {
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      configVersion: CANONICAL_CONFIG_TEMPLATE.configVersion,
      providers: CANONICAL_CONFIG_TEMPLATE.providers,
      router: {
        availableModels: CANONICAL_CONFIG_TEMPLATE.router?.availableModels,
      },
    }),
    'utf-8',
  );
}

function writeCertification(modelId: string): void {
  const capabilities = DEFAULT_MODEL_REGISTRY.models[modelId];
  const suiteVersion = capabilities.nativeCapability?.certification?.certificationSuiteVersion;
  const provider = capabilities.nativeCapability?.nativeProvider;
  assert.ok(suiteVersion);
  assert.ok(provider);
  // Write to the global scope, which is what the launchability matrix reads.
  // The repo-scoped legacy path is never consulted here, so writing there left
  // these assertions depending on the developer's real ~/.wavemill store.
  const path = buildGlobalCertificationPath(provider, modelId, suiteVersion);
  mkdirSync(dirname(path), { recursive: true });
  const artifact = {
    schemaVersion: 2,
    provider: capabilities.supportedModel?.canonicalArtifactIdentity?.provider,
    model: capabilities.supportedModel?.canonicalArtifactIdentity?.model,
    phase: 'workflow',
    suiteVersion,
    certifiedAt: '2026-07-15T00:00:00.000Z',
    expiresAt: '2026-09-13T00:00:00.000Z',
    scenarios: [{ scenarioId: 'native-openrouter-workflow-launch', passed: true }],
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), 'utf-8');
}

describe('launch-priority watchlist launchability', () => {
  it('has registry metadata and resolves every allowed watchlist stage without identity rewrite', () => {
    for (const [modelId, allowedStages] of Object.entries(WATCHLIST_STAGE_MAP)) {
      const capabilities = DEFAULT_MODEL_REGISTRY.models[modelId];
      assert.ok(capabilities, `${modelId} should exist in registry`);
      assert.equal(capabilities.supportedModel?.wavemillAlias, modelId);
      assert.equal(capabilities.agent, 'native-openrouter');
      assert.equal(capabilities.nativeCapability?.nativeProvider, 'openrouter');
      assert.equal(capabilities.nativeCapability?.piTransportKind, 'openai-completions');
      assert.equal(capabilities.nativeCapability?.readOnlyNative, 'certified');
      assert.equal(capabilities.nativeCapability?.compatFlags?.thinkingFormat, 'openrouter');

      for (const stage of LAUNCHABILITY_STAGES) {
        const phase = stage === 'planner' ? 'planning' : stage === 'coder' ? 'coding' : 'review';
        const result = resolveModelAgent({ model: modelId, phase, now: NOW });
        if (RETIRED_MODELS.has(modelId)) {
          assert.equal(result.ok, false, `${modelId}:${stage} should reject as retired`);
          if (result.ok) assert.fail('expected retired rejection');
          assert.equal(result.reason, 'lifecycle-blocked');
          continue;
        }
        if (allowedStages.includes(stage)) {
          assert.deepEqual(result, { ok: true, agent: 'native-openrouter' }, `${modelId}:${stage}`);
        } else {
          assert.equal(result.ok, false, `${modelId}:${stage} should reject`);
          if (result.ok) assert.fail('expected role rejection');
          assert.equal(result.reason, 'role-ineligible');
        }
      }
    }
  });

  it('standard config advertises watchlist models only for eligible stages and omits Sol/Luna', () => {
    const pools = CANONICAL_CONFIG_TEMPLATE.router?.availableModels;
    if (!pools) return;
    for (const [modelId, allowedStages] of Object.entries(WATCHLIST_STAGE_MAP)) {
      for (const stage of LAUNCHABILITY_STAGES) {
        assert.equal(
          pools[stage]?.includes(modelId),
          RETIRED_MODELS.has(modelId) ? false : allowedStages.includes(stage),
          `${modelId}:${stage} config eligibility mismatch`,
        );
      }
    }
    assert.equal(pools.planner?.includes('gpt-5.6-sol'), false);
    assert.equal(pools.coder?.includes('gpt-5.6-sol'), false);
    assert.equal(pools.reviewer?.includes('gpt-5.6-sol'), false);
    assert.equal(pools.planner?.includes('gpt-5.6-luna'), false);
    assert.equal(pools.coder?.includes('gpt-5.6-luna'), false);
    assert.equal(pools.reviewer?.includes('gpt-5.6-luna'), false);
    assert.equal(pools.coder?.includes('gpt-5.6-terra'), true);
    assert.equal(pools.coder?.includes('gpt-4.1'), false);
  });

  it('builds a deterministic matrix that rejects role-ineligible and missing-certification cells', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-launchability-'));
    writeMinimalConfig(repoDir);
    for (const modelId of Object.keys(WATCHLIST_STAGE_MAP)) {
      if (!RETIRED_MODELS.has(modelId)) writeCertification(modelId);
    }

    const catalog = loadLaunchPriorityList()
      .filter((entry) => Object.hasOwn(WATCHLIST_STAGE_MAP, entry.wavemillAlias));
    const matrix = buildLaunchabilityMatrix({ repoDir, catalog, now: NOW });

    for (const [modelId, allowedStages] of Object.entries(WATCHLIST_STAGE_MAP)) {
      for (const stage of LAUNCHABILITY_STAGES) {
        const cell = matrix.cells.find((entry) => entry.modelId === modelId && entry.stage === stage);
        assert.ok(cell, `${modelId}:${stage} should have a matrix cell`);
        if (RETIRED_MODELS.has(modelId)) {
          assert.equal(cell.launchable, false);
          assert.equal(cell.blocker, 'retired');
          assert.match(cell.diagnostic ?? '', /reason=lifecycle-blocked/);
        } else if (!allowedStages.includes(stage)) {
          assert.equal(cell.launchable, false);
          assert.equal(cell.blocker, 'role-ineligible');
        } else {
          assert.equal(cell.launchable, true, `${modelId}:${stage} should be launchable`);
          assert.equal(cell.agent, 'native-openrouter');
        }
      }
    }
  });
});
