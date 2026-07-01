import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../../model-registry.ts';
import {
  aggregateReport,
  runScenarios,
  toArtifactScenario,
  type HarnessScenarioResult,
} from './scenario-runner.ts';
import {
  getDefaultScenarios,
  type CertificationScenario,
  type ScenarioAssertionOutcome,
  type ScenarioContext,
} from './scenarios.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal model registry that marks a model as certified for openrouter/openai-completions.
 *
 * The default catalog's `tool.compat.git_status.openai-completions` scenario uses the
 * openai-completions transport, which is served by the openrouter provider. The registry
 * must include the model with openrouter + openai-completions + thinkingFormat=openrouter
 * so that validateToolCompat returns ok: true.
 */
function makeCertifiedRegistry(modelId = 'openai/gpt-4o-mini'): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: 'openai',
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
        contextWindowTokens: 128_000,
        toolSupport: 'full',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 2,
        nativeCapability: {
          nativeProvider: 'openrouter',
          piTransportKind: 'openai-completions',
          compatFlags: { thinkingFormat: 'openrouter' },
          readOnlyNative: 'certified',
        },
      },
    },
    ladders: {},
  } as unknown as ModelRegistry;
}

function makePassingScenario(id: string): CertificationScenario {
  return {
    id,
    phase: 'read-only',
    category: 'tool',
    classification: 'deterministic',
    description: `Synthetic passing scenario: ${id}`,
    assertion: async (_ctx: ScenarioContext): Promise<ScenarioAssertionOutcome> => ({ kind: 'pass' }),
  };
}

function makeFailingScenario(id: string, detail = 'forced'): CertificationScenario {
  return {
    id,
    phase: 'read-only',
    category: 'tool',
    classification: 'deterministic',
    description: `Synthetic failing scenario: ${id}`,
    assertion: async (_ctx: ScenarioContext): Promise<ScenarioAssertionOutcome> => ({
      kind: 'fail',
      detail,
    }),
  };
}

function makeProviderFlakeScenario(id: string, detail = 'transient'): CertificationScenario {
  return {
    id,
    phase: 'read-only',
    category: 'tool',
    classification: 'deterministic',
    description: `Synthetic flaky scenario: ${id}`,
    assertion: async (_ctx: ScenarioContext): Promise<ScenarioAssertionOutcome> => ({
      kind: 'provider-flake',
      detail,
    }),
  };
}

function makeUnsupportedScenario(
  id: string,
  reason: 'fixture-not-found' | 'capability-validator-rejected' | 'shape-mismatch' | 'registry-missing-model',
  detail: string,
): CertificationScenario {
  return {
    id,
    phase: 'read-only',
    category: 'tool',
    classification: 'deterministic',
    description: `Synthetic unsupported scenario: ${id}`,
    assertion: async (_ctx: ScenarioContext): Promise<ScenarioAssertionOutcome> => ({
      kind: 'unsupported',
      reason,
      detail,
    }),
  };
}

function makeThrowingScenario(id: string, message: string): CertificationScenario {
  return {
    id,
    phase: 'read-only',
    category: 'tool',
    classification: 'deterministic',
    description: `Synthetic throwing scenario: ${id}`,
    assertion: async (_ctx: ScenarioContext): Promise<ScenarioAssertionOutcome> => {
      throw new Error(message);
    },
  };
}

function makeLiveJudgedScenario(id: string): CertificationScenario {
  return {
    id,
    phase: 'read-only',
    category: 'tool',
    classification: 'live-judged',
    description: `Synthetic live-judged scenario: ${id}`,
    knownLimitation: 'Requires live judge.',
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runScenarios — happy path', () => {
  it('runs all default deterministic scenarios against a certified model', async () => {
    const scenarios = getDefaultScenarios();
    // openai-completions transport is served by the openrouter provider.
    const registry = makeCertifiedRegistry('openai/gpt-4o-mini');

    const report = await runScenarios({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      transport: 'openai-completions',
      scenarios,
      registry,
    });

    assert.equal(report.results.length, scenarios.length, 'result count must match scenario count');
    assert.equal(report.dryRun, false);
    assert.equal(report.harnessPassed, true, `harnessPassed must be true; fails: ${JSON.stringify(report.results.filter(r => r.status !== 'pass' && r.status !== 'not-run'))}`);
    assert.equal(report.liveCertifiable, true);
    assert.equal(report.provider, 'openrouter');
    assert.equal(report.model, 'openai/gpt-4o-mini');
    assert.equal(report.transport, 'openai-completions');
  });

  it('returns not-run for live-judged scenarios', async () => {
    const scenarios = getDefaultScenarios();
    const liveJudged = scenarios.filter((s) => s.classification === 'live-judged');
    assert.ok(liveJudged.length > 0, 'need at least one live-judged scenario for this test');

    const report = await runScenarios({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      transport: 'openai-completions',
      scenarios,
      registry: makeCertifiedRegistry('openai/gpt-4o-mini'),
    });

    for (const s of liveJudged) {
      const result = report.results.find((r) => r.scenarioId === s.id);
      assert.ok(result, `expected result for live-judged scenario "${s.id}"`);
      assert.equal(result.status, 'not-run');
      assert.equal(result.reason, 'requires-live-judge');
    }
  });
});

