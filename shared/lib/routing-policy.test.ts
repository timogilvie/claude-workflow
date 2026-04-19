import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';
import type { QuotaSnapshot, QuotaStatus } from './quota-state.ts';
import { resolveModel } from './routing-policy.ts';
import { routeWorkflowAuto, tryPolicyResolution } from './workflow-router.ts';

function makeSnapshot(statuses: Partial<Record<string, QuotaStatus>> = {}): QuotaSnapshot {
  const models = Object.fromEntries(
    Object.keys(DEFAULT_MODEL_REGISTRY.models).map((modelId) => [
      modelId,
      {
        status: statuses[modelId] ?? 'healthy',
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
      },
    ]),
  );

  return {
    models,
    snapshotAt: new Date().toISOString(),
  };
}

function baseConfig(mode: 'auto' | 'heuristic' = 'auto') {
  return {
    router: {
      enabled: true,
      mode,
      defaultAgent: 'claude',
      minRecords: 4,
      minModels: 2,
      defaultModel: 'claude-sonnet-4-5-20250929',
      agentMap: {
        'claude-opus-4-6': 'claude',
        'claude-opus-4-7': 'claude',
        'claude-sonnet-4-6': 'claude',
        'claude-sonnet-4-5-20250929': 'claude',
        'claude-haiku-4-5-20251001': 'claude',
        'gpt-5.3-codex': 'codex',
        'gpt-5.4': 'codex',
      },
    },
    eval: {
      pricing: {
        'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
        'claude-sonnet-4-6': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
        'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
        'gpt-5.4': { inputCostPerMTok: 2.5, outputCostPerMTok: 10, cacheWriteCostPerMTok: 3.125, cacheReadCostPerMTok: 0.625 },
      },
    },
  };
}

