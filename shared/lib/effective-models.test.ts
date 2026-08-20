import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  explainEffectiveModelAvailability,
  listEffectiveModelsForStage,
} from './effective-models.ts';
import { DEFAULT_MODEL_REGISTRY } from './model-registry.ts';
import { getStageContextFloor } from './stage-context-floors.ts';

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

  it('excludes context-ineligible models before they reach scheduling pools', () => {
    const { models } = listEffectiveModelsForStage('coding');
    assert.equal(models.includes('kimi-k2'), false);

    const availability = explainEffectiveModelAvailability('kimi-k2', 'coding');
    assert.equal(availability.available, false);
    assert.equal(availability.reason, 'context-window-insufficient');

    for (const model of models) {
      assert.ok(
        (DEFAULT_MODEL_REGISTRY.models[model]?.contextWindowTokens ?? 0) >= getStageContextFloor('coding'),
        'the 2026-08-17 kimi-k2 context-window failure should be unreachable via coding selection',
      );
    }
  });
});
