import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildCertificationPath } from '../shared/lib/native-agent/certification/loader.ts';
import { resolveCertificationStorageIdentity } from '../shared/lib/native-agent/certification/identity.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  getPatchCodingCertificationPath,
} from '../shared/lib/native-agent/coding-certification.ts';
import { PATCH_CODING_SMOKE_SUITE_REVISION } from '../shared/lib/native-agent/smoke.ts';

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
  const identity = resolveCertificationStorageIdentity(provider, model);
  mkdirSync(dirname(certPath), { recursive: true });
  writeFileSync(certPath, JSON.stringify({
    schemaVersion: 2,
    provider: identity.provider,
    model: identity.model,
    phase,
    suiteVersion,
    certifiedAt: CERT_DATE_FRESH,
    scenarios: [{ scenarioId: 's1', passed: true }],
  }), 'utf-8');
}

function writePatchCodingCertification(repoDir: string) {
  const certificationPath = getPatchCodingCertificationPath(repoDir);
  mkdirSync(dirname(certificationPath), { recursive: true });
  writeFileSync(certificationPath, JSON.stringify({
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    certifiedAt: CERT_DATE_FRESH,
    providers: [
      { provider: 'openai', model: 'native-certified', passed: true },
      { provider: 'openrouter', model: 'qwen/qwen3-coder', passed: true },
    ],
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

function makeRepo(coderHistory: string[], opts: {
  patchCodingEnabled?: boolean;
  aliases?: string[];
  suiteVersion?: string;
  certificationPhase?: string;
} = {}): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'resolve-challenge-task-'));
  const aliases = opts.aliases ?? ['qwen-3-coder', 'glm-5.2'];
  const suiteVersion = opts.suiteVersion ?? 'v1';
  const certificationPhase = opts.certificationPhase ?? 'workflow';
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    challenge: {
      enabled: true,
      rate: 1,
      recommendationRate: 1,
      models: ['claude-sonnet-4-6', ...aliases],
    },
    router: {
      defaultAgent: 'claude',
      models: ['claude-sonnet-4-6', ...aliases],
      agentMap: {
        'claude-sonnet-4-6': 'claude',
        ...Object.fromEntries(aliases.map((alias) => [alias, 'codex'])),
      },
    },
    ...(opts.patchCodingEnabled
      ? { nativeAgent: { patchCoding: { enabled: true } } }
      : {}),
    modelRegistry: {
      models: Object.fromEntries(aliases.map((alias) => [
        alias,
        openRouterNativeModelEntry(certificationPhase, suiteVersion),
      ])),
    },
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_RESOLVE_OPENROUTER_KEY',
        models: aliases,
        stages: ['coder'],
      },
    },
  }), 'utf-8');
  writeFileSync(join(repoDir, '.env'), 'TEST_RESOLVE_OPENROUTER_KEY=test-key\n', 'utf-8');
  for (const alias of aliases) {
    writeCertArtifact(repoDir, 'openrouter', alias, suiteVersion, certificationPhase);
  }
  if (opts.patchCodingEnabled) {
    writePatchCodingCertification(repoDir);
  }
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
  it('falls back to single mode when implementation challengers are native-only and not launchable', () => {
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

      assert.equal(result.mode, 'single');
      assert.equal(result.reason, 'selection_failed');
      const single = result.single as Record<string, unknown>;
      assert.equal(single.model, 'claude-sonnet-4-6');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns challenge mode for HOK-2569 v2 native patch OpenRouter challengers', () => {
    const aliases = ['qwen-3-coder', 'glm-5.2', 'kimi-k2.7-code'];
    const repoDir = makeRepo([], {
      aliases,
      patchCodingEnabled: true,
      suiteVersion: 'v2',
      certificationPhase: 'patch',
    });
    try {
      const result = runResolveChallengeTask(repoDir, [
        '--issue', 'HOK-CONFIG-VERIFY',
        '--slug', 'config-verify',
        '--title', 'Configuration verification',
        '--primary-model', 'claude-sonnet-4-6',
        '--remaining-slots', '2',
        '--repo-dir', repoDir,
      ]);

      assert.equal(result.mode, 'challenge');
      assert.equal(result.slotsRequired, 2);
      assert.equal(result.challengeStage, 'implementation');
      const entries = result.entries as Array<Record<string, unknown>>;
      assert.equal(entries.length, 2);
      const challenger = entries.find((entry) => entry.role === 'challenger');
      assert.ok(challenger);
      assert.ok(aliases.includes(challenger!.model as string), 'challenger should be a configured native alias');
      assert.equal(result.nativeCertificationRejections, undefined);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps recommendation-driven implementation native challengers excluded before launch', () => {
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

      assert.equal(result.mode, 'single');
      assert.equal(result.reason, 'selection_failed');
      const single = result.single as Record<string, unknown>;
      assert.equal(single.model, 'claude-sonnet-4-6');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