// ---------------------------------------------------------------------------
// Fail path
// ---------------------------------------------------------------------------

describe('runScenarios — fail path', () => {
  it('a failing assertion makes harnessPassed false', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [makeFailingScenario('fail-test', 'forced failure')],
    });

    assert.equal(report.harnessPassed, false);
    assert.equal(report.liveCertifiable, false);
    assert.equal(report.countsByStatus.fail, 1);
    const result = report.results[0];
    assert.equal(result.status, 'fail');
    assert.equal(result.detail, 'forced failure');
    assert.equal(result.attempts, 1);
    assert.equal(result.finalAttemptStatus, 'fail');
    assert.equal(result.failureClass, 'deterministic_failure');
  });

  it('a thrown assertion becomes a fail result (loud-fail invariant)', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [makeThrowingScenario('throw-test', 'boom')],
    });

    assert.equal(report.harnessPassed, false);
    const result = report.results[0];
    assert.equal(result.status, 'fail');
    assert.ok(result.detail?.includes('boom'), `detail should include error message; got: ${result.detail}`);
    assert.equal(result.attempts, 1);
    assert.equal(result.finalAttemptStatus, 'fail');
    assert.equal(result.failureClass, 'deterministic_failure');
  });
});

// ---------------------------------------------------------------------------
// Unsupported paths
// ---------------------------------------------------------------------------

describe('runScenarios — unsupported paths', () => {
  it('fixture-not-found produces unsupported result in results array (not omission)', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [makeUnsupportedScenario('no-fixture', 'fixture-not-found', 'Tool "x" has no fixture')],
    });

    assert.equal(report.results.length, 1);
    const result = report.results[0];
    assert.equal(result.status, 'unsupported');
    assert.equal(result.reason, 'fixture-not-found');
    assert.ok(result.detail && result.detail.length > 0, 'detail must be non-empty');
    assert.equal(report.harnessPassed, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.finalAttemptStatus, 'unsupported');
    assert.equal(result.failureClass, 'unsupported_capability');
  });

  it('capability-validator-rejected produces unsupported result', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [
        makeUnsupportedScenario(
          'cap-rejected',
          'capability-validator-rejected',
          'model not certified for this transport',
        ),
      ],
    });

    const result = report.results[0];
    assert.equal(result.status, 'unsupported');
    assert.equal(result.reason, 'capability-validator-rejected');
    assert.ok(result.detail && result.detail.length > 0);
    assert.equal(report.harnessPassed, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.finalAttemptStatus, 'unsupported');
    assert.equal(result.failureClass, 'unsupported_capability');
  });

  it('tool.compat.git_status scenario is unsupported when model is not in registry', async () => {
    // Empty registry — model has no nativeCapability → validateToolCompat rejects it.
    const scenarios = getDefaultScenarios().filter(
      (s) => s.id === 'tool.compat.git_status.openai-completions',
    );
    assert.equal(scenarios.length, 1);

    const emptyRegistry: ModelRegistry = { models: {}, ladders: {} };

    const report = await runScenarios({
      provider: 'openrouter',
      model: 'unknown-model',
      transport: 'openai-completions',
      scenarios,
      registry: emptyRegistry,
    });

    assert.equal(report.results.length, 1);
    const result = report.results[0];
    assert.equal(result.status, 'unsupported');
    assert.equal(result.reason, 'capability-validator-rejected');
    assert.ok(result.detail && result.detail.length > 0);
    assert.equal(result.attempts, 1);
    assert.equal(result.finalAttemptStatus, 'unsupported');
    assert.equal(result.failureClass, 'unsupported_capability');
  });

  it('unsupported transport string surfaces as unsupported or fail rather than omission', async () => {
    // A scenario that tries to look up a fixture with an unknown transport
    // will either throw (unknown transport from validateToolCompat) or return unsupported.
    // Either way, it must appear in results and harnessPassed must be false.
    const badTransportScenario: CertificationScenario = {
      id: 'bad-transport',
      phase: 'read-only',
      category: 'tool',
      classification: 'deterministic',
      description: 'Tests that an unknown transport produces a loud result',
      assertion: async (_ctx) => {
        // Simulate the fixture-not-found path with an unsupported transport string
        const { findFixture } = await import('../fixtures/compat/index.ts');
        // Cast to PiTransportKind to simulate code that passes a bad transport
        const fixture = findFixture('git_status', 'unknown-transport' as unknown as import('../../model-registry.ts').PiTransportKind);
        if (!fixture) {
          return {
            kind: 'unsupported' as const,
            reason: 'fixture-not-found' as const,
            detail: 'Tool "git_status" has no compat fixture for transport "unknown-transport"',
          };
        }
        return { kind: 'pass' as const };
      },
    };

    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [badTransportScenario],
    });

    assert.equal(report.results.length, 1);
    const result = report.results[0];
    assert.ok(
      result.status === 'unsupported' || result.status === 'fail',
      `expected unsupported or fail, got: ${result.status}`,
    );
    assert.equal(report.harnessPassed, false);
  });
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

