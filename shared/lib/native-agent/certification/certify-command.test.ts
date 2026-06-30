/**
 * Unit tests for runCertification and formatCertifyText.
 *
 * Tests cover:
 * - Dry-run produces non-writing pass/fail report (injected runScenarios)
 * - Live pass writes artifact
 * - Failure → no artifact written
 * - Per-scenario and known limitations surfaced
 * - Phase scenario filtering
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCertification, formatCertifyText } from './certify-command.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from './model-report.ts';
import type { HarnessReport, RunScenariosOptions } from './scenario-runner.ts';
import { CERTIFICATION_BASE_PATH } from './schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'certify-command-test-'));
  return { repoDir, cleanup: () => rmSync(repoDir, { recursive: true, force: true }) };
}

function makePassingReport(overrides: Partial<HarnessReport> = {}): HarnessReport {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    transport: 'openai-responses',
    results: [
      {
        scenarioId: 'test.scenario.1',
        category: 'tool',
        classification: 'deterministic',
        phase: 'read-only',
        status: 'pass',
        attempts: 1,
        finalAttemptStatus: 'pass',
        durationMs: 10,
      },
    ],
    countsByStatus: { pass: 1, fail: 0, unsupported: 0, 'not-run': 0 },
    countsByCategory: { tool: 1, usage: 0, transcript: 0, phase: 0 },
    knownLimitations: [],
    harnessPassed: true,
    liveCertifiable: false,
    dryRun: true,
    ...overrides,
  };
}

function makeFailingReport(overrides: Partial<HarnessReport> = {}): HarnessReport {
  return makePassingReport({
    results: [
      {
        scenarioId: 'test.scenario.fail',
        category: 'tool',
        classification: 'deterministic',
        phase: 'read-only',
        status: 'fail',
        detail: 'assertion failed',
        attempts: 1,
        finalAttemptStatus: 'fail',
        failureClass: 'deterministic_failure',
        durationMs: 5,
      },
    ],
    countsByStatus: { pass: 0, fail: 1, unsupported: 0, 'not-run': 0 },
    harnessPassed: false,
    liveCertifiable: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests: runCertification dry-run
// ---------------------------------------------------------------------------

describe('runCertification', () => {
  it('dry-run returns passing report without writing artifact', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const mockRunScenarios = async (_opts: RunScenariosOptions): Promise<HarnessReport> =>
        makePassingReport({ dryRun: true, liveCertifiable: false });

      const result = await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'read-only',
        dryRun: true,
        runScenarios: mockRunScenarios,
      });

      assert.equal(result.wrote, false);
      assert.equal(result.artifactPath, undefined);
      assert.equal(result.report.harnessPassed, true);
      assert.equal(result.report.dryRun, true);
    } finally {
      cleanup();
    }
  });

  it('dry-run with failing scenario returns failing report without writing artifact', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const mockRunScenarios = async (_opts: RunScenariosOptions): Promise<HarnessReport> =>
        makeFailingReport({ dryRun: true, liveCertifiable: false });

      const result = await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'read-only',
        dryRun: true,
        runScenarios: mockRunScenarios,
      });

      assert.equal(result.wrote, false);
      assert.equal(result.report.harnessPassed, false);
    } finally {
      cleanup();
    }
  });

  it('live pass writes artifact and returns path', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const now = new Date('2026-06-01T00:00:00.000Z');
      const livePassReport: HarnessReport = makePassingReport({
        dryRun: false,
        liveCertifiable: true,
      });

      const mockRunScenarios = async (_opts: RunScenariosOptions): Promise<HarnessReport> =>
        livePassReport;

      const result = await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'read-only',
        dryRun: false,
        now,
        runScenarios: mockRunScenarios,
      });

      assert.equal(result.wrote, true);
      assert.ok(result.artifactPath);
      assert.ok(existsSync(result.artifactPath));

      // Artifact should be in the expected path
      const expectedPath = join(
        repoDir,
        CERTIFICATION_BASE_PATH,
        'openai',
        'gpt-4o',
        `${DEFAULT_CERTIFICATION_SUITE_VERSION}.json`,
      );
      assert.equal(result.artifactPath, expectedPath);
    } finally {
      cleanup();
    }
  });

  it('live failing run does not write artifact', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const failReport: HarnessReport = makeFailingReport({
        dryRun: false,
        liveCertifiable: false,
      });

      const mockRunScenarios = async (_opts: RunScenariosOptions): Promise<HarnessReport> =>
        failReport;

      const result = await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'read-only',
        dryRun: false,
        runScenarios: mockRunScenarios,
      });

      assert.equal(result.wrote, false);
      assert.equal(result.artifactPath, undefined);
      assert.equal(result.report.harnessPassed, false);
    } finally {
      cleanup();
    }
  });

  it('surfaces known limitations from harness report', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const reportWithLimitations: HarnessReport = makePassingReport({
        knownLimitations: ['Live-judged scenarios require a paid provider call and are not run by the deterministic harness.'],
        dryRun: true,
        liveCertifiable: false,
      });

      const mockRunScenarios = async (_opts: RunScenariosOptions): Promise<HarnessReport> =>
        reportWithLimitations;

      const result = await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'read-only',
        dryRun: true,
        runScenarios: mockRunScenarios,
      });

      assert.equal(result.report.knownLimitations.length, 1);
      assert.ok(result.report.knownLimitations[0].includes('Live-judged'));
    } finally {
      cleanup();
    }
  });

  it('passes provider and model to the scenario runner', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      let capturedOpts: RunScenariosOptions | undefined;
      const mockRunScenarios = async (opts: RunScenariosOptions): Promise<HarnessReport> => {
        capturedOpts = opts;
        return makePassingReport({ provider: opts.provider, model: opts.model, dryRun: true, liveCertifiable: false });
      };

      await runCertification({
        repoDir,
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        phase: 'read-only',
        dryRun: true,
        runScenarios: mockRunScenarios,
      });

      assert.ok(capturedOpts);
      assert.equal(capturedOpts.provider, 'openrouter');
      assert.equal(capturedOpts.model, 'openai/gpt-4o-mini');
      assert.equal(capturedOpts.transport, 'openai-completions');
      assert.equal(capturedOpts.dryRun, true);
    } finally {
      cleanup();
    }
  });

  it('only selects scenarios applicable to the requested phase', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      let capturedScenarios: RunScenariosOptions['scenarios'] | undefined;
      const mockRunScenarios = async (opts: RunScenariosOptions): Promise<HarnessReport> => {
        capturedScenarios = opts.scenarios;
        return makePassingReport({ dryRun: true, liveCertifiable: false });
      };

      await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'read-only',
        dryRun: true,
        runScenarios: mockRunScenarios,
      });

      assert.ok(capturedScenarios);
      // All selected scenarios should have phase satisfiable by 'read-only'
      for (const s of capturedScenarios) {
        // read-only phase satisfies read-only requirement
        assert.equal(s.phase, 'read-only');
      }
    } finally {
      cleanup();
    }
  });

  it('artifact uses DEFAULT_CERTIFICATION_SUITE_VERSION on live pass', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const livePassReport: HarnessReport = makePassingReport({
        dryRun: false,
        liveCertifiable: true,
      });
      const mockRunScenarios = async (_opts: RunScenariosOptions): Promise<HarnessReport> =>
        livePassReport;

      const result = await runCertification({
        repoDir,
        provider: 'openai',
        model: 'gpt-4o',
        phase: 'read-only',
        dryRun: false,
        runScenarios: mockRunScenarios,
      });

      assert.ok(result.artifactPath?.includes(DEFAULT_CERTIFICATION_SUITE_VERSION));
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: formatCertifyText
// ---------------------------------------------------------------------------

describe('formatCertifyText', () => {
  it('shows provider/model/transport header', () => {
    const result = {
      report: makePassingReport({ dryRun: true, liveCertifiable: false }),
      wrote: false,
    };
    const text = formatCertifyText(result);
    assert.match(text, /provider=openai/);
    assert.match(text, /model=gpt-4o/);
    assert.match(text, /transport=openai-responses/);
  });

  it('shows dry-run indicator', () => {
    const result = {
      report: makePassingReport({ dryRun: true, liveCertifiable: false }),
      wrote: false,
    };
    const text = formatCertifyText(result);
    assert.match(text, /Dry-run: yes/);
  });

  it('shows PASS for each passing scenario', () => {
    const result = {
      report: makePassingReport({ dryRun: true, liveCertifiable: false }),
      wrote: false,
    };
    const text = formatCertifyText(result);
    assert.match(text, /PASS/);
    assert.match(text, /test\.scenario\.1/);
  });

  it('shows FAIL for failing scenario with detail', () => {
    const result = {
      report: makeFailingReport({ dryRun: true, liveCertifiable: false }),
      wrote: false,
    };
    const text = formatCertifyText(result);
    assert.match(text, /FAIL/);
    assert.match(text, /assertion failed/);
  });

  it('shows known limitations section when present', () => {
    const result = {
      report: makePassingReport({
        dryRun: true,
        liveCertifiable: false,
        knownLimitations: ['Live-judged scenarios require a paid provider call.'],
      }),
      wrote: false,
    };
    const text = formatCertifyText(result);
    assert.match(text, /Known limitations:/);
    assert.match(text, /Live-judged/);
  });

  it('shows artifact path when written', () => {
    const result = {
      report: makePassingReport({ dryRun: false, liveCertifiable: true }),
      artifactPath: '/tmp/test-repo/.wavemill/native-agent-certifications/openai/gpt-4o/v1.json',
      wrote: true,
    };
    const text = formatCertifyText(result);
    assert.match(text, /Certification artifact written:/);
    assert.match(text, /v1\.json/);
  });

  it('shows no-artifact note on live fail', () => {
    const result = {
      report: makeFailingReport({ dryRun: false, liveCertifiable: false }),
      wrote: false,
    };
    const text = formatCertifyText(result);
    assert.match(text, /No artifact written/);
  });

  it('shows "no scenarios" message when result list is empty', () => {
    const report: HarnessReport = {
      ...makePassingReport(),
      results: [],
      countsByStatus: { pass: 0, fail: 0, unsupported: 0, 'not-run': 0 },
      countsByCategory: { tool: 0, usage: 0, transcript: 0, phase: 0 },
    };
    const text = formatCertifyText({ report, wrote: false });
    assert.match(text, /No scenarios applicable/);
  });
});
