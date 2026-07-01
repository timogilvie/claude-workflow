import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PHASE_ORDER, getDefaultScenarios } from './scenarios.ts';

describe('getDefaultScenarios — catalog integrity', () => {
  const scenarios = getDefaultScenarios();

  it('returns a non-empty array', () => {
    assert.ok(scenarios.length > 0, 'catalog must have at least one scenario');
  });

  it('every scenario has a non-empty id', () => {
    for (const scenario of scenarios) {
      assert.ok(
        typeof scenario.id === 'string' && scenario.id.length > 0,
        `scenario has empty or missing id: ${JSON.stringify(scenario)}`,
      );
    }
  });

  it('no duplicate scenario IDs', () => {
    const seen = new Set<string>();
    for (const scenario of scenarios) {
      assert.ok(
        !seen.has(scenario.id),
        `duplicate scenario ID: "${scenario.id}"`,
      );
      seen.add(scenario.id);
    }
  });

  it('every deterministic scenario has an assertion', () => {
    for (const scenario of scenarios) {
      if (scenario.classification === 'deterministic') {
        assert.ok(
          typeof scenario.assertion === 'function',
          `deterministic scenario "${scenario.id}" must have an assertion function`,
        );
      }
    }
  });

  it('no live-judged scenario has an assertion', () => {
    for (const scenario of scenarios) {
      if (scenario.classification === 'live-judged') {
        assert.equal(
          scenario.assertion,
          undefined,
          `live-judged scenario "${scenario.id}" must not have an assertion function`,
        );
      }
    }
  });

  it('every phase value is in PHASE_ORDER', () => {
    const validPhases = new Set<string>(PHASE_ORDER);
    for (const scenario of scenarios) {
      assert.ok(
        validPhases.has(scenario.phase),
        `scenario "${scenario.id}" has invalid phase "${scenario.phase}"`,
      );
    }
  });

  it('every category has at least one deterministic scenario', () => {
    const categories = ['budget', 'cleanup', 'policy', 'provenance', 'tool', 'usage', 'transcript', 'phase'] as const;
    const deterministicByCategory = new Map<string, number>();
    for (const scenario of scenarios) {
      if (scenario.classification === 'deterministic') {
        deterministicByCategory.set(
          scenario.category,
          (deterministicByCategory.get(scenario.category) ?? 0) + 1,
        );
      }
    }
    for (const category of categories) {
      assert.ok(
        (deterministicByCategory.get(category) ?? 0) > 0,
        `category "${category}" has no deterministic scenarios`,
      );
    }
  });

  it('at least one live-judged scenario exists (exercises not-run path)', () => {
    const hasLiveJudged = scenarios.some((s) => s.classification === 'live-judged');
    assert.ok(hasLiveJudged, 'catalog must include at least one live-judged scenario to exercise the not-run path');
  });

  it('workflow scenarios cover planning-specific certification concerns', () => {
    const workflowScenarios = scenarios.filter((scenario) => scenario.phase === 'workflow');
    const ids = new Set(workflowScenarios.map((scenario) => scenario.id));

    assert.ok(ids.has('workflow.planning.tool-availability'));
    assert.ok(ids.has('workflow.transcript-provenance.manifest-records'));
    assert.ok(ids.has('workflow.budget.cost-limit'));
    assert.ok(ids.has('workflow.cleanup.rollback-on-timeout'));
    assert.ok(ids.has('workflow.policy.denies-out-of-phase-mutation'));
    assert.ok(workflowScenarios.every((scenario) => scenario.classification === 'deterministic'));
  });

  it('getDefaultScenarios returns a new array each call', () => {
    const a = getDefaultScenarios();
    const b = getDefaultScenarios();
    assert.notEqual(a, b, 'getDefaultScenarios must return a fresh array each call');
    assert.deepEqual(a.map((s) => s.id), b.map((s) => s.id));
  });
});