function makeRepo(configOverride?: Record<string, unknown>): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'routing-policy-test-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    ...baseConfig(),
    ...configOverride,
  }));
  clearConfigCache(repoDir);

  return {
    repoDir,
    cleanup: () => {
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function writeQuotaState(repoDir: string, statuses: Partial<Record<string, QuotaStatus>>): void {
  const models = Object.fromEntries(
    Object.keys(DEFAULT_MODEL_REGISTRY.models).map((modelId) => [
      modelId,
      {
        status: statuses[modelId] ?? 'healthy',
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: 0,
      },
    ]),
  );

  writeFileSync(join(repoDir, '.wavemill', 'quota-state.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    models,
  }));
}

describe('routing-policy ranking', () => {
  it('ranks the top healthy coding model first when quota is healthy', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
    });

    assert.equal(ranked[0].modelId, 'claude-sonnet-4-6');
    assert.equal(ranked[0].viable, true);
  });

  it('penalizes degrading models without excluding them', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot({ 'claude-sonnet-4-6': 'degrading' }),
    });

    const degraded = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-4-6');
    assert.ok(degraded);
    assert.equal(degraded.viable, true);
    assert.equal(degraded.adjustedScore, 76.5);
    assert.equal(ranked[0].modelId, 'claude-sonnet-4-5-20250929');
  });

  it('excludes exhausted primary models and promotes the next viable candidate', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot({ 'claude-sonnet-4-6': 'exhausted' }),
    });

    const exhausted = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-4-6');
    assert.ok(exhausted);
    assert.equal(exhausted.viable, false);
    assert.equal(exhausted.exclusionReason, 'quota-exhausted');
    assert.equal(ranked[0].modelId, 'claude-sonnet-4-5-20250929');
  });

  it('falls back to strong generalists on critical tasks when all frontier models are exhausted', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'critical',
      quotaState: makeSnapshot({
        'claude-opus-4-7': 'exhausted',
        'claude-opus-4-6': 'exhausted',
      }),
    });

    assert.equal(ranked[0].modelId, 'claude-sonnet-4-6');
    assert.equal(ranked[0].viable, true);
    const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.equal(haiku.viable, false);
    assert.equal(haiku.exclusionReason, 'below-difficulty-floor');
  });

  it('returns no viable candidates when every model is exhausted', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot(
        Object.fromEntries(
          Object.keys(DEFAULT_MODEL_REGISTRY.models).map((modelId) => [modelId, 'exhausted']),
        ),
      ),
    });

    assert.equal(ranked.some((candidate) => candidate.viable), false);
  });

  it('allows fast economy models on trivial difficulty', () => {
    const ranked = resolveModel({
      taskType: 'classify',
      difficulty: 'trivial',
      quotaState: makeSnapshot(),
    });

    const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.equal(haiku.viable, true);
  });

  it('keeps fast economy viable on moderate difficulty', () => {
    const ranked = resolveModel({
      taskType: 'classify',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
    });

    const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.equal(haiku.viable, true);
  });

  it('rejects fast economy on hard difficulty', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'hard',
      quotaState: makeSnapshot(),
    });

    const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.equal(haiku.viable, false);
    assert.equal(haiku.exclusionReason, 'below-difficulty-floor');
  });

  it('rejects non-frontier models on critical difficulty while frontier is viable', () => {
    const ranked = resolveModel({
      taskType: 'planning',
      difficulty: 'critical',
      quotaState: makeSnapshot(),
    });

    const sonnet = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-4-6');
    assert.ok(sonnet);
    assert.equal(sonnet.viable, false);
    assert.equal(sonnet.exclusionReason, 'below-difficulty-floor');
  });

  it('applies cost tier filters before ranking', () => {
    const ranked = resolveModel({
      taskType: 'planning',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
      maxCostTier: 'strong_generalist',
    });

    const frontier = ranked.find((candidate) => candidate.modelId === 'claude-opus-4-7');
    assert.ok(frontier);
    assert.equal(frontier.viable, false);
    assert.equal(frontier.exclusionReason, 'exceeds-cost-tier');
    assert.equal(ranked[0].modelId, 'claude-sonnet-4-6');
  });

  it('applies minimum quality thresholds after floor and cost checks', () => {
    const ranked = resolveModel({
      taskType: 'planning',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
      minQualityScore: 80,
    });

    const haiku = ranked.find((candidate) => candidate.modelId === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.equal(haiku.viable, false);
    assert.equal(haiku.exclusionReason, 'below-quality-threshold');
  });

  it('combines cost tier and quality filters deterministically', () => {
    const ranked = resolveModel({
      taskType: 'coding',
      difficulty: 'moderate',
      quotaState: makeSnapshot(),
      maxCostTier: 'strong_generalist',
      minQualityScore: 87,
    });

    assert.equal(ranked[0].modelId, 'claude-sonnet-4-6');
    assert.equal(ranked[0].viable, true);
    const sonnet45 = ranked.find((candidate) => candidate.modelId === 'claude-sonnet-4-5-20250929');
    assert.ok(sonnet45);
    assert.equal(sonnet45.viable, false);
    assert.equal(sonnet45.exclusionReason, 'below-quality-threshold');
  });
});

