import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { diagnoseOpenRouter } from './openrouter-doctor.ts';
import { renderZeroTrafficAlert } from './openrouter-zero-traffic.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  buildCertificationPath,
  resolveCertificationStorageIdentity,
} from './native-agent/certification/index.ts';

const OPENROUTER_CERTIFICATION_SUITE_VERSION = 'v2';

function makeRepoDir(): string {
  return mkdtempSync(join(tmpdir(), 'openrouter-zero-traffic-'));
}

function cleanup(repoDir: string): void {
  clearConfigCache();
  rmSync(repoDir, { recursive: true, force: true });
}

function writeConfig(repoDir: string): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
        models: ['glm-5.2'],
        stages: ['planner', 'coder', 'reviewer'],
      },
    },
    nativeAgent: {
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'TEST_OPENROUTER_KEY',
          models: ['z-ai/glm-5.2'],
        },
      },
    },
    router: {
      defaultAgent: 'claude',
      models: ['claude-sonnet-5', 'glm-5.2'],
      availableModels: {
        planner: ['glm-5.2'],
        coder: ['glm-5.2'],
        reviewer: ['glm-5.2'],
      },
      agentMap: {
        'glm-5.2': 'claude-openrouter',
      },
    },
    challenge: {
      models: ['claude-sonnet-5', 'glm-5.2'],
    },
  }, null, 2));
  clearConfigCache();
}

function writeOpenRouterCert(repoDir: string): void {
  const path = buildCertificationPath(repoDir, 'openrouter', 'z-ai/glm-5.2', OPENROUTER_CERTIFICATION_SUITE_VERSION);
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  mkdirSync(join(repoDir, '.wavemill', 'native-agent-certifications', 'z-ai', 'glm-5.2'), { recursive: true });
  const identity = resolveCertificationStorageIdentity('openrouter', 'z-ai/glm-5.2');
  writeFileSync(path, JSON.stringify({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: identity.provider,
    model: identity.model,
    phase: 'workflow',
    suiteVersion: OPENROUTER_CERTIFICATION_SUITE_VERSION,
    certifiedAt: '2026-07-10T00:00:00.000Z',
    scenarios: [{ scenarioId: 's1', passed: true }],
  }));
}

function writeEvalRecords(repoDir: string, lines: string[]): void {
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(join(evalsDir, 'evals.jsonl'), `${lines.join('\n')}\n`);
}

function makeEval(modelId: string, timestamp: string): string {
  return JSON.stringify({
    id: `${modelId}-${timestamp}`,
    schemaVersion: '1.0.0',
    timestamp,
    modelId,
    score: 0.9,
    scoreBand: 'good',
    timeSeconds: 1,
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    originalPrompt: 'Implement feature',
    rationale: 'ok',
    routing: {
      planner: { role: 'planner', requestedSelector: 'auto', resolvedModelId: 'claude-sonnet-5', sourceLayer: 'test' },
      coder: { role: 'coder', requestedSelector: 'auto', resolvedModelId: modelId, sourceLayer: 'test' },
      reviewer: { role: 'reviewer', requestedSelector: 'auto', resolvedModelId: 'claude-sonnet-5', sourceLayer: 'test' },
    },
  });
}

function withEnv<T>(fn: () => T): T {
  const previous = process.env.TEST_OPENROUTER_KEY;
  process.env.TEST_OPENROUTER_KEY = 'sk-test';
  delete process.env.OPENROUTER_DIRECT_AGENTS_ENABLED;
  try {
    return fn();
  } finally {
    if (typeof previous === 'undefined') {
      delete process.env.TEST_OPENROUTER_KEY;
    } else {
      process.env.TEST_OPENROUTER_KEY = previous;
    }
  }
}

describe('openrouter-zero-traffic', () => {
  it('returns an alert when recent selections use only Claude/Codex', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeOpenRouterCert(repoDir);
      writeEvalRecords(repoDir, [
        makeEval('claude-sonnet-5', '2026-07-11T00:00:00.000Z'),
        makeEval('gpt-5.4', '2026-07-10T00:00:00.000Z'),
      ]);
      const report = withEnv(() => diagnoseOpenRouter({ repoDir, lookback: 5 }));
      assert.ok(report.zeroTrafficAlert);
      assert.match(report.zeroTrafficAlert?.headline ?? '', /last 5 recent selections used no OpenRouter\/native model/);
    } finally {
      cleanup(repoDir);
    }
  });

  it('returns null when an OpenRouter model appears inside the lookback window', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeOpenRouterCert(repoDir);
      writeEvalRecords(repoDir, [
        makeEval('glm-5.2', '2026-07-11T00:00:00.000Z'),
        makeEval('claude-sonnet-5', '2026-07-10T00:00:00.000Z'),
      ]);
      const report = withEnv(() => diagnoseOpenRouter({ repoDir, lookback: 5 }));
      assert.equal(report.zeroTrafficAlert, null);
    } finally {
      cleanup(repoDir);
    }
  });

  it('skips malformed JSONL lines without throwing', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeOpenRouterCert(repoDir);
      writeEvalRecords(repoDir, [
        '{"bad":',
        makeEval('claude-sonnet-5', '2026-07-11T00:00:00.000Z'),
      ]);
      assert.doesNotThrow(() => withEnv(() => diagnoseOpenRouter({ repoDir, lookback: 5 })));
    } finally {
      cleanup(repoDir);
    }
  });

  it('distinguishes zero eligible candidates from eligible-but-unselected ones', () => {
    const blockedRepo = makeRepoDir();
    const eligibleRepo = makeRepoDir();
    try {
      writeConfig(blockedRepo);
      writeEvalRecords(blockedRepo, [makeEval('claude-sonnet-5', '2026-07-11T00:00:00.000Z')]);
      const blocked = diagnoseOpenRouter({ repoDir: blockedRepo, lookback: 5 });
      assert.ok(blocked.zeroTrafficAlert);
      assert.match(renderZeroTrafficAlert(blocked.zeroTrafficAlert!), /Top blocker/);

      writeConfig(eligibleRepo);
      writeOpenRouterCert(eligibleRepo);
      writeEvalRecords(eligibleRepo, [makeEval('claude-sonnet-5', '2026-07-11T00:00:00.000Z')]);
      const eligible = withEnv(() => diagnoseOpenRouter({ repoDir: eligibleRepo, lookback: 5 }));
      assert.ok(eligible.zeroTrafficAlert);
      assert.match(renderZeroTrafficAlert(eligible.zeroTrafficAlert!), /Eligible configured models: 1/);
    } finally {
      cleanup(blockedRepo);
      cleanup(eligibleRepo);
    }
  });

  it('handles missing history with an eligibility-only warning', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeOpenRouterCert(repoDir);
      const report = withEnv(() => diagnoseOpenRouter({ repoDir, lookback: 5 }));
      assert.ok(report.zeroTrafficAlert);
      assert.match(report.zeroTrafficAlert?.headline ?? '', /history is unavailable/);
    } finally {
      cleanup(repoDir);
    }
  });

  it('reports the next challenge model when an eligible OpenRouter challenger exists', () => {
    const repoDir = makeRepoDir();
    try {
      writeConfig(repoDir);
      writeOpenRouterCert(repoDir);
      writeEvalRecords(repoDir, [makeEval('claude-sonnet-5', '2026-07-11T00:00:00.000Z')]);
      const report = withEnv(() => diagnoseOpenRouter({ repoDir, lookback: 5 }));
      assert.equal(report.zeroTrafficAlert?.nextChallengeModel?.model, 'glm-5.2');
    } finally {
      cleanup(repoDir);
    }
  });
});
