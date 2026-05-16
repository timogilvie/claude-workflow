import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CURRENT_CONFIG_VERSION } from '../shared/lib/config.ts';
import { checkConfigVersion } from './check-config-version.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'check-config-version-'));
  tempDirs.push(repoDir);
  return repoDir;
}

function writeBaseConfig(repoDir: string, config: Record<string, unknown>) {
  writeFileSync(resolve(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
}

function writeLocalConfig(repoDir: string, config: Record<string, unknown>) {
  writeFileSync(resolve(repoDir, '.wavemill-config.local.json'), JSON.stringify(config), 'utf-8');
}

describe('checkConfigVersion', () => {
  it('uses the tracked base version even when local override is newer', () => {
    const repoDir = makeRepo();
    writeBaseConfig(repoDir, { configVersion: '1.3.0' });
    writeLocalConfig(repoDir, { configVersion: CURRENT_CONFIG_VERSION });

    const result = checkConfigVersion(repoDir);

    assert.equal(result.status, 'outdated');
    assert.equal(result.needsUpgrade, true);
    assert.equal(result.configVersion, '1.3.0');
  });

  it('treats the tracked base as current even when local override differs', () => {
    const repoDir = makeRepo();
    writeBaseConfig(repoDir, { configVersion: CURRENT_CONFIG_VERSION });
    writeLocalConfig(repoDir, { configVersion: '1.0.0' });

    const result = checkConfigVersion(repoDir);

    assert.equal(result.status, 'current');
    assert.equal(result.needsUpgrade, false);
    assert.equal(result.configVersion, CURRENT_CONFIG_VERSION);
  });

  it('reports missing when only local config exists', () => {
    const repoDir = makeRepo();
    writeLocalConfig(repoDir, { configVersion: CURRENT_CONFIG_VERSION });

    const result = checkConfigVersion(repoDir);

    assert.equal(result.status, 'missing');
    assert.equal(result.needsUpgrade, true);
    assert.equal(result.configVersion, undefined);
  });
});
