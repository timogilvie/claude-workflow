import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  explainEffectiveModelAvailability,
  listChallengerEligibleModelsForStage,
  listEffectiveModelsForStage,
} from './effective-models.ts';
import { explainModelSupportExclusion } from './model-registry.ts';

describe('effective-models', () => {
  it('excludes retired native-openrouter aliases from coding availability', () => {
    const retired = ['deepseek-coder-v2', 'gemini-2.0-flash', 'grok-code-fast', 'qwen-2.5-coder-32b'];
    const { models } = listEffectiveModelsForStage('coding');

    for (const alias of retired) {
      assert.equal(models.includes(alias), false, `${alias} should not be effective for coding`);
      const availability = explainEffectiveModelAvailability(alias, 'coding');
      assert.equal(availability.available, false);
      assert.equal(availability.reason, 'blocked-lifecycle');
    }
  });

  it('excludes models with insufficient context window from coding availability', () => {
    // Test kimi-k2 specifically
    const availability = explainEffectiveModelAvailability('kimi-k2', 'coding');
    assert.equal(availability.available, false);
    assert.equal(availability.reason, 'context-window-insufficient');
    
    // But should be available for planning (no floor)
    const planningAvailability = explainEffectiveModelAvailability('kimi-k2', 'planning');
    assert.equal(planningAvailability.available, true);
  });

  it('listEffectiveModelsForStage excludes context-window-insufficient models', () => {
    const { models } = listEffectiveModelsForStage('coding');

    // Models actively selectable today whose declared window falls below the
    // built-in coding floor. Their exclusion reason must be
    // `context-window-insufficient`.
    const contextWindowExcluded = [
      'kimi-k2',
      'mistral-large-2',
      'llama-3.3-70b',
    ];
    for (const modelId of contextWindowExcluded) {
      assert.equal(models.includes(modelId), false, `${modelId} should not be effective for coding`);
      const availability = explainEffectiveModelAvailability(modelId, 'coding');
      assert.equal(availability.available, false);
      assert.equal(availability.reason, 'context-window-insufficient');
    }

    // Models retained for historical attribution but lifecycle-blocked by prior
    // work (HOK-2773, and qwen-2.5-72b by HOK-2783's registry admission
    // criteria). blocked-lifecycle wins over context-window-insufficient.
    const lifecycleExcluded = ['deepseek-coder-v2', 'qwen-2.5-coder-32b', 'qwen-2.5-72b'];
    for (const modelId of lifecycleExcluded) {
      assert.equal(models.includes(modelId), false, `${modelId} should not be effective for coding`);
      const availability = explainEffectiveModelAvailability(modelId, 'coding');
      assert.equal(availability.available, false);
      assert.equal(availability.reason, 'blocked-lifecycle');
    }

    // But they should still be available for planning
    const { models: planningModels } = listEffectiveModelsForStage('planning');
    assert.ok(planningModels.includes('kimi-k2'), 'kimi-k2 should be available for planning');
  });
});

describe('challenger eligibility', () => {
  it('keeps the deprecated ox-alpha out of both pools and admits promoted glm-5.3-flash', () => {
    // Disclosure day: ox-alpha is deprecated historical lineage (routing
    // ineligible), so it leaves the challenger pool too; its verified
    // successor glm-5.3-flash is certified and routing-eligible, so it enters
    // the primary pool (and therefore the challenger superset).
    for (const stage of ['planning', 'coding', 'review'] as const) {
      const primary = listEffectiveModelsForStage(stage, {}).models;
      const challenger = listChallengerEligibleModelsForStage(stage, {}).models;

      assert.equal(
        primary.includes('ox-alpha'),
        false,
        `deprecated model must never be primary-eligible for ${stage}`,
      );
      assert.equal(
        challenger.includes('ox-alpha'),
        false,
        `deprecated model must not stay challenger-eligible for ${stage}`,
      );
      assert.equal(
        primary.includes('glm-5.3-flash'),
        true,
        `promoted model should be primary-eligible for ${stage}`,
      );
      assert.equal(
        challenger.includes('glm-5.3-flash'),
        true,
        `promoted model should be challenger-eligible for ${stage}`,
      );
    }
  });

  it('permits only provisional identity, never any other exclusion', () => {
    // Every other exclusion must still apply. A blocked, disabled or
    // stage-incompatible model must not reach the challenger pool.
    for (const stage of ['planning', 'coding', 'review'] as const) {
      const primary = new Set(listEffectiveModelsForStage(stage, {}).models);
      const extra = listChallengerEligibleModelsForStage(stage, {}).models
        .filter((model) => !primary.has(model));

      for (const model of extra) {
        assert.equal(
          explainModelSupportExclusion(model, stage),
          'provisional-identity',
          `${model} entered the challenger pool for a reason other than provisional identity`,
        );
      }
    }
  });

  it('does not widen the primary pool at all', () => {
    for (const stage of ['planning', 'coding', 'review'] as const) {
      const primary = listEffectiveModelsForStage(stage, {}).models;
      const challenger = listChallengerEligibleModelsForStage(stage, {}).models;
      // Challenger is a strict superset; primary must lose nothing and gain nothing.
      assert.ok(primary.every((model) => challenger.includes(model)));
      assert.equal(primary.includes('ox-alpha'), false);
    }
  });
});
