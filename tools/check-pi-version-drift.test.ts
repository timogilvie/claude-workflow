import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { checkPiVersionDrift } from './check-pi-version-drift.ts';

const PI_AI = '@earendil-works/pi-ai';
const PI_AGENT_CORE = '@earendil-works/pi-agent-core';

function writeFixture(options?: {
  packageDeps?: Record<string, string>;
  lockRootDeps?: Record<string, string>;
  lockVersions?: Record<string, string | undefined>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-version-drift-'));
  const packageDeps = options?.packageDeps ?? {
    [PI_AI]: '0.79.8',
    [PI_AGENT_CORE]: '0.79.8',
  };
  const lockRootDeps = options?.lockRootDeps ?? packageDeps;
  const lockVersions = options?.lockVersions ?? {
    [PI_AI]: '0.79.8',
    [PI_AGENT_CORE]: '0.79.8',
  };

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: packageDeps }, null, 2),
  );
  const packages: Record<string, unknown> = {
    '': { dependencies: lockRootDeps },
  };
  for (const [name, version] of Object.entries(lockVersions)) {
    if (version !== undefined) {
      packages[`node_modules/${name}`] = { version };
    }
  }
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages }, null, 2),
  );

  return {
    dir,
    packageJsonPath: join(dir, 'package.json'),
    packageLockPath: join(dir, 'package-lock.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('checkPiVersionDrift', () => {
  it('passes when package.json and package-lock.json match exact Pi pins', () => {
    const fixture = writeFixture();
    try {
      const result = checkPiVersionDrift(fixture.packageJsonPath, fixture.packageLockPath);
      assert.equal(result.ok, true);
      assert.deepEqual(result.errors, []);
    } finally {
      fixture.cleanup();
    }
  });

  it('fails when package-lock resolved version differs from package.json', () => {
    const fixture = writeFixture({
      lockVersions: {
        [PI_AI]: '0.80.0',
        [PI_AGENT_CORE]: '0.79.8',
      },
    });
    try {
      const result = checkPiVersionDrift(fixture.packageJsonPath, fixture.packageLockPath);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.includes('resolved lock version "0.80.0"')));
    } finally {
      fixture.cleanup();
    }
  });

  it('fails when root dependency uses a range instead of an exact pin', () => {
    const fixture = writeFixture({
      packageDeps: {
        [PI_AI]: '^0.79.8',
        [PI_AGENT_CORE]: '0.79.8',
      },
      lockRootDeps: {
        [PI_AI]: '^0.79.8',
        [PI_AGENT_CORE]: '0.79.8',
      },
    });
    try {
      const result = checkPiVersionDrift(fixture.packageJsonPath, fixture.packageLockPath);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.includes('must use an exact pinned version')));
    } finally {
      fixture.cleanup();
    }
  });

  it('fails when a Pi package is missing from package.json', () => {
    const fixture = writeFixture({
      packageDeps: {
        [PI_AI]: '0.79.8',
      },
      lockRootDeps: {
        [PI_AI]: '0.79.8',
      },
      lockVersions: {
        [PI_AI]: '0.79.8',
      },
    });
    try {
      const result = checkPiVersionDrift(fixture.packageJsonPath, fixture.packageLockPath);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.includes(`${PI_AGENT_CORE} is missing`)));
    } finally {
      fixture.cleanup();
    }
  });

  it('fails closed when package metadata cannot be read', () => {
    const result = checkPiVersionDrift('/tmp/does-not-exist-package.json', '/tmp/does-not-exist-package-lock.json');
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 1);
  });

  it('workflow runs integration only when drift is detected', () => {
    const workflow = readFileSync('.github/workflows/pi-version-drift-gate.yml', 'utf8');
    assert.ok(workflow.includes("if: steps.drift.outputs.drift == 'true'"));
    assert.ok(workflow.includes('run: npm run test:integration'));
  });
});
