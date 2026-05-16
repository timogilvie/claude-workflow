import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_MODEL_REGISTRY,
  ModelSelectorParseError,
  resolveSelector,
  type ModelRegistry,
  type ModelSelector,
  type ResolvedModel,
} from './model-registry.ts';
import {
  ModelPolicyResolutionError,
  resolveSelectorWithPolicy,
} from './model-resolution-policy.ts';
import {
  resolveEffectiveModel,
  type EffectiveModelSelectorInput,
  type ResolutionLayer,
  type ResolveEffectiveModelPolicyContext,
} from './model-resolution.ts';
import type { QuotaSnapshot, QuotaStatus } from './quota-state.ts';

function makeQuotaSnapshot(
  registry: ModelRegistry,
  statuses: Partial<Record<string, QuotaStatus>> = {},
): QuotaSnapshot {
  return {
    models: Object.fromEntries(
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
    ),
    snapshotAt: new Date().toISOString(),
  };
}

function makePolicyContext(
  overrides: Partial<ResolveEffectiveModelPolicyContext> = {},
): ResolveEffectiveModelPolicyContext {
  const registry = overrides.registryOverride ?? DEFAULT_MODEL_REGISTRY;
  return {
    taskType: 'review',
    difficulty: 'moderate',
    quotaState: makeQuotaSnapshot(registry),
    registryOverride: registry,
    ...overrides,
  };
}

function stripResolutionLayer(result: ReturnType<typeof resolveEffectiveModel>) {
  const { resolutionLayer: _resolutionLayer, ...resolved } = result;
  return resolved;
}

interface MatrixCase {
  name: string;
  workspaceSelector?: EffectiveModelSelectorInput;
  userOverride?: EffectiveModelSelectorInput;
  parent?: ResolvedModel;
  parentContextId?: string;
  policyContext?: ResolveEffectiveModelPolicyContext;
  expectedLayer: ResolutionLayer;
  expectedRequested: ModelSelector;
  expectedResolved: string;
  expectedSource: ResolvedModel['source'];
  expectedFallbackReason?: ResolvedModel['fallbackReason'];
  expectedFamilyChannel?: ResolvedModel['familyChannel'];
  expectedParentContextId?: string;
}

