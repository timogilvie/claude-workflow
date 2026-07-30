import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { aggregateEvalHistory, recommendModel, resolveAgent, tryResolveAgent } from './model-router.ts';

function writeRepoConfig(repoDir: string, config: unknown): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
}

describe('model-router resolveAgent', () => {
  it('routes known DeepSeek models to claude', () => {
    assert.equal(resolveAgent('deepseek-v4-pro', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('deepseek-v4-flash', {}, 'codex'), 'claude');
  });

  it('throws for unknown DeepSeek-like models instead of falling back', () => {
    assert.throws(
      () => resolveAgent('deepseek-v4-ultra', {}, 'claude'),
      /Unknown DeepSeek model "deepseek-v4-ultra"/,
    );
  });

  it('resolves hosted claude and gpt models from registry-backed metadata', () => {
    assert.equal(resolveAgent('claude-sonnet-4-6', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('gpt-5.6-terra', {}, 'claude'), 'codex');
  });

  it('throws instead of routing unsupported native OpenAI aliases through codex fallback', () => {
    assert.throws(
      () => resolveAgent('gpt-5.6-sol', {}, 'codex', undefined, 'planning'),
      /agent-resolution.*gpt-5\.6-sol.*no-native-capability/,
    );
  });

  it('returns structured rejection details from tryResolveAgent', () => {
    const result = tryResolveAgent('gpt-5.6-sol', {}, 'codex', undefined, 'planning');
    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail('expected gpt-5.6-sol planning resolution to fail');
    }
    assert.equal(result.reason, 'no-native-capability');
    assert.match(result.diagnostic, /provider=openai/);
  });

  it('resolves native-openai when registry metadata is phase-certified', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-openai-'));

    try {
      writeRepoConfig(repoDir, {
        modelRegistry: {
          models: {
            'gpt-5.4': {
              agent: 'native-openai',
              nativeCapability: {
                nativeProvider: 'openai',
                piTransportKind: 'openai-responses',
                readOnlyNative: 'certified',
                certification: {
                  maxCertifiedPhase: 'workflow',
                  certifiedAt: '2099-01-01T00:00:00.000Z',
                  certificationSuiteVersion: 'v1',
                },
              },
            },
          },
        },
      });

      assert.equal(resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'planning'), 'native-openai');
      assert.equal(resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'review'), 'native-openai');
      assert.equal(resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'coding'), 'native-openai');
      assert.equal(resolveAgent('gpt-5.4', {}, 'codex', repoDir), 'native-openai');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects native-openai when certification metadata is missing', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-default-off-'));

    try {
      writeRepoConfig(repoDir, {
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

      assert.throws(
        () => resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'planning'),
        /agent-resolution.*gpt-5.4.*uncertified/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('blocks native resolution when the model capability does not allow the mapped provider', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-provider-mismatch-'));

    try {
      writeRepoConfig(repoDir, {
        modelRegistry: {
          models: {
            'qwen-3-coder': {
              agent: 'claude-openrouter',
              nativeCapability: {
                nativeProvider: 'openrouter',
                piTransportKind: 'openai-completions',
                readOnlyNative: 'certified',
                compatFlags: {
                  thinkingFormat: 'openrouter',
                },
                certification: {
                  maxCertifiedPhase: 'workflow',
                  certifiedAt: '2099-01-01T00:00:00.000Z',
                  certificationSuiteVersion: 'v1',
                },
              },
            },
          },
        },
      });

      assert.throws(
        () => resolveAgent('qwen-3-coder', { 'qwen-3-coder': 'native-openai' }, 'codex', repoDir, 'planning'),
        /provider-mismatch:openrouter->openai/,
      );
      assert.throws(
        () => resolveAgent('qwen-3-coder', { 'qwen-3-coder': 'native-openrouter' }, 'codex', repoDir, 'planning'),
        /reason=role-ineligible/,
      );
      assert.equal(
        resolveAgent('qwen-3-coder', { 'qwen-3-coder': 'native-openrouter' }, 'codex', repoDir, 'review'),
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
            modelId: 'gpt-5.6-terra',
            modelVersion: 'gpt-5.6-terra',
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
      assert.equal(recommendation.recommendedModel, 'gpt-5.6-terra');
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
