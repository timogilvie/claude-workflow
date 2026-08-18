import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  configureContributionUpload,
  ensureGitignoreEntry,
  HOKUSAI_CONTRIBUTION_ENDPOINT,
  HOKUSAI_ENDPOINT_TOKEN_ENV,
  HOKUSAI_BATCH_SIZE,
  HOKUSAI_DEFAULT_MODEL_ID,
  LEGACY_UNSCOPED_ENDPOINT,
  buildHokusaiContributionEndpoint,
  migrateContributionEndpoint,
} from './hokusai-local-config.ts';

const tempDirs: string[] = [];

function makeTempRepo(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hokusai-local-config-'));
  tempDirs.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, '.wavemill-config.local.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  }
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('hokusai-local-config', () => {
  describe('configureContributionUpload', () => {
    it('creates .wavemill-config.local.json when it does not exist', () => {
      const repoDir = makeTempRepo();
      const result = configureContributionUpload({ repoDir });

      assert.equal(result.action, 'created');
      assert.equal(result.endpoint, HOKUSAI_CONTRIBUTION_ENDPOINT);
      assert.ok(existsSync(result.localConfigPath));

      const written = JSON.parse(readFileSync(result.localConfigPath, 'utf-8')) as {
        hokusai: { contributions: { endpoint: string; endpointTokenEnv: string; batchSize: number } };
      };
      assert.equal(written.hokusai.contributions.endpoint, HOKUSAI_CONTRIBUTION_ENDPOINT);
      assert.equal(written.hokusai.contributions.endpointTokenEnv, HOKUSAI_ENDPOINT_TOKEN_ENV);
      assert.equal(written.hokusai.contributions.batchSize, HOKUSAI_BATCH_SIZE);
    });

    it('updates existing file with deep merge, preserving other keys', () => {
      const repoDir = makeTempRepo({
        mill: { maxParallel: 4 },
        hokusai: { contributions: { exportPath: '.wavemill/hokusai/contributions.jsonl' } },
      });
      const result = configureContributionUpload({ repoDir });

      assert.equal(result.action, 'updated');
      const written = JSON.parse(readFileSync(result.localConfigPath, 'utf-8')) as {
        mill: { maxParallel: number };
        hokusai: { contributions: { endpoint: string; exportPath: string } };
      };
      assert.equal(written.mill.maxParallel, 4);
      assert.equal(written.hokusai.contributions.endpoint, HOKUSAI_CONTRIBUTION_ENDPOINT);
      assert.equal(written.hokusai.contributions.exportPath, '.wavemill/hokusai/contributions.jsonl');
    });

    it('returns unchanged when endpoint is already the same', () => {
      const repoDir = makeTempRepo({
        hokusai: {
          contributions: {
            endpoint: HOKUSAI_CONTRIBUTION_ENDPOINT,
            endpointTokenEnv: HOKUSAI_ENDPOINT_TOKEN_ENV,
            batchSize: HOKUSAI_BATCH_SIZE,
          },
        },
      });
      const result = configureContributionUpload({ repoDir });
      assert.equal(result.action, 'unchanged');
    });

    it('accepts a custom endpoint override', () => {
      const repoDir = makeTempRepo();
      const result = configureContributionUpload({ repoDir, endpoint: 'https://custom.example.com/v1/contributions' });

      assert.equal(result.action, 'created');
      assert.equal(result.endpoint, 'https://custom.example.com/v1/contributions');
      const written = JSON.parse(readFileSync(result.localConfigPath, 'utf-8')) as {
        hokusai: { contributions: { endpoint: string } };
      };
      assert.equal(written.hokusai.contributions.endpoint, 'https://custom.example.com/v1/contributions');
    });

    it('self-heals a legacy overlay before configuring upload', () => {
      const repoDir = makeTempRepo({
        hokusai: {
          contributions: {
            endpoint: LEGACY_UNSCOPED_ENDPOINT,
            endpointTokenEnv: 'HOKUSAI_API_KEY',
            exportPath: '.wavemill/hokusai/contributions.jsonl',
          },
        },
      });

      const result = configureContributionUpload({ repoDir });

      assert.equal(result.action, 'updated');
      const written = JSON.parse(readFileSync(result.localConfigPath, 'utf-8')) as {
        hokusai: { contributions: { endpoint: string; endpointTokenEnv: string; exportPath: string } };
      };
      assert.equal(written.hokusai.contributions.endpoint, HOKUSAI_CONTRIBUTION_ENDPOINT);
      assert.equal(written.hokusai.contributions.endpointTokenEnv, HOKUSAI_ENDPOINT_TOKEN_ENV);
      assert.equal(written.hokusai.contributions.exportPath, '.wavemill/hokusai/contributions.jsonl');
    });
  });

  describe('migrateContributionEndpoint', () => {
    it('returns absent when no local overlay exists', () => {
      const repoDir = makeTempRepo();
      const result = migrateContributionEndpoint({ repoDir });

      assert.equal(result.action, 'absent');
      assert.equal(result.localConfigPath, join(repoDir, '.wavemill-config.local.json'));
    });

    it('leaves an already model-scoped overlay unchanged', () => {
      const repoDir = makeTempRepo({
        hokusai: {
          contributions: {
            endpoint: HOKUSAI_CONTRIBUTION_ENDPOINT,
            endpointTokenEnv: 'HOKUSAI_API_KEY',
          },
        },
      });

      const result = migrateContributionEndpoint({ repoDir });

      assert.equal(result.action, 'unchanged');
      const written = JSON.parse(readFileSync(result.localConfigPath, 'utf-8')) as {
        hokusai: { contributions: { endpoint: string; endpointTokenEnv: string } };
      };
      assert.equal(written.hokusai.contributions.endpoint, HOKUSAI_CONTRIBUTION_ENDPOINT);
      assert.equal(written.hokusai.contributions.endpointTokenEnv, 'HOKUSAI_API_KEY');
    });

    it('leaves legitimate custom endpoints unchanged', () => {
      const repoDir = makeTempRepo({
        hokusai: {
          contributions: {
            endpoint: 'https://staging.example.com/api/v1/contributions',
          },
        },
      });

      const result = migrateContributionEndpoint({ repoDir });

      assert.equal(result.action, 'unchanged');
      const written = JSON.parse(readFileSync(result.localConfigPath, 'utf-8')) as {
        hokusai: { contributions: { endpoint: string } };
      };
      assert.equal(written.hokusai.contributions.endpoint, 'https://staging.example.com/api/v1/contributions');
    });

    it('migrates a legacy unscoped overlay and preserves sibling keys', () => {
      const repoDir = makeTempRepo({
        mill: { maxParallel: 3 },
        hokusai: {
          contributions: {
            endpoint: 'HTTPS://API.HOKUS.AI/api/v1/contributions/',
            endpointTokenEnv: 'HOKUSAI_API_KEY',
            batchSize: 10,
          },
        },
      });

      const result = migrateContributionEndpoint({ repoDir });

      assert.deepEqual(result, {
        action: 'migrated',
        localConfigPath: join(repoDir, '.wavemill-config.local.json'),
        from: 'HTTPS://API.HOKUS.AI/api/v1/contributions/',
        to: HOKUSAI_CONTRIBUTION_ENDPOINT,
      });
      const written = JSON.parse(readFileSync(result.localConfigPath, 'utf-8')) as {
        mill: { maxParallel: number };
        hokusai: { contributions: { endpoint: string; endpointTokenEnv: string; batchSize: number } };
      };
      assert.equal(written.mill.maxParallel, 3);
      assert.equal(written.hokusai.contributions.endpoint, HOKUSAI_CONTRIBUTION_ENDPOINT);
      assert.equal(written.hokusai.contributions.endpointTokenEnv, 'HOKUSAI_API_KEY');
      assert.equal(written.hokusai.contributions.batchSize, 10);
    });

    it('reports dry-run migration without writing', () => {
      const repoDir = makeTempRepo({
        hokusai: {
          contributions: {
            endpoint: LEGACY_UNSCOPED_ENDPOINT,
          },
        },
      });

      const result = migrateContributionEndpoint({ repoDir, dryRun: true });

      assert.equal(result.action, 'migrated');
      assert.equal(result.from, LEGACY_UNSCOPED_ENDPOINT);
      assert.equal(result.to, HOKUSAI_CONTRIBUTION_ENDPOINT);
      const written = JSON.parse(readFileSync(result.localConfigPath, 'utf-8')) as {
        hokusai: { contributions: { endpoint: string } };
      };
      assert.equal(written.hokusai.contributions.endpoint, LEGACY_UNSCOPED_ENDPOINT);
    });
  });

  describe('ensureGitignoreEntry', () => {
    it('creates .gitignore when it does not exist', () => {
      const repoDir = makeTempRepo();
      const result = ensureGitignoreEntry(repoDir, '.wavemill-config.local.json');

      assert.equal(result, 'added');
      const content = readFileSync(join(repoDir, '.gitignore'), 'utf-8');
      assert.ok(content.includes('.wavemill-config.local.json'));
    });

    it('appends to existing .gitignore when entry is missing', () => {
      const repoDir = makeTempRepo();
      writeFileSync(join(repoDir, '.gitignore'), 'node_modules/\n.env\n', 'utf-8');

      const result = ensureGitignoreEntry(repoDir, '.wavemill-config.local.json');

      assert.equal(result, 'added');
      const content = readFileSync(join(repoDir, '.gitignore'), 'utf-8');
      assert.ok(content.includes('node_modules/'));
      assert.ok(content.includes('.wavemill-config.local.json'));
    });

    it('returns exists when entry is already present', () => {
      const repoDir = makeTempRepo();
      writeFileSync(join(repoDir, '.gitignore'), '.wavemill-config.local.json\n', 'utf-8');

      const result = ensureGitignoreEntry(repoDir, '.wavemill-config.local.json');
      assert.equal(result, 'exists');
    });

    it('does not duplicate an existing entry', () => {
      const repoDir = makeTempRepo();
      writeFileSync(join(repoDir, '.gitignore'), '.wavemill-config.local.json\n.env\n', 'utf-8');

      ensureGitignoreEntry(repoDir, '.wavemill-config.local.json');
      const content = readFileSync(join(repoDir, '.gitignore'), 'utf-8');
      const count = (content.match(/\.wavemill-config\.local\.json/g) ?? []).length;
      assert.equal(count, 1);
    });
  });
});

describe('contribution endpoint', () => {
  // The ingest route is model-scoped: POST /api/v1/models/{model_id}/contributions.
  // It is registered that way by the data-pipeline API
  // (src/api/endpoints/contributions.py) and built that way by the SDK
  // (packages/core/src/client.ts buildModelContributionsPath).
  //
  // Wavemill previously defaulted to an unscoped /api/v1/contributions, which
  // the API does not serve. It returned 404, the queue classified that as a
  // permanent failure, and every contribution was dead-lettered instead of
  // uploaded. Pin the shape so the model scope cannot be dropped again.
  it('matches the SDK canonical model-scoped route', () => {
    assert.equal(
      HOKUSAI_CONTRIBUTION_ENDPOINT,
      'https://api.hokus.ai/api/v1/models/30/contributions',
    );
  });

  it('is model-scoped, never a bare /api/v1/contributions', () => {
    assert.match(HOKUSAI_CONTRIBUTION_ENDPOINT, /\/api\/v1\/models\/[^/]+\/contributions$/);
    assert.doesNotMatch(HOKUSAI_CONTRIBUTION_ENDPOINT, /\/api\/v1\/contributions$/);
  });

  it('defaults to the SDK router model id', () => {
    assert.equal(HOKUSAI_DEFAULT_MODEL_ID, '30');
    assert.equal(buildHokusaiContributionEndpoint(), HOKUSAI_CONTRIBUTION_ENDPOINT);
  });

  it('scopes to an explicit model id when given one', () => {
    assert.equal(
      buildHokusaiContributionEndpoint('42'),
      'https://api.hokus.ai/api/v1/models/42/contributions',
    );
  });
});
