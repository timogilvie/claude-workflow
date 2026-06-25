import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { aggregateEvalHistory, recommendModel, resolveAgent } from './model-router.ts';

function writeRepoConfig(repoDir: string, config: unknown): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
}

describe('model-router resolveAgent', () => {
  it('routes known DeepSeek models to claude', () => {
    assert.equal(resolveAgent('deepseek-v4-pro', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('deepseek-v4-pro[1m]', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('deepseek-v4-flash', {}, 'codex'), 'claude');
  });

  it('throws for unknown DeepSeek-like models instead of falling back', () => {
    assert.throws(
      () => resolveAgent('deepseek-v4-ultra', {}, 'claude'),
      /Unknown DeepSeek model "deepseek-v4-ultra"/,
    );
  });

  it('preserves existing claude and gpt resolution heuristics', () => {
    assert.equal(resolveAgent('claude-sonnet-4-6', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('gpt-5.4', {}, 'claude'), 'codex');
  });

  it('does not route OpenRouter aliases through the disabled claude-openrouter shim', () => {
    assert.equal(resolveAgent('qwen-3-coder', {}, 'codex'), 'codex');
    assert.equal(resolveAgent('qwen-3-coder', { 'qwen-3-coder': 'claude-openrouter' }, 'codex'), 'codex');
  });

  it('resolves native-openai only when native config is enabled and the phase is allowed', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-openai-'));

    try {
      writeRepoConfig(repoDir, {
        nativeAgent: {
          enabled: true,
          allowedPhases: ['planning', 'review'],
          providers: {
            openai: {
              apiKeyEnv: 'OPENAI_API_KEY',
            },
          },
        },
        modelRegistry: {
          models: {
            'gpt-5.4': {
              agent: 'native-openai',
              nativeCapability: {
                nativeProvider: 'openai',
                piTransportKind: 'openai-responses',
                readOnlyNative: 'certified',
              },
            },
          },
        },
      });

      assert.equal(resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'planning'), 'native-openai');
      assert.equal(resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'review'), 'native-openai');
      assert.equal(resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'coding'), 'codex');
      assert.equal(resolveAgent('gpt-5.4', {}, 'codex', repoDir), 'codex');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps legacy resolution when native config is absent or disabled', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-default-off-'));

    try {
      writeRepoConfig(repoDir, {
        nativeAgent: {
          enabled: false,
          allowedPhases: ['planning', 'review'],
          providers: {
            openai: {
              apiKeyEnv: 'OPENAI_API_KEY',
            },
          },
        },
        modelRegistry: {
          models: {
            'gpt-5.4': {
              agent: 'native-openai',
              nativeCapability: {
                nativeProvider: 'openai',
                piTransportKind: 'openai-responses',
                readOnlyNative: 'certified',
              },
            },
          },
        },
      });

      assert.equal(resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'planning'), 'codex');
      assert.equal(resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'review'), 'codex');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('blocks native resolution when the model capability does not allow the mapped provider', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-provider-mismatch-'));

    try {
      writeRepoConfig(repoDir, {
        nativeAgent: {
          enabled: true,
          allowedPhases: ['planning'],
          providers: {
            openrouter: {
              apiKeyEnv: 'OPENROUTER_API_KEY',
            },
          },
        },
        modelRegistry: {
          models: {
            'qwen-3-coder': {
              nativeCapability: {
                nativeProvider: 'openrouter',
                piTransportKind: 'openai-completions',
                readOnlyNative: 'certified',
                compatFlags: {
                  thinkingFormat: 'openrouter',
                },
              },
            },
          },
        },
      });

      assert.equal(
        resolveAgent('qwen-3-coder', { 'qwen-3-coder': 'native-openai' }, 'codex', repoDir, 'planning'),
        'codex',
      );
      assert.equal(
        resolveAgent('qwen-3-coder', { 'qwen-3-coder': 'native-openrouter' }, 'codex', repoDir, 'planning'),
        'native-openrouter',
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('computes success rate with the shared eval success policy', () => {
    const stats = aggregateEvalHistory([
      {
        id: 'eval-1',
        schemaVersion: '1.15.0',
        originalPrompt: 'Fix a bug in routing',
        modelId: 'gpt-5.4',
        modelVersion: 'gpt-5.4',
        score: 0.8,
        scoreBand: 'Minor Feedback',
        timeSeconds: 10,
        timestamp: '2026-05-01T00:00:00.000Z',
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'good',
      },
      {
        id: 'eval-2',
        schemaVersion: '1.15.0',
        originalPrompt: 'Fix a bug in routing',
        modelId: 'gpt-5.4',
        modelVersion: 'gpt-5.4',
        score: 0.7,
        scoreBand: 'Assisted Success',
        timeSeconds: 12,
        timestamp: '2026-05-01T00:01:00.000Z',
        interventionRequired: true,
        interventionCount: 1,
        interventionDetails: [],
        rationale: 'below threshold',
      },
    ], 'bugfix');

    assert.equal(stats[0]?.successRate, 0.5);
  });

  it('loads global aggregated evals when per-repo aggregated file is missing', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-global-fallback-'));
    const globalAggregatedPath = join(repoDir, 'global-aggregated.jsonl');
    const previousOverride = process.env.WAVEMILL_AGGREGATED_EVALS_PATH;
    const previousCwd = process.cwd();

    try {
      mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
      writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), '', 'utf-8');
      writeFileSync(
        globalAggregatedPath,
        [
          JSON.stringify({
            id: 'global-1',
            schemaVersion: '1.15.0',
            originalPrompt: 'Fix router bug',
            modelId: 'gpt-5.4',
            modelVersion: 'gpt-5.4',
            score: 0.95,
            scoreBand: 'Strong',
            timeSeconds: 20,
            timestamp: '2026-05-01T00:00:00.000Z',
            interventionRequired: false,
            interventionCount: 0,
            interventionDetails: [],
            rationale: 'strong',
          }),
          JSON.stringify({
            id: 'global-2',
            schemaVersion: '1.15.0',
            originalPrompt: 'Fix router bug',
            modelId: 'claude-sonnet-4-6',
            modelVersion: 'claude-sonnet-4-6',
            score: 0.85,
            scoreBand: 'Strong',
            timeSeconds: 18,
            timestamp: '2026-05-01T00:01:00.000Z',
            interventionRequired: false,
            interventionCount: 0,
            interventionDetails: [],
            rationale: 'solid',
          }),
        ].join('\n') + '\n',
        'utf-8',
      );

      process.env.WAVEMILL_AGGREGATED_EVALS_PATH = globalAggregatedPath;
      process.chdir(repoDir);
      const recommendation = recommendModel('Fix a routing bug', {
        mode: 'heuristic',
        repoDir,
        minRecords: 2,
        minModels: 2,
      });

      assert.equal(recommendation.insufficientData, false);
      assert.equal(recommendation.recommendedModel, 'gpt-5.4');
      assert.equal(recommendation.candidates.length, 2);
    } finally {
      if (previousOverride === undefined) {
        delete process.env.WAVEMILL_AGGREGATED_EVALS_PATH;
      } else {
        process.env.WAVEMILL_AGGREGATED_EVALS_PATH = previousOverride;
      }
      process.chdir(previousCwd);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