describe('resolveEffectiveModel', () => {
  const originalResolvedModelEnv = process.env.WAVEMILL_RESOLVED_MODEL;

  beforeEach(() => {
    delete process.env.WAVEMILL_RESOLVED_MODEL;
  });

  afterEach(() => {
    if (originalResolvedModelEnv === undefined) {
      delete process.env.WAVEMILL_RESOLVED_MODEL;
    } else {
      process.env.WAVEMILL_RESOLVED_MODEL = originalResolvedModelEnv;
    }
  });

  const parent = resolveSelector({ kind: 'alias', family: 'sonnet' });
  const unavailableRegistry: ModelRegistry = {
    models: {
      'claude-sonnet-4-6': DEFAULT_MODEL_REGISTRY.models['claude-sonnet-4-6'],
      'gpt-5.5': DEFAULT_MODEL_REGISTRY.models['gpt-5.5'],
    },
    ladders: {
      review: ['claude-sonnet-4-6', 'gpt-5.5'],
    },
  };

  const cases: MatrixCase[] = [
    {
      name: 'uses workspace selector when no user override is present',
      workspaceSelector: 'opus',
      expectedLayer: 'workspace',
      expectedRequested: { kind: 'alias', family: 'opus', channel: 'stable' },
      expectedResolved: 'claude-opus-4-7',
      expectedSource: 'alias',
      expectedFamilyChannel: 'stable',
    },
    {
      name: 'uses user override over workspace selector',
      workspaceSelector: 'opus',
      userOverride: 'sonnet',
      expectedLayer: 'user',
      expectedRequested: { kind: 'alias', family: 'sonnet', channel: 'stable' },
      expectedResolved: 'claude-sonnet-4-6',
      expectedSource: 'alias',
      expectedFamilyChannel: 'stable',
    },
    {
      name: 'uses user override when workspace selector is absent',
      userOverride: 'gpt-5.5',
      expectedLayer: 'user',
      expectedRequested: { kind: 'alias', family: 'gpt-5.5', channel: 'stable' },
      expectedResolved: 'gpt-5.5',
      expectedSource: 'alias',
      expectedFamilyChannel: 'stable',
    },
    {
      name: 'defaults when both workspace and user selectors are absent',
      expectedLayer: 'default',
      expectedRequested: { kind: 'pinned', modelId: 'claude-opus-4-7' },
      expectedResolved: 'claude-opus-4-7',
      expectedSource: 'pinned',
    },
    {
      name: 'treats user inherit as deferring to a concrete workspace selector',
      workspaceSelector: 'opus',
      userOverride: 'inherit',
      expectedLayer: 'workspace',
      expectedRequested: { kind: 'alias', family: 'opus', channel: 'stable' },
      expectedResolved: 'claude-opus-4-7',
      expectedSource: 'alias',
      expectedFamilyChannel: 'stable',
    },
    {
      name: 'inherits from parent when user and workspace both resolve to inherit',
      workspaceSelector: 'inherit',
      userOverride: 'inherit',
      parent,
      parentContextId: 'agent-123',
      expectedLayer: 'parent',
      expectedRequested: { kind: 'inherit' },
      expectedResolved: 'claude-sonnet-4-6',
      expectedSource: 'inherited',
      expectedParentContextId: 'agent-123',
    },
    {
      name: 'defaults when inherit chain has no parent',
      workspaceSelector: 'inherit',
      userOverride: 'inherit',
      expectedLayer: 'default',
      expectedRequested: { kind: 'pinned', modelId: 'claude-opus-4-7' },
      expectedResolved: 'claude-opus-4-7',
      expectedSource: 'pinned',
    },
    {
      name: 'defaults when user inherit has no workspace selector',
      userOverride: 'inherit',
      expectedLayer: 'default',
      expectedRequested: { kind: 'pinned', modelId: 'claude-opus-4-7' },
      expectedResolved: 'claude-opus-4-7',
      expectedSource: 'pinned',
    },
    {
      name: 'defaults when workspace inherit has no parent and no user override',
      workspaceSelector: 'inherit',
      expectedLayer: 'default',
      expectedRequested: { kind: 'pinned', modelId: 'claude-opus-4-7' },
      expectedResolved: 'claude-opus-4-7',
      expectedSource: 'pinned',
    },
    {
      name: 'inherits from parent when workspace selector is inherit and user override is absent',
      workspaceSelector: 'inherit',
      parent,
      parentContextId: 'agent-456',
      expectedLayer: 'parent',
      expectedRequested: { kind: 'inherit' },
      expectedResolved: 'claude-sonnet-4-6',
      expectedSource: 'inherited',
      expectedParentContextId: 'agent-456',
    },
    {
      name: 'keeps pinned user source metadata',
      userOverride: { kind: 'pinned', modelId: 'gpt-5.4' },
      expectedLayer: 'user',
      expectedRequested: { kind: 'pinned', modelId: 'gpt-5.4' },
      expectedResolved: 'gpt-5.4',
      expectedSource: 'pinned',
    },
    {
      name: 'marks policy layer when cost policy downgrades a workspace-selected frontier model',
      workspaceSelector: 'opus',
      policyContext: makePolicyContext({
        maxCostTier: 'strong_generalist',
      }),
      expectedLayer: 'policy',
      expectedRequested: { kind: 'alias', family: 'opus', channel: 'stable' },
      expectedResolved: 'claude-sonnet-4-6',
      expectedSource: 'policy',
      expectedFallbackReason: 'disabled-by-policy',
      expectedFamilyChannel: 'stable',
    },
    {
      name: 'marks policy layer when quota downgrades a user-selected frontier model',
      userOverride: 'opus',
      policyContext: makePolicyContext({
        quotaState: makeQuotaSnapshot(DEFAULT_MODEL_REGISTRY, {
          'claude-opus-4-7': 'exhausted',
        }),
      }),
      expectedLayer: 'policy',
      expectedRequested: { kind: 'alias', family: 'opus', channel: 'stable' },
      expectedResolved: 'claude-sonnet-4-6',
      expectedSource: 'fallback',
      expectedFallbackReason: 'quota-exhausted',
      expectedFamilyChannel: 'stable',
    },
    {
      name: 'marks policy layer when alias target is unavailable in the registry',
      workspaceSelector: 'opus',
      policyContext: makePolicyContext({
        registryOverride: unavailableRegistry,
        quotaState: makeQuotaSnapshot(unavailableRegistry),
      }),
      expectedLayer: 'policy',
      expectedRequested: { kind: 'alias', family: 'opus', channel: 'stable' },
      expectedResolved: 'claude-sonnet-4-6',
      expectedSource: 'fallback',
      expectedFallbackReason: 'unavailable',
      expectedFamilyChannel: 'stable',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const policyContext = testCase.policyContext ?? makePolicyContext();
      const result = resolveEffectiveModel({
        workspaceSelector: testCase.workspaceSelector,
        userOverride: testCase.userOverride,
        parent: testCase.parent,
        parentContextId: testCase.parentContextId,
        policyContext,
      });

      assert.equal(result.resolutionLayer, testCase.expectedLayer);
      assert.deepEqual(result.requested, testCase.expectedRequested);
      assert.equal(result.resolved, testCase.expectedResolved);
      assert.equal(result.source, testCase.expectedSource);
      assert.equal(result.fallbackReason, testCase.expectedFallbackReason);
      assert.equal(result.familyChannel, testCase.expectedFamilyChannel);
      assert.equal(result.parentContextId, testCase.expectedParentContextId);

      const expectedWithoutLayer = resolveSelectorWithPolicy(
        testCase.expectedRequested,
        testCase.expectedRequested.kind === 'inherit'
          ? { parent: testCase.parent, parentContextId: testCase.parentContextId }
          : undefined,
        policyContext,
      );
      assert.deepEqual(stripResolutionLayer(result), expectedWithoutLayer);
    });
  }

  it('propagates typed selector parse errors for invalid string inputs', () => {
    assert.throws(
      () =>
        resolveEffectiveModel({
          workspaceSelector: 'not a valid selector',
          policyContext: makePolicyContext(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof ModelSelectorParseError);
        assert.equal(error.code, 'malformed_pinned_id');
        return true;
      },
    );
  });

  it('throws a policy resolution error when no viable substitute exists', () => {
    const registry: ModelRegistry = {
      models: {
        'claude-opus-4-7': DEFAULT_MODEL_REGISTRY.models['claude-opus-4-7'],
        'gpt-5.5': DEFAULT_MODEL_REGISTRY.models['gpt-5.5'],
      },
      ladders: {
        review: ['claude-opus-4-7', 'gpt-5.5'],
      },
    };

    assert.throws(
      () =>
        resolveEffectiveModel({
          workspaceSelector: 'opus',
          policyContext: makePolicyContext({
            registryOverride: registry,
            maxCostTier: 'strong_generalist',
            quotaState: makeQuotaSnapshot(registry, {
              'claude-opus-4-7': 'exhausted',
              'gpt-5.5': 'exhausted',
            }),
          }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof ModelPolicyResolutionError);
        assert.equal(error.code, 'no_viable_substitute');
        assert.equal(error.reason, 'quota-exhausted');
        return true;
      },
    );
  });

  it('throws a policy resolution error when no default candidate is viable', () => {
    const registry: ModelRegistry = {
      models: {
        'claude-opus-4-7': DEFAULT_MODEL_REGISTRY.models['claude-opus-4-7'],
      },
      ladders: {
        review: ['claude-opus-4-7'],
      },
    };

    assert.throws(
      () =>
        resolveEffectiveModel({
          policyContext: makePolicyContext({
            registryOverride: registry,
            maxCostTier: 'strong_generalist',
            quotaState: makeQuotaSnapshot(registry, {
              'claude-opus-4-7': 'exhausted',
            }),
          }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof ModelPolicyResolutionError);
        assert.equal(error.code, 'no_viable_substitute');
        return true;
      },
    );
  });

  it('inherits from an explicit parentResolvedModelId when the workspace selector is inherit', () => {
    const result = resolveEffectiveModel({
      workspaceSelector: 'inherit',
      parentResolvedModelId: 'claude-haiku-4-5-20251001',
      policyContext: makePolicyContext(),
    });

    assert.equal(result.resolutionLayer, 'parent');
    assert.deepEqual(result.requested, { kind: 'inherit' });
    assert.equal(result.resolved, 'claude-haiku-4-5-20251001');
    assert.equal(result.source, 'inherited');
  });

  it('inherits from WAVEMILL_RESOLVED_MODEL when parent context is absent', () => {
    const previous = process.env.WAVEMILL_RESOLVED_MODEL;
    process.env.WAVEMILL_RESOLVED_MODEL = 'claude-haiku-4-5-20251001';

    try {
      const result = resolveEffectiveModel({
        workspaceSelector: 'inherit',
        policyContext: makePolicyContext(),
      });

      assert.equal(result.resolutionLayer, 'parent');
      assert.deepEqual(result.requested, { kind: 'inherit' });
      assert.equal(result.resolved, 'claude-haiku-4-5-20251001');
      assert.equal(result.source, 'inherited');
    } finally {
      if (previous === undefined) {
        delete process.env.WAVEMILL_RESOLVED_MODEL;
      } else {
        process.env.WAVEMILL_RESOLVED_MODEL = previous;
      }
    }
  });

  it('ignores parentResolvedModelId for explicit selectors', () => {
    const result = resolveEffectiveModel({
      workspaceSelector: 'opus',
      parentResolvedModelId: 'claude-haiku-4-5-20251001',
      policyContext: makePolicyContext(),
    });

    assert.equal(result.resolutionLayer, 'workspace');
    assert.deepEqual(result.requested, { kind: 'alias', family: 'opus', channel: 'stable' });
    assert.equal(result.resolved, 'claude-opus-4-7');
    assert.equal(result.source, 'alias');
  });

  it('supports transitive inherit chains mixing explicit pins and aliases', () => {
    const root = resolveEffectiveModel({
      workspaceSelector: 'opus',
      policyContext: makePolicyContext(),
    });
    const child = resolveEffectiveModel({
      workspaceSelector: 'claude-haiku-4-5-20251001',
      parentResolvedModelId: root.resolved,
      policyContext: makePolicyContext(),
    });
    const grandchild = resolveEffectiveModel({
      workspaceSelector: 'inherit',
      parentResolvedModelId: child.resolved,
      policyContext: makePolicyContext(),
    });

    assert.equal(root.resolved, 'claude-opus-4-7');
    assert.equal(child.resolved, 'claude-haiku-4-5-20251001');
    assert.equal(grandchild.resolved, 'claude-haiku-4-5-20251001');
    assert.equal(grandchild.source, 'inherited');
  });
});