describe('runScenarios — retry policy', () => {
  it('retries provider flakes until maxAttempts then records flake exhaustion', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [makeProviderFlakeScenario('flake-exhausted')],
      retryPolicy: { maxAttempts: 3 },
    });

    const result = report.results[0];
    assert.equal(result.status, 'fail');
    assert.equal(result.attempts, 3);
    assert.equal(result.finalAttemptStatus, 'provider-flake');
    assert.equal(result.failureClass, 'provider_flake');
    assert.equal(report.harnessPassed, false);
  });

  it('respects a single-attempt retry bound for persistent flakes', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [makeProviderFlakeScenario('flake-single')],
      retryPolicy: { maxAttempts: 1 },
    });

    const result = report.results[0];
    assert.equal(result.status, 'fail');
    assert.equal(result.attempts, 1);
    assert.equal(result.finalAttemptStatus, 'provider-flake');
    assert.equal(result.failureClass, 'provider_flake');
    assert.equal(report.harnessPassed, false);
  });

  it('does not retry deterministic failures', async () => {
    let calls = 0;
    const scenario: CertificationScenario = {
      id: 'deterministic-no-retry',
      phase: 'read-only',
      category: 'tool',
      classification: 'deterministic',
      description: 'deterministic failure short-circuits retries',
      assertion: async () => {
        calls += 1;
        return { kind: 'fail', detail: 'nope' };
      },
    };

    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [scenario],
      retryPolicy: { maxAttempts: 5 },
    });

    const result = report.results[0];
    assert.equal(calls, 1);
    assert.equal(result.attempts, 1);
    assert.equal(result.failureClass, 'deterministic_failure');
    assert.equal(result.finalAttemptStatus, 'fail');
  });

  it('does not retry thrown errors', async () => {
    let calls = 0;
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [{
        id: 'throw-no-retry',
        phase: 'read-only',
        category: 'tool',
        classification: 'deterministic',
        description: 'throws once',
        assertion: async () => {
          calls += 1;
          throw new Error('boom');
        },
      }],
      retryPolicy: { maxAttempts: 5 },
    });

    const result = report.results[0];
    assert.equal(calls, 1);
    assert.equal(result.status, 'fail');
    assert.equal(result.attempts, 1);
    assert.equal(result.failureClass, 'deterministic_failure');
    assert.equal(result.finalAttemptStatus, 'fail');
  });

  it('does not retry unsupported outcomes', async () => {
    let calls = 0;
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [{
        id: 'unsupported-no-retry',
        phase: 'read-only',
        category: 'tool',
        classification: 'deterministic',
        description: 'unsupported short-circuits retries',
        assertion: async () => {
          calls += 1;
          return { kind: 'unsupported', reason: 'fixture-not-found', detail: 'missing' };
        },
      }],
      retryPolicy: { maxAttempts: 5 },
    });

    const result = report.results[0];
    assert.equal(calls, 1);
    assert.equal(result.status, 'unsupported');
    assert.equal(result.attempts, 1);
    assert.equal(result.failureClass, 'unsupported_capability');
    assert.equal(result.finalAttemptStatus, 'unsupported');
  });

  it('passes when a later attempt succeeds after a flake', async () => {
    let calls = 0;
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [{
        id: 'flake-then-pass',
        phase: 'read-only',
        category: 'tool',
        classification: 'deterministic',
        description: 'transient flake followed by pass',
        assertion: async () => {
          calls += 1;
          return calls === 1
            ? { kind: 'provider-flake', detail: 'transient' }
            : { kind: 'pass' };
        },
      }],
      retryPolicy: { maxAttempts: 3 },
    });

    const result = report.results[0];
    assert.equal(result.status, 'pass');
    assert.equal(result.attempts, 2);
    assert.equal(result.finalAttemptStatus, 'pass');
    assert.equal(result.failureClass, undefined);
    assert.equal(report.harnessPassed, true);
  });

  it('passes on the boundary when the final allowed attempt succeeds', async () => {
    let calls = 0;
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [{
        id: 'flake-flake-pass',
        phase: 'read-only',
        category: 'tool',
        classification: 'deterministic',
        description: 'passes on last allowed retry',
        assertion: async () => {
          calls += 1;
          return calls < 3
            ? { kind: 'provider-flake', detail: `transient-${calls}` }
            : { kind: 'pass' };
        },
      }],
      retryPolicy: { maxAttempts: 3 },
    });

    const result = report.results[0];
    assert.equal(result.status, 'pass');
    assert.equal(result.attempts, 3);
    assert.equal(result.finalAttemptStatus, 'pass');
    assert.equal(result.failureClass, undefined);
  });

  it('exhausts retries before a later hypothetical pass', async () => {
    let calls = 0;
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [{
        id: 'flake-flake-would-pass',
        phase: 'read-only',
        category: 'tool',
        classification: 'deterministic',
        description: 'retry bound prevents later pass',
        assertion: async () => {
          calls += 1;
          return calls < 3
            ? { kind: 'provider-flake', detail: `transient-${calls}` }
            : { kind: 'pass' };
        },
      }],
      retryPolicy: { maxAttempts: 2 },
    });

    const result = report.results[0];
    assert.equal(result.status, 'fail');
    assert.equal(result.attempts, 2);
    assert.equal(result.finalAttemptStatus, 'provider-flake');
    assert.equal(result.failureClass, 'provider_flake');
    assert.equal(report.harnessPassed, false);
  });

  it('validates retry bounds', async () => {
    await assert.rejects(
      () => runScenarios({
        provider: 'openai',
        model: 'gpt-4o',
        transport: 'openai-completions',
        scenarios: [],
        retryPolicy: { maxAttempts: 0 },
      }),
      TypeError,
    );

    await assert.rejects(
      () => runScenarios({
        provider: 'openai',
        model: 'gpt-4o',
        transport: 'openai-completions',
        scenarios: [],
        retryPolicy: { maxAttempts: -1 },
      }),
      TypeError,
    );

    await assert.rejects(
      () => runScenarios({
        provider: 'openai',
        model: 'gpt-4o',
        transport: 'openai-completions',
        scenarios: [],
        retryPolicy: { maxAttempts: 1.5 },
      }),
      TypeError,
    );
  });

  it('defaults maxAttempts to 3 when omitted', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [makeProviderFlakeScenario('flake-default')],
    });

    assert.equal(report.results[0].attempts, 3);
  });

  it('retries only flaky scenarios in a mixed suite', async () => {
    let deterministicCalls = 0;
    let flakyCalls = 0;

    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [
        {
          id: 'deterministic',
          phase: 'read-only',
          category: 'tool',
          classification: 'deterministic',
          description: 'deterministic fail',
          assertion: async () => {
            deterministicCalls += 1;
            return { kind: 'fail', detail: 'deterministic' };
          },
        },
        {
          id: 'flaky',
          phase: 'read-only',
          category: 'tool',
          classification: 'deterministic',
          description: 'flake then pass',
          assertion: async () => {
            flakyCalls += 1;
            return flakyCalls === 1
              ? { kind: 'provider-flake', detail: 'transient' }
              : { kind: 'pass' };
          },
        },
      ],
      retryPolicy: { maxAttempts: 3 },
    });

    assert.equal(deterministicCalls, 1);
    assert.equal(flakyCalls, 2);
    assert.equal(report.results.find(r => r.scenarioId === 'deterministic')?.attempts, 1);
    assert.equal(report.results.find(r => r.scenarioId === 'flaky')?.attempts, 2);
  });
});

