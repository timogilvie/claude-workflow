import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  explainEffectiveModelAvailability,
  listEffectiveModelsForStage,
} from './effective-models.ts';

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
    
    // These models should be excluded due to insufficient context window
    const excludedModels = [
      'kimi-k2',
      'mistral-large-2',
      'llama-3.3-70b',
      'deepseek-coder-v2',
      'qwen-2.5-coder-32b',
      'qwen-2.5-72b'
    ];
    
    for (const modelId of excludedModels) {
      assert.equal(models.includes(modelId), false, `${modelId} should not be effective for coding`);
      const availability = explainEffectiveModelAvailability(modelId, 'coding');
      assert.equal(availability.available, false);
      assert.equal(availability.reason, 'context-window-insufficient');
    }
    
    // But they should still be available for planning
    const planningModels = listEffectiveModelsForStage('planning');
    assert.ok(planningModels.includes('kimi-k2'), 'kimi-k2 should be available for planning');
  });
});
