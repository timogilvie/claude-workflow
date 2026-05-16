import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolPath = fileURLToPath(new URL('./sync-config.ts', import.meta.url));

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'sync-config-cli-'));
}

function runSyncConfig(args: string[], cwd: string) {
  return spawnSync('npx', ['tsx', toolPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env },
  });
}

describe('sync-config CLI', () => {
  it('dry-run names the repo config target and omits local override note when no local file exists', () => {
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, '.wavemill-config.json'), '{}\n', 'utf-8');

      const result = runSyncConfig(['--dry-run'], repoDir);

      assert.equal(result.status, 0);
      assert.match(result.stdout, /Sync target: .*\.wavemill-config\.json/);
      assert.doesNotMatch(result.stdout, /Local override detected/);
      assert.match(result.stdout, /Merged config \(dry-run, not written\)/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('dry-run explains that the local override is not modified and classifies local-only paths', () => {
    const repoDir = makeRepo();
    try {
      writeFileSync(
        join(repoDir, '.wavemill-config.json'),
        JSON.stringify({
          configVersion: '1.0.0',
          linear: { project: 'demo' },
          router: { enabled: true },
        }, null, 2),
        'utf-8',
      );
      writeFileSync(
        join(repoDir, '.wavemill-config.local.json'),
        JSON.stringify({
          router: { defaultModel: 'gpt-5.5' },
          developer: { nickname: 'tim' },
          hokusai: { apiToken: 'secret-123' },
        }, null, 2),
        'utf-8',
      );

      const result = runSyncConfig(['--dry-run'], repoDir);

      assert.equal(result.status, 0);
      assert.match(result.stdout, /Local override detected at .*\.wavemill-config\.local\.json/);
      assert.match(result.stdout, /It is read at runtime and is not modified by sync-config\./);
      assert.match(result.stdout, /router\.defaultModel: will add to repo default/);
      assert.match(result.stdout, /developer\.nickname: already local-only/);
      assert.match(result.stdout, /hokusai\.apiToken: requires decision/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps the local override file unchanged after a write run', () => {
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, '.wavemill-config.json'), '{}\n', 'utf-8');
      const localPath = join(repoDir, '.wavemill-config.local.json');
      const localContent = JSON.stringify({
        router: { defaultModel: 'gpt-5.5' },
        mill: { worktreeRoot: '/Users/tester/worktrees' },
      }, null, 2);
      writeFileSync(localPath, `${localContent}\n`, 'utf-8');

      const before = readFileSync(localPath, 'utf-8');
      const result = runSyncConfig(['--yes'], repoDir);
      const after = readFileSync(localPath, 'utf-8');

      assert.equal(result.status, 0);
      assert.equal(after, before);
      assert.match(result.stdout, /Run with --dry-run to classify local override-only fields/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('warns and skips classification when the local override is malformed', () => {
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, '.wavemill-config.json'), '{}\n', 'utf-8');
      writeFileSync(join(repoDir, '.wavemill-config.local.json'), '{"router":', 'utf-8');

      const result = runSyncConfig(['--dry-run'], repoDir);

      assert.equal(result.status, 0);
      assert.match(result.stdout, /Warning: could not parse .*\.wavemill-config\.local\.json/);
      assert.match(result.stdout, /Classification skipped/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
