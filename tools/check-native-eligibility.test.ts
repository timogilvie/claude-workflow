import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../shared/lib/model-registry.ts';
import { checkNativeEligibility } from './check-native-eligibility.ts';

function makeCertifiedRegistry(modelId: string): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: 'test',
        class: 'strong_generalist',
        strengths: ['testing'],
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
          readOnlyNative: 'certified',
          compatFlags: { thinkingFormat: 'openrouter' },
        },
      },
    },
    ladders: {},
  };
}

function makeRepo(config: unknown): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'check-native-eligibility-'));
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
  return repoDir;
}

describe('check-native-eligibility', () => {
  it('returns the ready native planning model when config and provider are enabled', () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['planning'],
        providers: {
          openrouter: {
            models: ['qwen/qwen3-coder'],
          },
        },
      },
      modelRegistry: makeCertifiedRegistry('qwen/qwen3-coder'),
    });

    const originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    try {
      const result = checkNativeEligibility(repoDir, 'planning');
      assert.deepEqual(result, {
        eligible: true,
        model: 'qwen/qwen3-coder',
        reason: 'eligible',
      });
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalKey;
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns config_disabled when nativeAgent is turned off', () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: false,
        allowedPhases: ['planning'],
      },
    });

    try {
      assert.deepEqual(checkNativeEligibility(repoDir, 'planning'), {
        eligible: false,
        reason: 'config_disabled',
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns phase_not_allowed when planning is removed from allowed phases', () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['review'],
      },
    });

    try {
      assert.deepEqual(checkNativeEligibility(repoDir, 'planning'), {
        eligible: false,
        reason: 'phase_not_allowed',
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns no_ready_provider when the model is not certified for native planning', () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['planning'],
        providers: {
          openrouter: {
            models: ['qwen/qwen3-coder'],
          },
        },
      },
      modelRegistry: makeCertifiedRegistry('different-model'),
    });

    const originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    try {
      assert.deepEqual(checkNativeEligibility(repoDir, 'planning'), {
        eligible: false,
        reason: 'no_ready_provider',
      });
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalKey;
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
