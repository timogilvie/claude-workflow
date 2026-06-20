import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  diagnoseArtifacts,
  type ArtifactDiagnosticFinding,
  type ArtifactDiagnosticsReport,
  type ArtifactSoftGateId,
  type DiagnoseArtifactsOptions,
} from './artifact-diagnostics.ts';
import { appendJsonlRecord } from './jsonl-utils.ts';
import { mutateJsonState } from './state-mutex.ts';

export type SoftGateSeverity = 'warn' | 'error';

export interface SoftGateWarning {
  timestamp: string;
  issueId: string | null;
  slug: string | null;
  gate: ArtifactSoftGateId;
  severity: SoftGateSeverity;
  artifacts: string[];
  expected?: string;
  actual?: string;
  detail: string;
  recommendedAction?: string;
  traceId?: string | null;
  fingerprint: string;
}

export interface EvaluateSoftGatesOptions extends DiagnoseArtifactsOptions {}

export interface RunSoftGatesOptions extends EvaluateSoftGatesOptions {
  dryRun?: boolean;
  suppressWindowSeconds?: number;
  logPath?: string;
  stderr?: NodeJS.WritableStream;
}

export interface SoftGateRunResult {
  checked: number;
  emitted: number;
  suppressed: number;
  warnings: SoftGateWarning[];
  emittedWarnings: SoftGateWarning[];
  suppressedWarnings: SoftGateWarning[];
  logPath: string;
}

interface SoftGateSeenState {
  version: 1;
  fingerprints: Record<string, string>;
}

const DEFAULT_SUPPRESS_WINDOW_SECONDS = 21600;

function resolveSuppressWindowSeconds(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }
  const fromEnv = Number(process.env.WAVEMILL_SOFT_GATES_SUPPRESS_SECONDS ?? '');
  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_SUPPRESS_WINDOW_SECONDS;
}

function normalizeSoftGateSeverity(finding: ArtifactDiagnosticFinding): SoftGateSeverity {
  return finding.severity === 'error' ? 'error' : 'warn';
}

function fingerprintWarning(warning: Omit<SoftGateWarning, 'fingerprint'>): string {
  const hash = createHash('sha256')
    .update([
      warning.issueId ?? '',
      warning.gate,
      [...warning.artifacts].sort().join('|'),
      warning.expected ?? '',
      warning.actual ?? '',
    ].join('|'))
    .digest('hex');
  return hash.slice(0, 16);
}

function toWarning(
  report: ArtifactDiagnosticsReport,
  finding: ArtifactDiagnosticFinding,
): SoftGateWarning | null {
  if (!finding.gateId) {
    return null;
  }

  const warningBase = {
    timestamp: report.generatedAt,
    issueId: report.taskId,
    slug: report.slug,
    gate: finding.gateId,
    severity: normalizeSoftGateSeverity(finding),
    artifacts: finding.file ? [finding.file] : [],
    expected: finding.expected,
    actual: finding.actual,
    detail: finding.message,
    recommendedAction: finding.recommendedAction,
    traceId: report.traceId ?? (typeof finding.details?.traceId === 'string' ? finding.details.traceId : null),
  };

  return {
    ...warningBase,
    fingerprint: fingerprintWarning(warningBase),
  };
}

function resolveLogPath(repoDir: string, explicitPath?: string): string {
  if (explicitPath) {
    return resolve(explicitPath);
  }
  return join(resolve(repoDir), '.wavemill', 'logs', 'soft-gates.jsonl');
}

function resolveSeenStatePath(logPath: string): string {
  return join(dirname(logPath), '.soft-gates-seen.json');
}

function readSeenStateFingerprints(
  seenStatePath: string,
  suppressWindowSeconds: number,
  nowMs: number,
): Set<string> {
  const fingerprints = new Set<string>();
  const minTimestamp = nowMs - (suppressWindowSeconds * 1000);

  if (!existsSync(seenStatePath)) {
    return fingerprints;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(seenStatePath, 'utf-8'));
  } catch {
    return fingerprints;
  }

  const records = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    ? (parsed as { fingerprints?: Record<string, unknown> }).fingerprints
    : undefined;
  if (!records || typeof records !== 'object' || Array.isArray(records)) {
    return fingerprints;
  }

  for (const [fingerprint, timestamp] of Object.entries(records)) {
    if (!fingerprint) {
      continue;
    }
    const timestampMs = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
    if (!Number.isFinite(timestampMs) || timestampMs < minTimestamp) {
      continue;
    }
    fingerprints.add(fingerprint);
  }

  return fingerprints;
}

