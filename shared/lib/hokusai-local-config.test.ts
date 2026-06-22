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
