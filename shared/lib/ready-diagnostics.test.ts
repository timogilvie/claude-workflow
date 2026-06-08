import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPreflightDiagnostics, writePreflightDiagnostic } from './ready-diagnostics.ts';

test('preflight diagnostics round-trip through jsonl storage', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ready-diagnostics-'));

  try {
    await writePreflightDiagnostic(stateDir, {
      stage: 'cross-pr-guard',
      tool: 'check-cross-pr-reverts',
      classification: 'preflight-failure',
      reason: 'Cross-PR revert guard failed',
      rawError: 'fatal: bad revision auto/integration',
      exitCode: 2,
    });
    await writePreflightDiagnostic(stateDir, {
      stage: 'ready',
      tool: 'runReadyStage',
      classification: 'tool-error',
      reason: 'Ready stage crashed',
    });

    const diagnostics = await readPreflightDiagnostics(stateDir);
    assert.equal(diagnostics.length, 2);
    assert.equal(diagnostics[0]?.stage, 'cross-pr-guard');
    assert.equal(diagnostics[0]?.rawError, 'fatal: bad revision auto/integration');
    assert.equal(diagnostics[0]?.exitCode, 2);
    assert.equal(diagnostics[1]?.tool, 'runReadyStage');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
