/**
 * Tests for model-registry.ts
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadModelRegistry,
  clearModelRegistryCache,
  getCapability,
  listModels,
  getModelsByClass,
  getRankedLadder,
  type ModelRegistry,
} from './model-registry.ts';
import { clearConfigCache } from './config.ts';

describe('model-registry', () => {
  describe('loadModelRegistry', () => {
    it('loads and returns a cached registry', () => {
      const reg1 = loadModelRegistry('.');
      const reg2 = loadModelRegistry('.');
      assert.strictEqual(reg1, reg2, 'Should return same cached instance');
    });

    it('returns different registries for different repos', () => {
      const tmpDir1 = mkdtempSync('test-reg-');
      const tmpDir2 = mkdtempSync('test-reg-');

      const reg1 = loadModelRegistry(tmpDir1);
      const reg2 = loadModelRegistry(tmpDir2);
      assert.notStrictEqual(reg1, reg2, 'Different repos should have separate registries');
    });

    it('includes all seeded models', () => {
      const registry = loadModelRegistry('.');
      const expectedModels = [
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5-20251001',
        'gpt-5.4',
        'gpt-5.3-codex',
        'gpt-5.3-codex-spark',
      ];

      for (const modelId of expectedModels) {
        assert.ok(registry.models.has(modelId), `Should include ${modelId}`);
      }
    });
  });

  describe('clearModelRegistryCache', () => {
    it('clears cache for a specific repo', () => {
      const reg1 = loadModelRegistry('.');
      clearModelRegistryCache('.');
      const reg2 = loadModelRegistry('.');
      assert.notStrictEqual(reg1, reg2, 'Should return new instance after cache clear');
    });

    it('clears all caches when called without argument', () => {
      const tmpDir = mkdtempSync('test-reg-');
      const reg1 = loadModelRegistry(tmpDir);
      clearModelRegistryCache();
      const reg2 = loadModelRegistry(tmpDir);
      assert.notStrictEqual(reg1, reg2, 'Should clear all cached registries');
    });
  });

  describe('getCapability', () => {
    it('returns capability for known model', () => {
      const registry = loadModelRegistry('.');
      const cap = getCapability(registry, 'claude-opus-4-7');
      assert.ok(cap, 'Should return capability for known model');
      assert.strictEqual(cap.modelId, 'claude-opus-4-7');
      assert.strictEqual(cap.vendor, 'anthropic');
      assert.strictEqual(cap.class, 'frontier');
    });

    it('returns undefined for unknown model', () => {
      const registry = loadModelRegistry('.');
      const cap = getCapability(registry, 'unknown-model-xyz');
      assert.strictEqual(cap, undefined, 'Should return undefined for unknown model');
    });

    it('returns non-empty strengths and weaknesses', () => {
      const registry = loadModelRegistry('.');
      const cap = getCapability(registry, 'claude-opus-4-7');
      assert.ok(cap?.strengths && cap.strengths.length > 0, 'Should have strengths');
      assert.ok(cap?.weaknesses && cap.weaknesses.length > 0, 'Should have weaknesses');
    });

    it('returns task scores for all five profiles', () => {
      const registry = loadModelRegistry('.');
      const cap = getCapability(registry, 'claude-opus-4-7');
      const profiles = ['routing', 'planning', 'coding', 'review', 'classify'];
      for (const profile of profiles) {
        const score = cap?.taskScores[profile as any];
        assert.ok(score !== undefined && score > 0, `Should have positive score for ${profile}`);
      }
    });
  });

  describe('listModels', () => {
    it('returns all non-deprecated models', () => {
      const registry = loadModelRegistry('.');
      const models = listModels(registry);
      assert.ok(models.length > 0, 'Should return at least one model');
      assert.ok(models.every(m => !m.deprecated), 'Should not include deprecated models by default');
    });

    it('returns sorted by modelId', () => {
      const registry = loadModelRegistry('.');
      const models = listModels(registry);
      const ids = models.map(m => m.modelId);
      const sorted = [...ids].sort();
      assert.deepStrictEqual(ids, sorted, 'Should be sorted lexicographically');
    });

    it('includes deprecated when requested', () => {
      const registry = loadModelRegistry('.');
      const withoutDeprecated = listModels(registry);
      const withDeprecated = listModels(registry, { includeDeprecated: true });
      assert.ok(
        withDeprecated.length >= withoutDeprecated.length,
        'Including deprecated should return at least as many'
      );
    });
  });

  describe('getModelsByClass', () => {
    it('returns only frontier models', () => {
      const registry = loadModelRegistry('.');
      const frontier = getModelsByClass(registry, 'frontier');
      assert.ok(frontier.length > 0, 'Should find frontier models');
      assert.ok(frontier.every(m => m.class === 'frontier'), 'All should be frontier class');
      const ids = frontier.map(m => m.modelId);
      assert.ok(
        ids.includes('claude-opus-4-7') || ids.includes('claude-opus-4-6'),
        'Should include an opus model'
      );
    });

    it('returns only strong_generalist models', () => {
      const registry = loadModelRegistry('.');
      const generalist = getModelsByClass(registry, 'strong_generalist');
      assert.ok(generalist.length > 0, 'Should find strong_generalist models');
      assert.ok(
        generalist.every(m => m.class === 'strong_generalist'),
        'All should be strong_generalist class'
      );
    });

    it('returns only fast_economy models', () => {
      const registry = loadModelRegistry('.');
      const economy = getModelsByClass(registry, 'fast_economy');
      assert.ok(economy.length > 0, 'Should find fast_economy models');
      assert.ok(economy.every(m => m.class === 'fast_economy'), 'All should be fast_economy class');
    });
  });

  describe('getRankedLadder', () => {
    it('returns deterministic ladder for review profile', () => {
      const registry = loadModelRegistry('.');
      const ladder1 = getRankedLadder(registry, 'review');
      const ladder2 = getRankedLadder(registry, 'review');
      assert.deepStrictEqual(ladder1, ladder2, 'Should return same ladder across calls');
    });

    it('ranks opus before sonnet before haiku in review', () => {
      const registry = loadModelRegistry('.');
      const ladder = getRankedLadder(registry, 'review');
      const opusIdx = ladder.findIndex(id => id.includes('opus'));
      const sonnetIdx = ladder.findIndex(id => id.includes('sonnet'));
      const haikuIdx = ladder.findIndex(id => id.includes('haiku'));
      assert.ok(opusIdx >= 0 && sonnetIdx >= 0 && haikuIdx >= 0, 'Should have all three');
      assert.ok(
        opusIdx < sonnetIdx && sonnetIdx < haikuIdx,
        'Should rank opus > sonnet > haiku'
      );
    });

    it('returns haiku first for classify profile', () => {
      const registry = loadModelRegistry('.');
      const ladder = getRankedLadder(registry, 'classify');
      assert.ok(ladder.length > 0, 'Should return non-empty ladder');
      assert.ok(ladder[0].includes('haiku'), 'Should rank haiku first for classify');
    });

    it('excludes specified models', () => {
      const registry = loadModelRegistry('.');
      const allLadder = getRankedLadder(registry, 'review');
      assert.ok(allLadder.includes('claude-opus-4-7'), 'Opus should be in full ladder');

      const noOpus = getRankedLadder(registry, 'review', {
        excluded: ['claude-opus-4-7'],
      });
      assert.ok(!noOpus.includes('claude-opus-4-7'), 'Opus should be excluded');
      assert.ok(noOpus.length < allLadder.length, 'Excluded ladder should be shorter');
    });

    it('treats excluded unknown models as no-op', () => {
      const registry = loadModelRegistry('.');
      const ladder1 = getRankedLadder(registry, 'review');
      const ladder2 = getRankedLadder(registry, 'review', {
        excluded: ['unknown-model-xyz'],
      });
      assert.deepStrictEqual(ladder1, ladder2, 'Excluding unknown model should not change ladder');
    });

    it('filters to available whitelist', () => {
      const registry = loadModelRegistry('.');
      const filtered = getRankedLadder(registry, 'review', {
        available: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
      });
      assert.ok(
        filtered.length === 2 || filtered.length === 1,
        'Should only include available models'
      );
      assert.ok(
        !filtered.includes('claude-opus-4-7'),
        'Should not include non-available opus'
      );
    });

    it('preserves rank order when intersecting with available', () => {
      const registry = loadModelRegistry('.');
      const available = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
      const filtered = getRankedLadder(registry, 'review', { available });

      // The order should respect the ranking, not the order of available array
      // haiku has lower review score than sonnet, so sonnet should come first
      const sonnetIdx = filtered.findIndex(id => id.includes('sonnet'));
      const haikuIdx = filtered.findIndex(id => id.includes('haiku'));
      assert.ok(sonnetIdx < haikuIdx, 'Should rank by score not by available order');
    });

    it('excludes deprecated models by default', () => {
      const tmpDir = mkdtempSync('test-reg-');
      const config = {
        modelRegistry: {
          models: {
            'test-deprecated': {
              vendor: 'test',
              class: 'frontier' as const,
              strengths: [],
              weaknesses: [],
              taskScores: { review: 0.99 },
              deprecated: true,
            },
          },
        },
      };
      writeFileSync(join(tmpDir, '.wavemill-config.json'), JSON.stringify(config));

      clearConfigCache(tmpDir);
      clearModelRegistryCache(tmpDir);
      const registry = loadModelRegistry(tmpDir);
      const ladder = getRankedLadder(registry, 'review');
      assert.ok(!ladder.includes('test-deprecated'), 'Deprecated should be excluded by default');

      const withDeprecated = getRankedLadder(registry, 'review', { includeDeprecated: true });
      assert.ok(withDeprecated.includes('test-deprecated'), 'Deprecated should be included when requested');
    });
  });

  describe('config override: model merge', () => {
    it('shallow-merges taskScores overrides', () => {
      const tmpDir = mkdtempSync('test-reg-');
      const config = {
        modelRegistry: {
          models: {
            'claude-opus-4-7': {
              taskScores: { review: 0.50 }, // Override just review
            },
          },
        },
      };
      writeFileSync(join(tmpDir, '.wavemill-config.json'), JSON.stringify(config));

      clearConfigCache(tmpDir);
      clearModelRegistryCache(tmpDir);
      const registry = loadModelRegistry(tmpDir);
      const cap = getCapability(registry, 'claude-opus-4-7');

      // Review should be overridden
      assert.strictEqual(cap?.taskScores.review, 0.50, 'Review score should be overridden');
      // Other scores should remain from seed
      assert.ok(cap?.taskScores.planning! > 0.9, 'Planning should keep seed value');
    });

    it('adds new models from config', () => {
      const tmpDir = mkdtempSync('test-reg-');
      const config = {
        modelRegistry: {
          models: {
            'custom-model': {
              vendor: 'custom',
              class: 'fast_economy' as const,
              strengths: ['custom'],
              weaknesses: ['experimental'],
              taskScores: { review: 0.75 },
            },
          },
        },
      };
      writeFileSync(join(tmpDir, '.wavemill-config.json'), JSON.stringify(config));

      clearConfigCache(tmpDir);
      clearModelRegistryCache(tmpDir);
      const registry = loadModelRegistry(tmpDir);

      assert.ok(registry.models.has('custom-model'), 'Should have custom model');
      const cap = getCapability(registry, 'custom-model');
      assert.strictEqual(cap?.vendor, 'custom');
    });

    it('custom model appears in listModels', () => {
      const tmpDir = mkdtempSync('test-reg-');
      const config = {
        modelRegistry: {
          models: {
            'test-model-xyz': {
              vendor: 'test',
              class: 'frontier' as const,
              strengths: [],
              weaknesses: [],
              taskScores: {},
            },
          },
        },
      };
      writeFileSync(join(tmpDir, '.wavemill-config.json'), JSON.stringify(config));

      clearConfigCache(tmpDir);
      clearModelRegistryCache(tmpDir);
      const registry = loadModelRegistry(tmpDir);
      const models = listModels(registry);
      const ids = models.map(m => m.modelId);
      assert.ok(ids.includes('test-model-xyz'), 'Custom model should be in list');
    });
  });

  describe('config override: task profile ladder', () => {
    it('replaces default ladder when overridden', () => {
      const tmpDir = mkdtempSync('test-reg-');
      const config = {
        modelRegistry: {
          taskProfiles: {
            review: {
              ladder: ['gpt-5.4', 'gpt-5.3-codex'],
            },
          },
        },
      };
      writeFileSync(join(tmpDir, '.wavemill-config.json'), JSON.stringify(config));

      clearConfigCache(tmpDir);
      clearModelRegistryCache(tmpDir);
      const registry = loadModelRegistry(tmpDir);
      const ladder = getRankedLadder(registry, 'review');

      // Even though opus has higher score, the explicit ladder should control tiebreaker
      // But if gpt models are missing, they won't appear. The ladder acts as a tiebreaker.
      const reviewLadder = registry.taskProfiles.review.ladder;
      assert.deepStrictEqual(
        reviewLadder,
        ['gpt-5.4', 'gpt-5.3-codex'],
        'Ladder should be completely replaced'
      );
    });
  });

  describe('tiebreaker: explicit ladder order', () => {
    it('uses ladder rank as tiebreaker when scores are equal', () => {
      const tmpDir = mkdtempSync('test-reg-');
      const config = {
        modelRegistry: {
          models: {
            'tie-model-1': {
              vendor: 'test',
              class: 'strong_generalist' as const,
              strengths: [],
              weaknesses: [],
              taskScores: { review: 0.75 }, // Same score as tie-model-2
            },
            'tie-model-2': {
              vendor: 'test',
              class: 'strong_generalist' as const,
              strengths: [],
              weaknesses: [],
              taskScores: { review: 0.75 }, // Same score as tie-model-1
            },
          },
          taskProfiles: {
            review: {
              ladder: ['tie-model-2', 'tie-model-1'], // Explicit order
            },
          },
        },
      };
      writeFileSync(join(tmpDir, '.wavemill-config.json'), JSON.stringify(config));

      clearConfigCache(tmpDir);
      clearModelRegistryCache(tmpDir);
      const registry = loadModelRegistry(tmpDir);
      const ladder = getRankedLadder(registry, 'review');

      // Both models have same score, so ladder order should determine ranking
      const idx1 = ladder.indexOf('tie-model-2');
      const idx2 = ladder.indexOf('tie-model-1');
      assert.ok(idx1 >= 0 && idx2 >= 0, 'Both should be in ladder');
      assert.ok(idx1 < idx2, 'tie-model-2 should come before tie-model-1 per ladder');
    });
  });

  describe('empty available list', () => {
    it('treats empty available as no restriction', () => {
      const registry = loadModelRegistry('.');
      const ladder1 = getRankedLadder(registry, 'review');
      const ladder2 = getRankedLadder(registry, 'review', { available: [] });
      // Empty available is treated as "no restriction" per plan spec
      assert.deepStrictEqual(ladder1, ladder2, 'Empty available should act like no restriction');
    });
  });

  describe('models with zero score', () => {
    it('includes models with 0 score in ladder (ranked last)', () => {
      const tmpDir = mkdtempSync('test-reg-');
      const config = {
        modelRegistry: {
          models: {
            'zero-score-model': {
              vendor: 'test',
              class: 'fast_economy' as const,
              strengths: [],
              weaknesses: [],
              taskScores: { review: 0 }, // Explicit 0
            },
          },
        },
      };
      writeFileSync(join(tmpDir, '.wavemill-config.json'), JSON.stringify(config));

      clearConfigCache(tmpDir);
      clearModelRegistryCache(tmpDir);
      const registry = loadModelRegistry(tmpDir);
      const ladder = getRankedLadder(registry, 'review');

      // Should include model even with 0 score (ranked last)
      assert.ok(ladder.includes('zero-score-model'), 'Should include model with 0 score');
      assert.strictEqual(
        ladder[ladder.length - 1],
        'zero-score-model',
        'Should be ranked last due to 0 score'
      );
    });
  });

  describe('missing scores', () => {
    it('treats missing profile score as -Infinity (excluded from output)', () => {
      const tmpDir = mkdtempSync('test-reg-');
      const config = {
        modelRegistry: {
          models: {
            'no-score-model': {
              vendor: 'test',
              class: 'strong_generalist' as const,
              strengths: [],
              weaknesses: [],
              taskScores: {}, // No review score
            },
          },
        },
      };
      writeFileSync(join(tmpDir, '.wavemill-config.json'), JSON.stringify(config));

      clearConfigCache(tmpDir);
      clearModelRegistryCache(tmpDir);
      const registry = loadModelRegistry(tmpDir);
      const ladder = getRankedLadder(registry, 'review');

      // Model with no score should be excluded
      assert.ok(
        !ladder.includes('no-score-model'),
        'Should exclude model with missing score'
      );
    });
  });

  describe('scoring bounds', () => {
    it('accepts scores in range [0, 1]', () => {
      const tmpDir = mkdtempSync('test-reg-');
      const config = {
        modelRegistry: {
          models: {
            'min-model': {
              vendor: 'test',
              class: 'fast_economy' as const,
              strengths: [],
              weaknesses: [],
              taskScores: { review: 0 },
            },
            'max-model': {
              vendor: 'test',
              class: 'frontier' as const,
              strengths: [],
              weaknesses: [],
              taskScores: { review: 1 },
            },
          },
        },
      };
      writeFileSync(join(tmpDir, '.wavemill-config.json'), JSON.stringify(config));

      clearConfigCache(tmpDir);
      clearModelRegistryCache(tmpDir);
      const registry = loadModelRegistry(tmpDir);
      const minCap = getCapability(registry, 'min-model');
      const maxCap = getCapability(registry, 'max-model');

      assert.strictEqual(minCap?.taskScores.review, 0);
      assert.strictEqual(maxCap?.taskScores.review, 1);
    });
  });
});
