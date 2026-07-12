import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildCertificationPath } from '../shared/lib/native-agent/certification/loader.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resolveChallengeTaskTool = resolve(__dirname, 'resolve-challenge-task.ts');
const CERT_DATE_FRESH = '2026-06-20T00:00:00.000Z';

function openRouterNativeModelEntry(phase: string = 'workflow', suiteVersion: string = 'v1') {
  return {
    class: 'strong_generalist',
    agent: 'claude-openrouter',
    nativeCapability: {
      nativeProvider: 'openrouter',
      piTransportKind: 'openai-completions',
      readOnlyNative: 'certified',
      compatFlags: { thinkingFormat: 'openrouter' },
      certification: {
        maxCertifiedPhase: phase,
        certifiedAt: CERT_DATE_FRESH,
        certificationSuiteVersion: suiteVersion,
      },
    },
  };
}

function writeCertArtifact(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  phase: string = 'workflow',
) {
  const certPath = buildCertificationPath(repoDir, provider, model, suiteVersion);
  mkdirSync(dirname(certPath), { recursive: true });
  writeFileSync(certPath, JSON.stringify({
    schemaVersion: 2,
    provider,
    model,
    phase,
    suiteVersion,
    certifiedAt: CERT_DATE_FRESH,
    scenarios: [{ scenarioId: 's1', passed: true }],
  }), 'utf-8');
}

function makeEvalRecord(id: string, coder: string) {
  return {
    id,
    schemaVersion: '1.0.0',
    originalPrompt: `Test prompt ${id}`,
    modelId: coder,
    modelVersion: coder,
    score: 0.9,
    scoreBand: 'good',
    timeSeconds: 60,
    timestamp: `2026-04-${String(Number(id) + 10).padStart(2, '0')}T00:00:00.000Z`,
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    metadata: {
      stageScores: {
        plan: { score: 0.9, rationale: 'ok' },
        implementation: { score: 0.9, rationale: 'ok' },
        review: { score: 0.9, rationale: 'ok' },
      },
    },
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 2,
          repo_size_loc: 1000,
          description_tokens: 50,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
        learned: {
          complexity: 2,
          domain: 'backend',
          risk_flags: [],
        },
      },
      constraints: {
        models_available: [],
        objective: 'balanced',
      },
      stages: {
        planner: { model: 'claude-sonnet-4-6', cost_usd: 0.2 },
        coder: { model: coder, cost_usd: 0.4 },
        reviewer: { model: 'claude-sonnet-4-6', cost_usd: 0.2 },
      },
    },
  };
}

function makeRepo(coderHistory: string[]): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'resolve-challenge-task-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    challenge: {
      enabled: true,
      rate: 1,
      recommendationRate: 1,
      models: ['claude-sonnet-4-6', 'qwen-3-coder', 'glm-5.2'],
    },
    router: {
      defaultAgent: 'claude',
      models: ['claude-sonnet-4-6', 'qwen-3-coder', 'glm-5.2'],
      agentMap: {
        'claude-sonnet-4-6': 'claude',
        'qwen-3-coder': 'codex',
        'glm-5.2': 'codex',
      },
    },
    modelRegistry: {
      models: {
        'qwen-3-coder': openRouterNativeModelEntry(),
        'glm-5.2': openRouterNativeModelEntry(),
      },
    },
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_RESOLVE_OPENROUTER_KEY',
        models: ['qwen-3-coder', 'glm-5.2'],
        stages: ['coder'],
      },
    },
  }), 'utf-8');
  writeFileSync(join(repoDir, '.env'), 'TEST_RESOLVE_OPENROUTER_KEY=test-key\n', 'utf-8');
  writeCertArtifact(repoDir, 'openrouter', 'qwen-3-coder', 'v1');
  writeCertArtifact(repoDir, 'openrouter', 'glm-5.2', 'v1');
  writeFileSync(
    join(repoDir, '.wavemill', 'evals', 'evals.jsonl'),
    `${coderHistory.map((coder, index) => JSON.stringify(makeEvalRecord(String(index + 1), coder))).join('\n')}\n`,
    'utf-8',
  );
  return repoDir;
}

function runResolveChallengeTask(repoDir: string, args: string[]): Record<string, unknown> {
  const stdout = execFileSync('npx', ['tsx', resolveChallengeTaskTool, ...args], {
    encoding: 'utf-8',
    cwd: resolve(__dirname, '..'),
    env: { ...process.env },
  });
  return JSON.parse(stdout);
}

describe('resolve-challenge-task CLI', () => {
  it('emits the least-used zero-record challenger reason and coverage count', () => {
    const repoDir = makeRepo(['glm-5.2']);
    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-2500-A',
        '--slug', 'least-used-zero-record',
        '--title', 'Route least-used challenge task',
        '--primary-model', 'claude-sonnet-4-6',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
      ]);

      assert.equal(result.mode, 'challenge');
      assert.equal(result.challengeStage, 'implementation');
      assert.equal(result.challengerSource, 'least-used-zero-record');
      assert.equal(result.selectionReason, 'least-used-zero-record');
      assert.equal(result.coverageCount, 0);

      const entries = result.entries as Array<Record<string, unknown>>;
      assert.equal(entries[1].model, 'qwen-3-coder');
      assert.equal(entries[1].variedModel, 'qwen-3-coder');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('falls forward from a recommended challenger to the next least-used eligible model', () => {
    const repoDir = makeRepo(['qwen-3-coder', 'qwen-3-coder', 'glm-5.2', 'glm-5.2', 'glm-5.2']);
    const featureDir = join(repoDir, 'features', 'fallforward');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
      coder: 'claude-sonnet-4-6',
      reviewer: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      reviewMode: 'llm',
      challengeRecommendation: {
        shouldChallenge: true,
        reason: 'new-model',
        challengerModel: 'glm-5.2',
        priority: 200,
      },
    }), 'utf-8');

    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-2500-B',
        '--slug', 'least-used-fallforward',
        '--title', 'Route recommendation fallforward task',
        '--primary-model', 'claude-sonnet-4-6',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
        '--feature-dir', featureDir,
      ]);

      assert.equal(result.mode, 'challenge');
      assert.equal(result.selectionPath, 'recommendation-driven');
      assert.equal(result.challengerSource, 'least-used-fallforward');
      assert.equal(result.selectionReason, 'least-used-fallforward');
      assert.equal(result.coverageCount, 2);

      const entries = result.entries as Array<Record<string, unknown>>;
      assert.equal(entries[1].model, 'qwen-3-coder');
      const challengeRecommendation = result.challengeRecommendation as Record<string, unknown>;
      assert.equal(challengeRecommendation.challengerModel, 'glm-5.2');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
