import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const toolPath = path.join(repoRoot, 'tools', 'check-drift.ts');

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
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'check-drift-tool-'));
  tempDirs.push(repoDir);
  mkdirSync(path.join(repoDir, '.wavemill', 'context'), { recursive: true });
  mkdirSync(path.join(repoDir, 'shared', 'lib'), { recursive: true });
  return repoDir;
}

function writeSpec(repoDir: string, subsystemId: string, name: string, keyFile: string): string {
  const specPath = path.join(repoDir, '.wavemill', 'context', `${subsystemId}.md`);
  writeFileSync(
    specPath,
    `# Subsystem: ${name}

## Key Files
| File | Purpose |
| --- | --- |
| \`${keyFile}\` | Test file |
`
  );
  return specPath;
}

function runCheckDrift(repoDir: string, debug = false) {
  return spawnSync('npx', ['tsx', toolPath, repoDir], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...(debug ? { DEBUG_DRIFT: '1' } : {}),
    },
  });
}

describe('check-drift tool', () => {
  it('prints stale subsystem ids and exits 0 when drift is detected', () => {
    const repoDir = makeRepo();
    const keyFile = path.join(repoDir, 'shared', 'lib', 'linear.ts');
    writeFileSync(keyFile, 'export const value = 1;\n');

    const specPath = writeSpec(repoDir, 'linear-api', 'Linear API', 'shared/lib/linear.ts');
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const newTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    utimesSync(specPath, oldTime, oldTime);
    utimesSync(keyFile, newTime, newTime);

    const result = runCheckDrift(repoDir, true); // Enable debug mode

    // Debug output for CI investigation
    if (result.status !== 0) {
      console.error('TEST DEBUG: Expected exit 0 but got', result.status);
      console.error('TEST DEBUG: stdout:', result.stdout);
      console.error('TEST DEBUG: stderr:', result.stderr);
      console.error('TEST DEBUG: repoDir:', repoDir);
      console.error('TEST DEBUG: specPath exists:', existsSync(specPath));
      console.error('TEST DEBUG: keyFile exists:', existsSync(keyFile));
      if (existsSync(specPath)) {
        const specContent = readFileSync(specPath, 'utf-8');
        console.error('TEST DEBUG: spec mtime:', statSync(specPath).mtime);
        console.error('TEST DEBUG: spec content:', specContent);
      }
      if (existsSync(keyFile)) {
        console.error('TEST DEBUG: key mtime:', statSync(keyFile).mtime);
      }
    }

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), 'linear-api');
    // Don't check stderr - debug output goes there
  });

  it('exits 1 with no output when subsystem docs are current', () => {
    const repoDir = makeRepo();
    const keyFile = path.join(repoDir, 'shared', 'lib', 'linear.ts');
    writeFileSync(keyFile, 'export const value = 1;\n');

    const specPath = writeSpec(repoDir, 'linear-api', 'Linear API', 'shared/lib/linear.ts');
    const recentTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const olderTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(specPath, recentTime, recentTime);
    utimesSync(keyFile, olderTime, olderTime);

    const result = runCheckDrift(repoDir);

    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout.trim(), '');
  });

  it('exits 1 with no output when no context directory exists', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'check-drift-tool-empty-'));
    tempDirs.push(repoDir);

    const result = runCheckDrift(repoDir);

    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout.trim(), '');
  });
});
