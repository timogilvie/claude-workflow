import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, 'build-task-contract.ts');

function runCli(repoDir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: 'utf-8',
    env: process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const MINIMAL_PACKET = `# Task Packet

**Issue ID**: HOK-9999

## 1. Complete Objective & Scope

Build a thing that does the thing.
`;

test('cli: writes task-contract.json and reports missing fields on success (exit 0)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'build-task-contract-cli-'));
  const featureDir = join(tmpDir, 'features', 'demo-task');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'task-packet.md'), MINIMAL_PACKET, 'utf-8');

  try {
    const result = runCli(tmpDir, ['--repo-dir', tmpDir, 'demo-task']);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.match(result.stdout, /Written: features\/demo-task\/task-contract\.json/);
    assert.match(result.stdout, /Missing fields: \d+/);
    assert.equal(existsSync(join(featureDir, 'task-contract.json')), true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cli: exits nonzero and does not write task-contract.json when feature dir is missing', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'build-task-contract-cli-'));
  // Create features/ but not the target slug, so both resolution paths fail.
  mkdirSync(join(tmpDir, 'features'), { recursive: true });

  try {
    const result = runCli(tmpDir, ['--repo-dir', tmpDir, 'does-not-exist']);
    assert.notEqual(result.status, 0, `expected nonzero exit, got ${result.status}`);
    const combined = `${result.stdout}${result.stderr}`;
    assert.match(combined, /not found|Feature directory/i);
    assert.equal(existsSync(join(tmpDir, 'features', 'does-not-exist', 'task-contract.json')), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