// ---------------------------------------------------------------------------
// Empty and edge cases
// ---------------------------------------------------------------------------

describe('runScenarios — edge cases', () => {
  it('empty scenarios list returns a passed, certifiable report', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [],
    });

    assert.equal(report.results.length, 0);
    assert.equal(report.harnessPassed, true);
    assert.equal(report.liveCertifiable, true);
    assert.equal(report.dryRun, false);
  });

  it('duplicate scenario IDs are NOT deduped by the runner', async () => {
    // Catalog integrity (uniqueness) is enforced by scenarios.test.ts.
    // The runner processes inputs verbatim.
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [
        makePassingScenario('dup-id'),
        makePassingScenario('dup-id'),
      ],
    });

    assert.equal(report.results.length, 2, 'runner must not deduplicate inputs');
    assert.equal(report.results[0].scenarioId, 'dup-id');
    assert.equal(report.results[1].scenarioId, 'dup-id');
  });

  it('throws TypeError for non-array scenarios', async () => {
    await assert.rejects(
      () =>
        runScenarios({
          provider: 'openai',
          model: 'gpt-4o',
          transport: 'openai-completions',
          scenarios: null as unknown as CertificationScenario[],
        }),
      TypeError,
    );
  });

  it('throws TypeError for empty provider', async () => {
    await assert.rejects(
      () =>
        runScenarios({
          provider: '' as unknown as 'openai',
          model: 'gpt-4o',
          transport: 'openai-completions',
          scenarios: [],
        }),
      TypeError,
    );
  });

  it('throws TypeError for empty model', async () => {
    await assert.rejects(
      () =>
        runScenarios({
          provider: 'openai',
          model: '',
          transport: 'openai-completions',
          scenarios: [],
        }),
      TypeError,
    );
  });

  it('throws TypeError for empty transport', async () => {
    await assert.rejects(
      () =>
        runScenarios({
          provider: 'openai',
          model: 'gpt-4o',
          transport: '' as unknown as 'openai-completions',
          scenarios: [],
        }),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

describe('runScenarios — dry-run', () => {
  it('dry-run report has dryRun: true and liveCertifiable: false', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [makePassingScenario('pass-dry')],
      dryRun: true,
    });

    assert.equal(report.dryRun, true);
    assert.equal(report.harnessPassed, true);
    assert.equal(report.liveCertifiable, false, 'dry-run report must never be live-certifiable');
  });

  it('dry-run with a failure is both harnessPassed: false and liveCertifiable: false', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [makeFailingScenario('fail-dry')],
      dryRun: true,
    });

    assert.equal(report.dryRun, true);
    assert.equal(report.harnessPassed, false);
    assert.equal(report.liveCertifiable, false);
  });

  it('toArtifactScenario projects a dry-run result to valid ScenarioResult shape', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'gpt-4o',
      transport: 'openai-completions',
      scenarios: [makePassingScenario('pass-dry-artifact')],
      dryRun: true,
    });

    // The artifact shape is valid even for dry-run results,
    // but the REPORT's liveCertifiable: false is the guard.
    assert.equal(report.liveCertifiable, false);

    const artifactScenario = toArtifactScenario(report.results[0]);
    assert.equal(typeof artifactScenario.scenarioId, 'string');
    assert.equal(typeof artifactScenario.passed, 'boolean');
    assert.equal(artifactScenario.passed, true);
    assert.equal(artifactScenario.scenarioId, 'pass-dry-artifact');
  });
});