describe('routing-policy integration', () => {
  it('uses policy routing in auto mode when difficulty is available', async () => {
    const { repoDir, cleanup } = makeRepo();
    writeQuotaState(repoDir, {});

    try {
      const decision = await routeWorkflowAuto('Implement a backend feature with tests.', {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      });

      assert.equal(decision.routingMode, 'policy');
      assert.equal(decision.signals.taskDifficulty, 'hard');
      assert.notEqual(decision.coder, 'claude-haiku-4-5-20251001');
    } finally {
      cleanup();
    }
  });

  it('returns null from tryPolicyResolution when task difficulty is unavailable', () => {
    const { repoDir, cleanup } = makeRepo();
    writeQuotaState(repoDir, {});

    try {
      const decision = tryPolicyResolution('Implement a backend feature with tests.', {
        repoDir,
        skipDifficultyClassification: true,
      });

      assert.equal(decision, null);
    } finally {
      cleanup();
    }
  });

  it('falls through to stage-aware or heuristic routing when policy finds no viable models', async () => {
    const { repoDir, cleanup } = makeRepo();
    writeQuotaState(
      repoDir,
      Object.fromEntries(
        Object.keys(DEFAULT_MODEL_REGISTRY.models).map((modelId) => [modelId, 'exhausted']),
      ),
    );

    try {
      const decision = await routeWorkflowAuto('Implement a backend feature with tests.', {
        repoDir,
        taskDifficulty: 'hard',
        skipDifficultyClassification: true,
      });

      assert.notEqual(decision.routingMode, 'policy');
    } finally {
      cleanup();
    }
  });

  it('keeps hokusai as the higher-level override while feeding policy-filtered pools', async () => {
    const { repoDir, cleanup } = makeRepo({
      router: {
        ...baseConfig().router,
        mode: 'auto',
        hokusai: {
          endpoint: 'http://localhost:8080/predict',
          timeout: 1000,
        },
      },
    });
    writeQuotaState(repoDir, {});

    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        schema_version: '1.0',
        route: {
          planner_model: 'claude-opus-4-7',
          coder_model: 'claude-sonnet-4-6',
          reviewer_model: 'claude-opus-4-6',
          plan_depth: 'medium',
          code_depth: 'medium',
          review_mode: 'standard',
        },
        predictions: {
          expected_success_probability: 0.88,
          expected_cost_usd: 4.2,
          confidence: 0.81,
        },
      }), { status: 200 });
    };

    try {
      const decision = await routeWorkflowAuto('Secure the payment workflow integration.', {
        repoDir,
        taskDifficulty: 'critical',
        skipDifficultyClassification: true,
      });

      assert.equal(decision.routingMode, 'hokusai');
      assert.ok(requestBody);
      const availableModels = requestBody?.available_models as Record<string, string[]>;
      assert.deepEqual(
        availableModels.coder_models.sort(),
        ['claude-opus-4-6', 'claude-opus-4-7'].sort(),
      );
      assert.deepEqual(
        availableModels.planner_models.sort(),
        ['claude-opus-4-6', 'claude-opus-4-7'].sort(),
      );
      assert.equal(decision.signals.taskDifficulty, 'critical');
    } finally {
      globalThis.fetch = originalFetch;
      cleanup();
    }
  });
});

