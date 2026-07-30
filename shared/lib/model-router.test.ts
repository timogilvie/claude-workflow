import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { aggregateEvalHistory, recommendModel, resolveAgent, tryResolveAgent } from './model-router.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  buildGlobalCertificationPath,
  resolveCertificationStorageIdentity,
} from './native-agent/certification/index.ts';

function writeRepoConfig(repoDir: string, config: unknown): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
}

function useGlobalCertificationRoot(repoDir: string): void {
  process.env.WAVEMILL_NATIVE_CERTIFICATION_ROOT = join(repoDir, 'global-certifications');
}

function writeGlobalCertification(repoDir: string, provider: string, model: string): void {
  useGlobalCertificationRoot(repoDir);
  const path = buildGlobalCertificationPath(provider, model, DEFAULT_CERTIFICATION_SUITE_VERSION);
  mkdirSync(dirname(path), { recursive: true });
  const identity = resolveCertificationStorageIdentity(provider, model);
  writeFileSync(path, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: identity.provider,
    model: identity.model,
    phase: 'workflow',
    suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
    certifiedAt: '2026-07-10T00:00:00.000Z',
    scenarios: [{ scenarioId: 's1', passed: true }],
  }));
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

  it('does not allow repo-local metadata to restore a retired Codex model', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-openai-'));

    try {
      writeRepoConfig(repoDir, {
        modelRegistry: { models: { 'gpt-5.4': { agent: 'native-openai' } } },
      });

      assert.throws(
        () => resolveAgent('gpt-5.4', {}, 'codex', repoDir, 'planning'),
        /agent-resolution.*gpt-5\.4.*codex-chatgpt-ineligible/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps global Codex routing authoritative despite a global certification', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-default-off-'));

    try {
      writeGlobalCertification(repoDir, 'openai', 'gpt-5.6-terra');

      assert.equal(resolveAgent('gpt-5.6-terra', {}, 'codex', repoDir, 'planning'), 'codex');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('resolves a globally certified native OpenRouter model', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'model-router-native-provider-mismatch-'));

    try {
      writeGlobalCertification(repoDir, 'openrouter', 'z-ai/glm-5.2');

      assert.equal(
        resolveAgent('glm-5.2', {}, 'codex', repoDir, 'planning'),
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
