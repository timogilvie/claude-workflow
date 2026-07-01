/**
 * Native-agent certification command business logic.
 *
 * Provides the `runCertification` function used by the
 * `wavemill native-agent certify` CLI tool. Runs the deterministic
 * certification scenario harness for a given provider/model/phase and
 * optionally writes a certification artifact on a live pass.
 *
 * Dry-run is the default: no paid API calls are made and no artifact is
 * written. Pass `dryRun: false` (via --write in the CLI) for a live run
 * that persists the result on success.
 *
 * @module native-agent/certification/certify-command
 */

import {
  CERTIFICATION_SCHEMA_VERSION,
  PHASE_ORDER,
  phaseSatisfies,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from './schema.ts';
import { getDefaultScenarios, type CertificationScenario } from './scenarios.ts';
import {
  runScenarios,
  toArtifactScenario,
  type HarnessReport,
  type RunScenariosOptions,
} from './scenario-runner.ts';
import { writeCertification } from './store.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from './model-report.ts';
import type { NativeProviderName, PiTransportKind } from '../../model-registry.ts';

// ---------------------------------------------------------------------------
// Transport mapping
// ---------------------------------------------------------------------------

const PROVIDER_TRANSPORT: Record<NativeProviderName, PiTransportKind> = {
  openai: 'openai-responses',
  openrouter: 'openai-completions',
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunCertificationOptions {
  repoDir: string;
  provider: NativeProviderName;
  model: string;
  phase: CertificationPhase;
  /** When true (default), skip paid API calls; no artifact is written. */
  dryRun?: boolean;
  /** ISO timestamp override for deterministic TTL evaluation in tests. */
  now?: Date;
  /** Injection point: override the scenario runner for tests. */
  runScenarios?: (opts: RunScenariosOptions) => Promise<HarnessReport>;
  /** Injection point: override artifact writer for tests. */
  writeCertification?: typeof writeCertification;
}

export interface RunCertificationResult {
  report: HarnessReport;
  /** Path of the written certification artifact, if written. */
  artifactPath?: string;
  /** Whether an artifact was actually written. */
  wrote: boolean;
}

const PHASE_NOT_COVERED_PREFIX = 'No deterministic scenarios cover requested phase';

// ---------------------------------------------------------------------------
// Core: runCertification
// ---------------------------------------------------------------------------

/**
 * Run the deterministic certification scenario harness for a provider/model/phase.
 *
 * Selects scenarios applicable to the requested phase (phaseSatisfies), runs
 * them through the harness, and on a live (`dryRun: false`) `liveCertifiable`
 * pass builds and writes the certification artifact.
 *
 * If no deterministic scenarios cover the requested phase, returns an empty
 * passing report without writing an artifact (the absence is surfaced via the
 * formatted output, not an error throw).
 */
export async function runCertification(opts: RunCertificationOptions): Promise<RunCertificationResult> {
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? new Date();
  const transport = PROVIDER_TRANSPORT[opts.provider];
  const _runScenarios = opts.runScenarios ?? runScenarios;
  const _writeCertification = opts.writeCertification ?? writeCertification;

  // Select scenarios applicable to the requested phase.
  // A scenario at phase X is applicable when phaseSatisfies(requestedPhase, X),
  // i.e. the requested phase meets or exceeds the scenario's phase requirement.
  const allScenarios = getDefaultScenarios();
  const applicableScenarios: CertificationScenario[] = allScenarios.filter(
    (s) => phaseSatisfies(opts.phase, s.phase),
  );

  const report = await _runScenarios({
    provider: opts.provider,
    model: opts.model,
    transport,
    scenarios: applicableScenarios,
    dryRun,
  });

  const requestedPhaseCovered = report.results.some(
    (r) => r.phase === opts.phase && r.status === 'pass',
  );
  const certifiableReport = !dryRun && report.liveCertifiable && !requestedPhaseCovered
    ? {
      ...report,
      liveCertifiable: false,
      knownLimitations: [
        ...report.knownLimitations,
        `${PHASE_NOT_COVERED_PREFIX}: ${opts.phase}`,
      ],
    }
    : report;

  // Write artifact only on a live pass that covered the requested phase.
  if (!dryRun && certifiableReport.liveCertifiable) {
    const artifact: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      provider: opts.provider,
      model: opts.model,
      phase: opts.phase,
      suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
      certifiedAt: now.toISOString(),
      scenarios: report.results
        .filter((r) => r.status !== 'not-run')
        .map(toArtifactScenario),
      knownLimitations: report.knownLimitations.length > 0 ? report.knownLimitations : undefined,
    };

    const artifactPath = _writeCertification(opts.repoDir, artifact);
    return { report: certifiableReport, artifactPath, wrote: true };
  }

  return { report: certifiableReport, wrote: false };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a RunCertificationResult as human-readable text for terminal output.
 */
export function formatCertifyText(result: RunCertificationResult): string {
  const { report, artifactPath, wrote } = result;
  const lines: string[] = [];

  lines.push(`Certification Run  provider=${report.provider}  model=${report.model}  transport=${report.transport}`);
  lines.push(`Dry-run: ${report.dryRun ? 'yes (no paid calls; no artifact written)' : 'no (live run)'}`);
  lines.push('');

  if (report.results.length === 0) {
    lines.push('  No scenarios applicable for the requested phase.');
    return lines.join('\n');
  }

  lines.push('Scenarios:');
  for (const r of report.results) {
    const icon = r.status === 'pass' ? 'PASS'
      : r.status === 'not-run' ? 'SKIP'
      : 'FAIL';
    const detail = r.detail ? `  — ${r.detail}` : '';
    const attempts = r.attempts !== undefined && r.attempts > 1 ? ` (${r.attempts} attempts)` : '';
    lines.push(`  ${icon}  ${r.scenarioId}${attempts}${detail}`);
  }

  lines.push('');
  lines.push(`Result: harnessPassed=${report.harnessPassed}  liveCertifiable=${report.liveCertifiable}`);

  if (report.knownLimitations.length > 0) {
    lines.push('');
    lines.push('Known limitations:');
    for (const lim of report.knownLimitations) {
      lines.push(`  • ${lim}`);
    }
  }

  if (wrote && artifactPath) {
    lines.push('');
    lines.push(`Certification artifact written: ${artifactPath}`);
  } else if (!report.dryRun && !wrote) {
    lines.push('');
    lines.push('No artifact written (certification did not pass).');
  }

  return lines.join('\n');
}

// Re-export for CLI tools
export { PHASE_ORDER, DEFAULT_CERTIFICATION_SUITE_VERSION };
