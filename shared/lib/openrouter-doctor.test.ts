import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  diagnoseOpenRouter,
  formatZeroTrafficWarning,
  type OpenRouterDoctorReport,
} from './openrouter-doctor.ts';
import { clearConfigCache } from './config.ts';
import { clearChallengeSchedulerCache } from './challenge-scheduler.ts';
import { writeCertification } from './native-agent/certification/store.ts';
import { buildCertificationPath } from './native-agent/certification/loader.ts';
import type { NativeCertificationArtifact } from './native-agent/certification/schema.ts';

const TEST_NOW = new Date('2026-07-01T00:00:00.000Z');
const FRESH_CERTIFIED_AT = '2026-06-20T00:00:00.000Z';
const STALE_CERTIFIED_AT = '2026-01-01T00:00:00.000Z';

function makeRepo(config: Record<string, unknown>, env: Record<string, string> = {}): string {
  const repoDir = join(tmpdir(), `openrouter-doctor-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2));
  if (Object.keys(env).length > 0) {
    writeFileSync(
      join(repoDir, '.env'),
      `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    );
  }
  clearConfigCache(repoDir);
  clearChallengeSchedulerCache(repoDir);
  return repoDir;
}

function cleanupRepo(repoDir: string): void {
  clearConfigCache(repoDir);
  clearChallengeSchedulerCache(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
}

function baseConfig(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: [model],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
    router: {
      availableModels: {
        planner: [model],
        coder: [model],
        reviewer: [model],
      },
    },
    challenge: {
      models: [model],
    },
    ...extra,
  };
}