// ---------------------------------------------------------------------------
// toArtifactScenario
// ---------------------------------------------------------------------------

describe('toArtifactScenario', () => {
  function makeResult(
    overrides: Partial<HarnessScenarioResult>,
  ): HarnessScenarioResult {
    return {
      scenarioId: 'test',
      category: 'tool',
      classification: 'deterministic',
      phase: 'read-only',
      status: 'pass',
      durationMs: 1,
      ...overrides,
    };
  }

  it('pass result projects to passed: true', () => {
    const s = toArtifactScenario(makeResult({ status: 'pass', attempts: 2, finalAttemptStatus: 'pass' }));
    assert.equal(s.passed, true);
    assert.equal(s.failureMessage, undefined);
    assert.equal(s.attempts, 2);
    assert.equal(s.retryCount, 1);
    assert.equal(s.finalAttemptStatus, 'pass');
    assert.equal(s.failureClass, undefined);
  });

  it('fail result projects to passed: false with failureMessage', () => {
    const s = toArtifactScenario(makeResult({ status: 'fail', detail: 'oops' }));
    assert.equal(s.passed, false);
    assert.equal(s.failureMessage, 'oops');
  });

  it('flake exhausted result projects failureClass and retryCount', () => {
    const s = toArtifactScenario(
      makeResult({
        status: 'fail',
        detail: 'transient',
        attempts: 3,
        finalAttemptStatus: 'provider-flake',
        failureClass: 'provider_flake',
      }),
    );
    assert.equal(s.passed, false);
    assert.equal(s.attempts, 3);
    assert.equal(s.retryCount, 2);
    assert.equal(s.finalAttemptStatus, 'provider-flake');
    assert.equal(s.failureClass, 'provider_flake');
  });

  it('unsupported result projects to passed: false', () => {
    const s = toArtifactScenario(
      makeResult({
        status: 'unsupported',
        reason: 'fixture-not-found',
        detail: 'x',
        attempts: 1,
        finalAttemptStatus: 'unsupported',
        failureClass: 'unsupported_capability',
      }),
    );
    assert.equal(s.passed, false);
    assert.equal(s.failureClass, 'unsupported_capability');
  });

  it('not-run result projects to passed: false', () => {
    const s = toArtifactScenario(
      makeResult({ status: 'not-run', reason: 'requires-live-judge' }),
    );
    assert.equal(s.passed, false);
  });
});

