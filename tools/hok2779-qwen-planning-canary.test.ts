import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { GLOBAL_CERTIFICATION_ROOT_ENV, buildGlobalCertificationPath } from '../shared/lib/native-agent/certification/index.ts';
import { clearConfigCache } from '../shared/lib/config.ts';
import { runHok2779QwenPlanningCanary } from './hok2779-qwen-planning-canary.ts';

const repos: string[] = [];
const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
const previousKey = process.env.OPENROUTER_API_KEY;

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'hok2779-canary-'));
  repos.push(repoDir);
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certs');
  process.env.OPENROUTER_API_KEY = 'sk-test';
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    providers: {
      openrouter: { enabled: true, apiKeyEnv: 'OPENROUTER_API_KEY' },
    },
    nativeAgent: {
      enabled: true,
      allowedPhases: ['planning', 'coding', 'review'],
      providers: { openrouter: { enabled: true, apiKeyEnv: 'OPENROUTER_API_KEY' } },
    },
  }), 'utf-8');
  clearConfigCache(repoDir);
  return repoDir;
}

function writeQwenWorkflowCert(): void {
  const path = buildGlobalCertificationPath('qwen', 'qwen3-coder', 'v2');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: 2,
    provider: 'qwen',
    model: 'qwen3-coder',
    phase: 'workflow',
    suiteVersion: 'v2',
    certifiedAt: '2099-01-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 's1', passed: true }],
  }, null, 2), 'utf-8');
}

afterEach(() => {
  if (previousRoot === undefined) delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  else process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
  if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = previousKey;
  for (const repoDir of repos.splice(0)) {
    clearConfigCache(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

describe('HOK-2779 qwen planning canary', () => {
  it('writes dry-run evidence without launching a model', async () => {
    const repoDir = makeRepo();
    writeQwenWorkflowCert();
    const evidenceJsonPath = join(repoDir, 'evidence.json');
    const evidenceMarkdownPath = join(repoDir, 'evidence.md');

    const evidence = await runHok2779QwenPlanningCanary({
      repoDir,
      dryRun: true,
      evidenceJsonPath,
      evidenceMarkdownPath,
    });

    assert.equal(evidence.gates.gateOk, true, JSON.stringify(evidence.gates));
    assert.equal(evidence.dryRun, true);
    assert.equal(evidence.launch, null);
    assert.match(JSON.parse(readFileSync(evidenceJsonPath, 'utf-8')).model.alias, /qwen-3-coder/);
    assert.match(readFileSync(evidenceMarkdownPath, 'utf-8'), /No secrets were printed/);
  });
});
