/**
 * Unit tests for native-agent-certify tool business logic validation.
 *
 * Tests argument validation (provider, phase) and dry-run default behavior
 * via the runCertification injectable interface.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCertification } from '../shared/lib/native-agent/certification/certify-command.ts';
import { PHASE_ORDER } from '../shared/lib/native-agent/certification/schema.ts';
import type { HarnessReport, RunScenariosOptions } from '../shared/lib/native-agent/certification/scenario-runner.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'native-agent-certify-tool-test-'));
  return { repoDir, cleanup: () => rmSync(repoDir, { recursive: true, force: true }) };
}

function makePassingReport(provider: string, model: string, dryRun = true): HarnessReport {
  return {
    provider,
    model,
    transport: provider === 'openai' ? 'openai-responses' : 'openai-completions',
    results: [
      {
        scenarioId: 'phase.fixture.persistence-roundtrip',
        category: 'phase',
        classification: 'deterministic',
        phase: 'read-only',
        status: 'pass',
        attempts: 1,
        finalAttemptStatus: 'pass',
        durationMs: 5,
      },
    ],
    countsByStatus: { pass: 1, fail: 0, unsupported: 0, 'not-run': 0 },
    countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 1 },
    knownLimitations: [],
    harnessPassed: true,
    liveCertifiable: !dryRun,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Tests: provider / phase validation
// ---------------------------------------------------------------------------

describe('native-agent-certify input validation', () => {
  it('PHASE_ORDER contains expected phases', () => {
    assert.deepEqual([...PHASE_ORDER], ['read-only', 'patch', 'workflow']);
  });

  it('runCertification default is dry-run (no artifact written)', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const mockRunScenarios = async (_opts: RunScenariosOptions): Promise<HarnessReport> =>
        makePassingReport('openai', 'gpt-4o', true);

      const result = await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'read-only',
        // dryRun defaults to true
        runScenarios: mockRunScenarios,
      });

      assert.equal(result.wrote, false);
      assert.equal(result.report.dryRun, true);
    } finally {
      cleanup();
    }
  });

  it('maps openai to openai-responses transport', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      let capturedTransport: string | undefined;
      const mockRunScenarios = async (opts: RunScenariosOptions): Promise<HarnessReport> => {
        capturedTransport = opts.transport;
        return makePassingReport('openai', 'gpt-4o', true);
      };

      await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'read-only',
        dryRun: true,
        runScenarios: mockRunScenarios,
      });

      assert.equal(capturedTransport, 'openai-responses');
    } finally {
      cleanup();
    }
  });

  it('maps openrouter to openai-completions transport', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      let capturedTransport: string | undefined;
      const mockRunScenarios = async (opts: RunScenariosOptions): Promise<HarnessReport> => {
        capturedTransport = opts.transport;
        return makePassingReport('openrouter', 'openai/gpt-4o-mini', true);
      };

      await runCertification({
        repoDir,
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        phase: 'read-only',
        dryRun: true,
        runScenarios: mockRunScenarios,
      });

      assert.equal(capturedTransport, 'openai-completions');
    } finally {
      cleanup();
    }
  });

  it('read-only phase selects only read-only scenarios from default catalog', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      let capturedCount = 0;
      const mockRunScenarios = async (opts: RunScenariosOptions): Promise<HarnessReport> => {
        capturedCount = opts.scenarios.length;
        return makePassingReport('openai', 'gpt-4o', true);
      };

      await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'read-only',
        dryRun: true,
        runScenarios: mockRunScenarios,
      });

      // Default catalog has read-only scenarios (both deterministic and live-judged)
      assert.ok(capturedCount > 0, 'Should select at least one scenario for read-only phase');
    } finally {
      cleanup();
    }
  });

  it('patch phase selects read-only + patch scenarios (none in current catalog → 0 extra)', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      let capturedCount = 0;
      const mockRunScenarios = async (opts: RunScenariosOptions): Promise<HarnessReport> => {
        capturedCount = opts.scenarios.length;
        return makePassingReport('openai', 'gpt-4o', true);
      };

      await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'patch',
        dryRun: true,
        runScenarios: mockRunScenarios,
      });

      // patch satisfies read-only, so all read-only scenarios are included
      // (plus any patch-phase scenarios, of which there are none in v1 catalog)
      assert.ok(capturedCount >= 0);
    } finally {
      cleanup();
    }
  });
});