// ---------------------------------------------------------------------------
// aggregateReport
// ---------------------------------------------------------------------------

describe('aggregateReport', () => {
  it('countsByStatus and countsByCategory sum correctly', () => {
    const results: HarnessScenarioResult[] = [
      { scenarioId: 'a', category: 'tool', classification: 'deterministic', phase: 'read-only', status: 'pass', durationMs: 1 },
      { scenarioId: 'b', category: 'usage', classification: 'deterministic', phase: 'read-only', status: 'fail', detail: 'x', durationMs: 1 },
      { scenarioId: 'c', category: 'transcript', classification: 'live-judged', phase: 'read-only', status: 'not-run', reason: 'requires-live-judge', durationMs: 1 },
      { scenarioId: 'd', category: 'phase', classification: 'deterministic', phase: 'read-only', status: 'unsupported', reason: 'fixture-not-found', detail: 'y', durationMs: 1 },
    ];

    const report = aggregateReport(
      { provider: 'openai', model: 'gpt-4o', transport: 'openai-completions', dryRun: false },
      results,
    );

    assert.equal(report.countsByStatus.pass, 1);
    assert.equal(report.countsByStatus.fail, 1);
    assert.equal(report.countsByStatus['not-run'], 1);
    assert.equal(report.countsByStatus.unsupported, 1);
    assert.equal(report.countsByCategory.tool, 1);
    assert.equal(report.countsByCategory.usage, 1);
    assert.equal(report.countsByCategory.transcript, 1);
    assert.equal(report.countsByCategory.phase, 1);
    assert.equal(report.harnessPassed, false);
    assert.equal(report.liveCertifiable, false);
  });

  it('knownLimitations are deduplicated', () => {
    const results: HarnessScenarioResult[] = [
      { scenarioId: 'a', category: 'tool', classification: 'live-judged', phase: 'read-only', status: 'not-run', reason: 'requires-live-judge', knownLimitation: 'same caveat', durationMs: 1 },
      { scenarioId: 'b', category: 'tool', classification: 'live-judged', phase: 'read-only', status: 'not-run', reason: 'requires-live-judge', knownLimitation: 'same caveat', durationMs: 1 },
    ];

    const report = aggregateReport(
      { provider: 'openai', model: 'gpt-4o', transport: 'openai-completions', dryRun: false },
      results,
    );

    assert.equal(report.knownLimitations.length, 1);
    assert.equal(report.knownLimitations[0], 'same caveat');
  });
});
