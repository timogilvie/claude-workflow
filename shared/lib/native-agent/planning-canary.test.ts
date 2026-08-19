import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { clearConfigCache } from '../config.ts';
import {
  buildGlobalCertificationPath,
  GLOBAL_CERTIFICATION_ROOT_ENV,
} from './certification/index.ts';
import { buildPlanningGateAgreement, type PlanningCanaryPreflightResult } from './planning-canary.ts';

const repos: string[] = [];

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'planning-canary-'));
  repos.push(repoDir);
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    providers: {
      openrouter: {
        enabled: true,
        apiKeyEnv: 'TEST_OPENROUTER_KEY',
      },
    },
    nativeAgent: {
      enabled: true,
      allowedPhases: ['planning', 'review'],
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'TEST_OPENROUTER_KEY',
        },
      },
    },
  }, null, 2));
  clearConfigCache(repoDir);
  return repoDir;
}

function writeQwenArtifact(phase: 'patch' | 'workflow'): void {
  const path = buildGlobalCertificationPath('qwen', 'qwen3-coder', 'v2');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: 2,
    provider: 'qwen',
    model: 'qwen3-coder',
    phase,
    suiteVersion: 'v2',
    certifiedAt: '2099-01-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 's1', passed: true }],
  }, null, 2));
}

function preflight(result: PlanningCanaryPreflightResult) {
  return () => result;
}

afterEach(() => {
  delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  delete process.env.TEST_OPENROUTER_KEY;
  for (const repoDir of repos.splice(0)) {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

describe('planning canary gate agreement', () => {
  it('reports all surfaces eligible for qwen-3-coder with workflow certification', () => {
    const repoDir = makeRepo();
    writeQwenArtifact('workflow');
    process.env.TEST_OPENROUTER_KEY = 'sk-test';

    const agreement = buildPlanningGateAgreement({
      modelId: 'qwen-3-coder',
      repoDir,
      apiKeyEnv: 'TEST_OPENROUTER_KEY',
      apiKeyPresent: true,
      now: new Date('2098-01-01T00:00:00.000Z'),
      preflight: preflight({ ok: true, launcher: 'native-planning' }),
    });

    assert.equal(agreement.agree, true);
    assert.equal(agreement.eligible, true);
    assert.deepEqual(agreement.rows.map((row) => [row.surface, row.eligible]), [
      ['preflight', true],
      ['router', true],
      ['projection', true],
      ['challenge', true],
    ]);
  });

  it('reports all surfaces rejected for missing qwen-3-coder certification', () => {
    const repoDir = makeRepo();

    const agreement = buildPlanningGateAgreement({
      modelId: 'qwen/qwen3-coder',
      repoDir,
      apiKeyEnv: 'TEST_OPENROUTER_KEY',
      apiKeyPresent: true,
      now: new Date('2098-01-01T00:00:00.000Z'),
      preflight: preflight({ ok: false, code: 'missing_artifact', reason: 'missing_artifact' }),
    });

    assert.equal(agreement.agree, true);
    assert.equal(agreement.eligible, false);
    assert.ok(agreement.rows.every((row) => row.eligible === false));
    assert.equal(agreement.rows.find((row) => row.surface === 'router')?.reason, 'missing-artifact');
    assert.equal(agreement.rows.find((row) => row.surface === 'projection')?.reason, 'missing_artifact');
  });

  it('reports all surfaces rejected for patch-only qwen-3-coder certification', () => {
    const repoDir = makeRepo();
    writeQwenArtifact('patch');

    const agreement = buildPlanningGateAgreement({
      modelId: 'qwen-3-coder',
      repoDir,
      apiKeyEnv: 'TEST_OPENROUTER_KEY',
      apiKeyPresent: true,
      now: new Date('2098-01-01T00:00:00.000Z'),
      preflight: preflight({ ok: false, code: 'insufficient_phase', reason: 'insufficient_phase' }),
    });

    assert.equal(agreement.agree, true);
    assert.equal(agreement.eligible, false);
    assert.ok(agreement.rows.every((row) => row.eligible === false));
    assert.equal(agreement.rows.find((row) => row.surface === 'router')?.reason, 'insufficient-phase');
    assert.equal(agreement.rows.find((row) => row.surface === 'projection')?.reason, 'insufficient_phase');
  });
});