function writeEvalRecords(repoDir: string, lines: string[]): void {
  writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`);
  clearChallengeSchedulerCache(repoDir);
}

function writeOpenRouterCertification(
  repoDir: string,
  model: string,
  overrides: Partial<NativeCertificationArtifact> = {},
): void {
  writeCertification(repoDir, {
    schemaVersion: 2,
    provider: 'openrouter',
    model,
    phase: 'workflow',
    suiteVersion: 'v1',
    certifiedAt: FRESH_CERTIFIED_AT,
    scenarios: [{ scenarioId: 'smoke', passed: true }],
    ...overrides,
  } as NativeCertificationArtifact);
}

test('diagnoseOpenRouter reports missing_api_key for every configured stage', () => {
  const repoDir = makeRepo(baseConfig('qwen-3-coder'));
  try {
    const report = diagnoseOpenRouter({ repoDir, now: TEST_NOW });
    const model = report.models.find((entry) => entry.identity.wavemillAlias === 'qwen-3-coder');
    assert.ok(model, 'expected qwen-3-coder in doctor output');
    assert.equal(model.stages.planner.primaryReason, 'missing_api_key');
    assert.equal(model.stages.coder.primaryReason, 'missing_api_key');
    assert.equal(model.stages.reviewer.primaryReason, 'missing_api_key');
  } finally {
    cleanupRepo(repoDir);
  }
});

test('diagnoseOpenRouter reports direct_agents_disabled for aliases without a native path', () => {
  const repoDir = makeRepo(
    baseConfig('qwen-2.5-coder-32b'),
    { OPENROUTER_API_KEY: 'sk-test' },
  );
  try {
    const report = diagnoseOpenRouter({ repoDir, now: TEST_NOW });
    const model = report.models.find((entry) => entry.identity.wavemillAlias === 'qwen-2.5-coder-32b');
    assert.ok(model, 'expected qwen-2.5-coder-32b in doctor output');
    assert.equal(model.stages.coder.primaryReason, 'direct_agents_disabled');
  } finally {
    cleanupRepo(repoDir);
  }
});

test('diagnoseOpenRouter reports agent_resolution_failed when a non-OpenAI OpenRouter alias maps to codex', () => {
  const repoDir = makeRepo(
    baseConfig('qwen-3-coder', {
      router: {
        availableModels: {
          planner: ['qwen-3-coder'],
          coder: ['qwen-3-coder'],
          reviewer: ['qwen-3-coder'],
        },
        agentMap: {
          'qwen-3-coder': 'codex',
        },
      },
    }),
    { OPENROUTER_API_KEY: 'sk-test' },
  );
  try {
    writeOpenRouterCertification(repoDir, 'qwen-3-coder');
    const report = diagnoseOpenRouter({ repoDir, now: TEST_NOW });
    const model = report.models.find((entry) => entry.identity.wavemillAlias === 'qwen-3-coder');
    assert.ok(model, 'expected qwen-3-coder in doctor output');
    assert.equal(model.stages.coder.primaryReason, 'agent_resolution_failed');
    assert.match(model.stages.coder.failedGates[0]?.configSurface ?? '', /router\.agentMap\.qwen-3-coder/);
  } finally {
    cleanupRepo(repoDir);
  }
});

test('diagnoseOpenRouter distinguishes native certification rejection reasons', async (t) => {
  await t.test('missing artifact => certification_missing', () => {
    const repoDir = makeRepo(baseConfig('qwen-3-coder'), { OPENROUTER_API_KEY: 'sk-test' });
    try {
      const report = diagnoseOpenRouter({ repoDir, now: TEST_NOW });
      const model = report.models.find((entry) => entry.identity.wavemillAlias === 'qwen-3-coder');
      assert.ok(model);
      assert.equal(model.stages.coder.primaryReason, 'certification_missing');
    } finally {
      cleanupRepo(repoDir);
    }
  });

  await t.test('stale artifact => certification_stale', () => {
    const repoDir = makeRepo(baseConfig('qwen-3-coder'), { OPENROUTER_API_KEY: 'sk-test' });
    try {
      writeOpenRouterCertification(repoDir, 'qwen-3-coder', { certifiedAt: STALE_CERTIFIED_AT });
      const report = diagnoseOpenRouter({ repoDir, now: TEST_NOW });
      const model = report.models.find((entry) => entry.identity.wavemillAlias === 'qwen-3-coder');
      assert.ok(model);
      assert.equal(model.stages.coder.primaryReason, 'certification_stale');
    } finally {
      cleanupRepo(repoDir);
    }
  });

  await t.test('wrong suite artifact => certification_wrong_suite', () => {
    const repoDir = makeRepo(baseConfig('qwen-3-coder'), { OPENROUTER_API_KEY: 'sk-test' });
    try {
      const path = buildCertificationPath(repoDir, 'openrouter', 'qwen-3-coder', 'v1');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        schemaVersion: 2,
        provider: 'openrouter',
        model: 'qwen-3-coder',
        phase: 'workflow',
        suiteVersion: 'v2',
        certifiedAt: FRESH_CERTIFIED_AT,
        scenarios: [{ scenarioId: 'smoke', passed: true }],
      }));
      const report = diagnoseOpenRouter({ repoDir, now: TEST_NOW });
      const model = report.models.find((entry) => entry.identity.wavemillAlias === 'qwen-3-coder');
      assert.ok(model);
      assert.equal(model.stages.coder.primaryReason, 'certification_wrong_suite');
    } finally {
      cleanupRepo(repoDir);
    }
  });

  await t.test('malformed artifact => certification_malformed', () => {
    const repoDir = makeRepo(baseConfig('qwen-3-coder'), { OPENROUTER_API_KEY: 'sk-test' });
    try {
      const path = buildCertificationPath(repoDir, 'openrouter', 'qwen-3-coder', 'v1');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{not json}\n');
      const report = diagnoseOpenRouter({ repoDir, now: TEST_NOW });
      const model = report.models.find((entry) => entry.identity.wavemillAlias === 'qwen-3-coder');
      assert.ok(model);
      assert.equal(model.stages.coder.primaryReason, 'certification_malformed');
    } finally {
      cleanupRepo(repoDir);
    }
  });

  await t.test('phase-insufficient artifact => certification_insufficient_phase', () => {
    const repoDir = makeRepo(baseConfig('qwen-3-coder'), { OPENROUTER_API_KEY: 'sk-test' });
    try {
      writeOpenRouterCertification(repoDir, 'qwen-3-coder', { phase: 'patch' });
      const report = diagnoseOpenRouter({ repoDir, now: TEST_NOW });
      const model = report.models.find((entry) => entry.identity.wavemillAlias === 'qwen-3-coder');
      assert.ok(model);
      assert.equal(model.stages.planner.primaryReason, 'certification_insufficient_phase');
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

test('formatZeroTrafficWarning renders a concise one-line warning and suppresses intentional/provider-off cases', () => {
  const minimalReport = {
    repoDir: '/repo',
    operatingMode: 'normal',
    providerConfigured: true,
    providerEnabled: true,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    apiKeyPresent: true,
    models: [],
    zeroTrafficCells: [],
    nextChallengeModel: null,
    recentTraffic: { window: 20, usableRecords: 10, openRouterRecords: 0, sampledModels: [] },
    notes: [],
  } as Omit<OpenRouterDoctorReport, 'alerts'>;

  const warning = formatZeroTrafficWarning({
    ...minimalReport,
    alerts: [{
      code: 'no_eligible_openrouter_candidates',
      message: 'blocked',
      dominantReason: 'missing_api_key',
    }],
  });
  assert.ok(warning);
  assert.match(warning, /wavemill doctor openrouter/);
  assert.doesNotMatch(warning, /\n/);

  assert.equal(formatZeroTrafficWarning({
    ...minimalReport,
    providerEnabled: false,
    alerts: [{
      code: 'no_eligible_openrouter_candidates',
      message: 'blocked',
      dominantReason: 'missing_api_key',
    }],
  }), null);

  assert.equal(formatZeroTrafficWarning({
    ...minimalReport,
    alerts: [],
  }), null);
});

test('diagnoseOpenRouter alerts when recent usable traffic used only Claude/Codex and ignores undersized samples', () => {
  const repoDir = makeRepo(baseConfig('qwen-3-coder'), { OPENROUTER_API_KEY: 'sk-test' });
  try {
    writeOpenRouterCertification(repoDir, 'qwen-3-coder');
    writeEvalRecords(repoDir, [
      '{bad json',
      JSON.stringify({ id: '1', modelId: 'claude-sonnet-4-6' }),
      JSON.stringify({ id: '2', modelId: 'gpt-5.4' }),
      JSON.stringify({ id: '3', modelId: 'claude-sonnet-4-6' }),
      JSON.stringify({ id: '4', modelId: 'gpt-5.4' }),
      JSON.stringify({ id: '5', modelId: 'claude-sonnet-4-6' }),
      JSON.stringify({ id: 'ignored' }),
    ]);

    const report = diagnoseOpenRouter({ repoDir, now: TEST_NOW, recentWindow: 20 });
    assert.ok(report.alerts.some((alert) => alert.code === 'zero_openrouter_recent_traffic'));

    writeEvalRecords(repoDir, [
      JSON.stringify({ id: '1', modelId: 'claude-sonnet-4-6' }),
      JSON.stringify({ id: '2', modelId: 'gpt-5.4' }),
      JSON.stringify({ id: '3', modelId: 'claude-sonnet-4-6' }),
      '{bad json',
    ]);

    const undersized = diagnoseOpenRouter({ repoDir, now: TEST_NOW, recentWindow: 20 });
    assert.ok(!undersized.alerts.some((alert) => alert.code === 'zero_openrouter_recent_traffic'));
  } finally {
    cleanupRepo(repoDir);
  }
});