describe('frontier substitution', () => {
  // Create a registry with gpt-5.4 as a frontier model
  function makeRegistryWithGpt54() {
    return {
      models: {
        ...DEFAULT_MODEL_REGISTRY.models,
        'gpt-5.4': {
          vendor: 'openai',
          class: 'frontier' as const,
          strengths: ['reasoning', 'code generation'],
          weaknesses: ['cost'],
          qualityScores: {
            routing: 88,
            planning: 90,
            coding: 88,
            review: 87,
            classify: 85,
          },
        },
      },
      ladders: DEFAULT_MODEL_REGISTRY.ladders,
    };
  }

  // Create a snapshot that includes gpt-5.4
  function makeSnapshotWithGpt54(statuses: Partial<Record<string, QuotaStatus>> = {}): QuotaSnapshot {
    const registry = makeRegistryWithGpt54();
    const models = Object.fromEntries(
      Object.keys(registry.models).map((modelId) => [
        modelId,
        {
          status: statuses[modelId] ?? 'healthy',
          remainingEstimate: null,
          resetAt: null,
          confidence: 1,
          lastLimitErrorAt: null,
          lastSuccessAt: null,
          lastReason: null,
        },
      ]),
    );

    return {
      models,
      snapshotAt: new Date().toISOString(),
    };
  }

  it('substitutes healthy frontier sibling when top-of-ladder frontier is exhausted', () => {
    const registry = makeRegistryWithGpt54();
    const ranked = resolveModel(
      {
        taskType: 'coding',
        difficulty: 'moderate',
        quotaState: makeSnapshotWithGpt54({
          'claude-opus-4-7': 'exhausted',
          'gpt-5.4': 'healthy',
        }),
      },
      registry,
    );

    // gpt-5.4 should be the top viable candidate
    assert.equal(ranked[0].modelId, 'gpt-5.4');
    assert.equal(ranked[0].viable, true);

    // claude-sonnet-4-6 should be excluded due to frontier substitution
    const sonnet = ranked.find((c) => c.modelId === 'claude-sonnet-4-6');
    assert.ok(sonnet);
    assert.equal(sonnet.viable, false);
    assert.equal(sonnet.exclusionReason, 'frontier-substitution-active');
  });

  it('substitutes healthy frontier sibling when top-of-ladder frontier is degrading', () => {
    const registry = makeRegistryWithGpt54();
    const ranked = resolveModel(
      {
        taskType: 'coding',
        difficulty: 'moderate',
        quotaState: makeSnapshotWithGpt54({
          'claude-opus-4-7': 'degrading',
          'gpt-5.4': 'healthy',
        }),
      },
      registry,
    );

    // gpt-5.4 should be the top viable candidate
    assert.equal(ranked[0].modelId, 'gpt-5.4');
    assert.equal(ranked[0].viable, true);

    // claude-sonnet-4-6 should be excluded
    const sonnet = ranked.find((c) => c.modelId === 'claude-sonnet-4-6');
    assert.ok(sonnet);
    assert.equal(sonnet.viable, false);
    assert.equal(sonnet.exclusionReason, 'frontier-substitution-active');
  });

  it('skips substitution when no frontier sibling is healthy', () => {
    const registry = makeRegistryWithGpt54();
    const ranked = resolveModel(
      {
        taskType: 'coding',
        difficulty: 'moderate',
        quotaState: makeSnapshotWithGpt54({
          'claude-opus-4-7': 'exhausted',
          'claude-opus-4-6': 'exhausted',
          'gpt-5.4': 'degrading',
        }),
      },
      registry,
    );

    // claude-sonnet-4-6 should be the top viable (no substitution)
    assert.equal(ranked[0].modelId, 'claude-sonnet-4-6');
    assert.equal(ranked[0].viable, true);
    assert.equal(ranked[0].exclusionReason, undefined);
  });

  it('skips substitution when top-of-ladder frontier is healthy', () => {
    const registry = makeRegistryWithGpt54();
    const ranked = resolveModel(
      {
        taskType: 'coding',
        difficulty: 'moderate',
        quotaState: makeSnapshotWithGpt54({
          'claude-opus-4-7': 'healthy',
          'gpt-5.4': 'degrading',
        }),
      },
      registry,
    );

    // Normal ranking applies - no frontier-substitution-active exclusions
    const sonnet = ranked.find((c) => c.modelId === 'claude-sonnet-4-6');
    assert.ok(sonnet);
    assert.notEqual(sonnet.exclusionReason, 'frontier-substitution-active');
  });

  it('respects substitution across planning, coding, and review task types', () => {
    const registry = makeRegistryWithGpt54();
    const quotaState = makeSnapshotWithGpt54({
      'claude-opus-4-7': 'exhausted',
      'claude-opus-4-6': 'exhausted', // Exclude opus-4-6 to test gpt-5.4 selection
      'gpt-5.4': 'healthy',
    });

    // Test all three task types
    const taskTypes: Array<'planning' | 'coding' | 'review'> = ['planning', 'coding', 'review'];
    for (const taskType of taskTypes) {
      const ranked = resolveModel(
        {
          taskType,
          difficulty: 'moderate',
          quotaState,
        },
        registry,
      );

      // For each task type, gpt-5.4 should be selected (it's the only healthy frontier)
      const topViable = ranked.find((c) => c.viable);
      assert.equal(topViable?.modelId, 'gpt-5.4', `${taskType} should pick gpt-5.4`);

      // Non-frontier should be excluded
      const sonnet = ranked.find((c) => c.modelId === 'claude-sonnet-4-6');
      assert.ok(sonnet);
      assert.equal(sonnet.viable, false);
      assert.equal(sonnet.exclusionReason, 'frontier-substitution-active');
    }
  });
});