function printStderrWarning(stream: NodeJS.WritableStream, warning: SoftGateWarning): void {
  const artifact = warning.artifacts[0] ?? '';
  const detail = warning.detail.replace(/"/g, '\\"');
  stream.write(
    `soft-gate.warning issue=${warning.issueId ?? ''} gate=${warning.gate} severity=${warning.severity} artifact=${artifact} detail="${detail}"\n`,
  );
}

export function evaluateSoftGates(options: EvaluateSoftGatesOptions): SoftGateWarning[] {
  const report = diagnoseArtifacts(options);
  const warnings: SoftGateWarning[] = [];

  for (const finding of report.findings) {
    const warning = toWarning(report, finding);
    if (warning) {
      warnings.push(warning);
    }
  }

  return warnings;
}

export async function runSoftGates(options: RunSoftGatesOptions): Promise<SoftGateRunResult> {
  const repoDir = resolve(options.repoDir);
  const logPath = resolveLogPath(repoDir, options.logPath);
  const seenStatePath = resolveSeenStatePath(logPath);
  const warnings = evaluateSoftGates(options);
  const suppressWindowSeconds = resolveSuppressWindowSeconds(options.suppressWindowSeconds);
  const stderr = options.stderr ?? process.stderr;
  const emittedWarnings: SoftGateWarning[] = [];
  const suppressedWarnings: SoftGateWarning[] = [];
  const nowMs = Date.now();
  const minTimestamp = nowMs - (suppressWindowSeconds * 1000);

  if (!options.dryRun) {
    mkdirSync(dirname(logPath), { recursive: true });
  }

  if (options.dryRun) {
    const existingFingerprints = readSeenStateFingerprints(seenStatePath, suppressWindowSeconds, nowMs);
    for (const warning of warnings) {
      if (existingFingerprints.has(warning.fingerprint)) {
        suppressedWarnings.push(warning);
        continue;
      }
      emittedWarnings.push(warning);
    }
  } else {
    const preexistingFingerprints = readSeenStateFingerprints(seenStatePath, suppressWindowSeconds, nowMs);
    try {
      const nextState = await mutateJsonState<SoftGateSeenState>(
        seenStatePath,
        (current) => {
          const fingerprints = { ...(current.fingerprints ?? {}) };

          for (const [fingerprint, timestamp] of Object.entries(fingerprints)) {
            const timestampMs = Date.parse(timestamp);
            if (!Number.isFinite(timestampMs) || timestampMs < minTimestamp) {
              delete fingerprints[fingerprint];
            }
          }

          for (const warning of warnings) {
            const previousTimestamp = fingerprints[warning.fingerprint];
            const previousMs = previousTimestamp ? Date.parse(previousTimestamp) : Number.NaN;
            if (!Number.isFinite(previousMs) || previousMs < minTimestamp) {
              fingerprints[warning.fingerprint] = warning.timestamp;
            }
          }

          return { version: 1, fingerprints };
        },
        { createIfMissing: true, initial: { version: 1, fingerprints: {} } },
      );

      for (const warning of warnings) {
        if (preexistingFingerprints.has(warning.fingerprint)) {
          suppressedWarnings.push(warning);
          continue;
        }

        if (nextState.fingerprints[warning.fingerprint] !== warning.timestamp) {
          suppressedWarnings.push(warning);
          continue;
        }

        try {
          appendJsonlRecord(logPath, warning);
          emittedWarnings.push(warning);
        } catch {
          // Non-blocking by design.
        }
      }
    } catch {
      for (const warning of warnings) {
        emittedWarnings.push(warning);
        try {
          appendJsonlRecord(logPath, warning);
        } catch {
          // Non-blocking by design.
        }
      }
    }

    for (const warning of emittedWarnings) {
      try {
        printStderrWarning(stderr, warning);
      } catch {
        // Non-blocking by design.
      }
    }
  }

  return {
    checked: warnings.length,
    emitted: emittedWarnings.length,
    suppressed: suppressedWarnings.length,
    warnings,
    emittedWarnings,
    suppressedWarnings,
    logPath,
  };
}
