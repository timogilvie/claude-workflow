import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { migrateModelSettings } from '../shared/lib/model-settings-migrator.ts';
import { loadWavemillConfig, clearConfigCache } from '../shared/lib/config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'wavemill-config.schema.json');

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'model-settings-migration-'));
  writeFileSync(join(repoDir, 'wavemill-config.schema.json'), readFileSync(SCHEMA_PATH, 'utf-8'));
  return repoDir;
}

function cleanup(repoDir: string): void {
  clearConfigCache(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
}

test('migrateModelSettings removes repo-local model settings and preserves non-model policy', () => {
  const repoDir = makeRepo();
  try {
    mkdirSync(join(repoDir, '.wavemill', 'native-agent-certifications'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill-config.json'), `{
      "challengeScheduler": { "enabled": false },
      "challengeScheduler": { "enabled": true },
      "challenge": {
        "enabled": true,
        "rate": 0.5,
        "models": ["glm-5.2"],
        "comparisonModel": "claude-opus-4-7"
      },
      "router": {
        "enabled": true,
        "defaultModel": "gpt-5.5",
        "models": ["glm-5.2"],
        "availableModels": { "coder": ["glm-5.2"] },
        "agentMap": { "glm-5.2": "native-openrouter" },
        "defaultAgent": "claude"
      },
      "providers": {
        "openrouter": {
          "enabled": true,
          "apiKeyEnv": "OPENROUTER_API_KEY",
          "models": ["glm-5.2"],
          "stages": ["coder"]
        }
      },
      "nativeAgent": {
        "enabled": true,
        "providers": {
          "openrouter": {
            "enabled": true,
            "apiKeyEnv": "OPENROUTER_API_KEY",
            "models": ["z-ai/glm-5.2"]
          }
        }
      },
      "modelRegistry": {
        "models": {
          "glm-5.2": {
            "nativeCapability": {
              "certification": {
                "maxCertifiedPhase": "workflow",
                "certifiedAt": "2026-07-15T00:00:00.000Z",
                "certificationSuiteVersion": "v2"
              }
            }
          }
        }
      },
      "mill": { "maxParallel": 3 }
    }`);

    const dryRun = migrateModelSettings({ repoDir, dryRun: true });
    assert.equal(dryRun.changed, true);
    assert.equal(dryRun.backups.length, 0);
    assert.ok(dryRun.inventory.some((entry) => entry.path === 'router.availableModels'));
    assert.deepEqual(dryRun.duplicateKeys, [{ file: '.wavemill-config.json', path: 'root', key: 'challengeScheduler' }]);
    assert.ok(existsSync(join(repoDir, '.wavemill', 'native-agent-certifications')));

    const written = migrateModelSettings({ repoDir, dryRun: false });
    assert.equal(written.backups.length, 1);
    clearConfigCache(repoDir);
    const config = loadWavemillConfig(repoDir);
    assert.equal(config.challenge?.enabled, true);
    assert.equal(config.challenge?.rate, 0.5);
    assert.equal(config.router?.enabled, true);
    assert.equal(config.router?.defaultAgent, 'claude');
    assert.equal(config.providers?.openrouter?.apiKeyEnv, 'OPENROUTER_API_KEY');
    assert.equal(config.nativeAgent?.providers?.openrouter?.apiKeyEnv, 'OPENROUTER_API_KEY');
    assert.equal(config.mill?.maxParallel, 3);

    const migrated = JSON.parse(readFileSync(join(repoDir, '.wavemill-config.json'), 'utf-8'));
    assert.equal(migrated.modelRegistry, undefined);
    assert.equal(migrated.router.defaultModel, undefined);
    assert.equal(migrated.router.models, undefined);
    assert.equal(migrated.router.availableModels, undefined);
    assert.equal(migrated.router.agentMap, undefined);
    assert.equal(migrated.challenge.models, undefined);
    assert.equal(migrated.challenge.comparisonModel, undefined);
    assert.equal(migrated.providers.openrouter.models, undefined);
    assert.equal(migrated.providers.openrouter.stages, undefined);
    assert.equal(migrated.nativeAgent.providers.openrouter.models, undefined);
  } finally {
    cleanup(repoDir);
  }
});

test('migrateModelSettings requires acknowledgement for unpublished local cert metadata', () => {
  const repoDir = makeRepo();
  try {
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      modelRegistry: {
        models: {
          'local-only-model': {
            nativeCapability: {
              certification: {
                maxCertifiedPhase: 'patch',
                certifiedAt: '2026-07-15T00:00:00.000Z',
                certificationSuiteVersion: 'v2',
              },
            },
          },
        },
      },
    }));

    assert.throws(
      () => migrateModelSettings({ repoDir, dryRun: true }),
      /--ack-missing-cert=local-only-model/,
    );
    assert.doesNotThrow(() => migrateModelSettings({
      repoDir,
      dryRun: true,
      ackMissingCerts: ['local-only-model'],
    }));
  } finally {
    cleanup(repoDir);
  }
});
