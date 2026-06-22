import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkPiVersions } from './check-pi-version.ts';

const PI_AI = '@earendil-works/pi-ai';
const PI_CORE = '@earendil-works/pi-agent-core';
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.PI_INTEGRATION_PASSED;
});

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'check-pi-version-'));
  tempDirs.push(repoDir);
  writeFixture(repoDir, {
    packageSpec: '0.79.8',
    coreSpec: '0.79.8',
    lockVersion: '0.79.8',
    coreLockVersion: '0.79.8',
  });
  return repoDir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function writeFixture(
  repoDir: string,
  options: {
    packageSpec?: string;
    coreSpec?: string;
    lockVersion?: string;
    coreLockVersion?: string;
    installedVersion?: string;
  },
): void {
  writeJson(resolve(repoDir, 'package.json'), {
    dependencies: {
      ...(options.packageSpec !== undefined && { [PI_AI]: options.packageSpec }),
      ...(options.coreSpec !== undefined && { [PI_CORE]: options.coreSpec }),
    },
  });
  writeJson(resolve(repoDir, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: {
          ...(options.packageSpec !== undefined && { [PI_AI]: options.packageSpec }),
          ...(options.coreSpec !== undefined && { [PI_CORE]: options.coreSpec }),
        },
      },
      ...(options.lockVersion !== undefined && {
        [`node_modules/${PI_AI}`]: { version: options.lockVersion },
      }),
      ...(options.coreLockVersion !== undefined && {
        [`node_modules/${PI_CORE}`]: { version: options.coreLockVersion },
      }),
    },
  });
  if (options.installedVersion !== undefined) {
    writeJson(resolve(repoDir, 'node_modules', PI_AI, 'package.json'), { version: options.installedVersion });
  }
}

describe('checkPiVersions', () => {
  it('passes when root specs and lockfile entries match exactly', () => {
    const repoDir = makeRepo();

    const result = checkPiVersions(repoDir);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'ok');
    assert.equal(result.packages.every((pkg) => pkg.ok), true);
  });

  it('fails when a root dependency spec is unpinned', () => {
    const repoDir = makeRepo();
    writeFixture(repoDir, {
      packageSpec: '^0.79.8',
      coreSpec: '0.79.8',
      lockVersion: '0.79.8',
      coreLockVersion: '0.79.8',
    });

    const result = checkPiVersions(repoDir);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'drift');
    assert.ok(result.packages.find((pkg) => pkg.packageName === PI_AI)!.problems.some((p) => p.includes('not pinned')));
  });

  it('fails when a lockfile package version drifts from the root spec', () => {
    const repoDir = makeRepo();
    writeFixture(repoDir, {
      packageSpec: '0.80.0',
      coreSpec: '0.79.8',
      lockVersion: '0.79.8',
      coreLockVersion: '0.79.8',
    });

    const result = checkPiVersions(repoDir);

    assert.equal(result.ok, false);
    assert.ok(result.packages.find((pkg) => pkg.packageName === PI_AI)!.problems.some((p) => p.includes('does not match')));
  });

  it('fails when installed node_modules version drifts from the lockfile', () => {
    const repoDir = makeRepo();
    writeFixture(repoDir, {
      packageSpec: '0.79.8',
      coreSpec: '0.79.8',
      lockVersion: '0.79.8',
      coreLockVersion: '0.79.8',
      installedVersion: '0.80.0',
    });

    const result = checkPiVersions(repoDir);

    assert.equal(result.ok, false);
    assert.ok(result.packages.find((pkg) => pkg.packageName === PI_AI)!.problems.some((p) => p.includes('installed version')));
  });

  it('fails when a package-lock entry is missing', () => {
    const repoDir = makeRepo();
    writeFixture(repoDir, {
      packageSpec: '0.79.8',
      coreSpec: '0.79.8',
      lockVersion: undefined,
      coreLockVersion: '0.79.8',
    });

    const result = checkPiVersions(repoDir);

    assert.equal(result.ok, false);
    assert.ok(result.packages.find((pkg) => pkg.packageName === PI_AI)!.problems.some((p) => p.includes('missing')));
  });

  it('allows drift when integration passed is supplied as an option', () => {
    const repoDir = makeRepo();
    writeFixture(repoDir, {
      packageSpec: '^0.79.8',
      coreSpec: '0.79.8',
      lockVersion: '0.79.8',
      coreLockVersion: '0.79.8',
    });

    const result = checkPiVersions(repoDir, { integrationPassed: true });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'drift_allowed');
  });

  it('allows drift when PI_INTEGRATION_PASSED=1', () => {
    const repoDir = makeRepo();
    process.env.PI_INTEGRATION_PASSED = '1';
    writeFixture(repoDir, {
      packageSpec: '0.79.8',
      coreSpec: '0.79.8',
      lockVersion: '0.80.0',
      coreLockVersion: '0.79.8',
    });

    const result = checkPiVersions(repoDir);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'drift_allowed');
  });
});
