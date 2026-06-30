/**
 * Model certification status report.
 *
 * Builds an offline, read-only status report joining configured native-agent
 * providers, on-disk certification artifacts, and model registry capability
 * metadata. Mirrors the state logic used by filterNativeModels + the workflow
 * router so that operators see the same eligibility signal the router uses.
 *
 * State taxonomy (one per row):
 * - `ready`              — valid, fresh, phase-satisfying artifact; task-routable
 * - `uncertified`        — capability OK but no valid artifact
 * - `stale`              — artifact past TTL or expiresAt
 * - `certification-only` — valid cert artifact but not task-routable (partial capability)
 * - `unsupported`        — registry capability is unsupported or unregistered
 *
 * This module makes NO network or API calls.
 *
 * @module native-agent/certification/model-report
 */

import { getEffectiveRegistry, evaluateNativeReadOnlyRouting, type ModelRegistry, type ReadOnlyNativeCapability } from '../../model-registry.ts';
import { resolveNativeAgentProviders } from '../providers.ts';
import {
  listCertifications,
  readCertification,
} from './store.ts';
import {
  parseCertificationPath,
  checkCertificationEligibility,
} from './loader.ts';
import type { CertificationPhase } from './schema.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CERTIFICATION_SUITE_VERSION = 'v1' as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ModelReportState =
  | 'ready'
  | 'uncertified'
  | 'stale'
  | 'certification-only'
  | 'unsupported';

export interface PhaseEligibility {
  /** reviewer role requires read-only */
  reviewer: boolean;
  /** coder role requires patch */
  coder: boolean;
  /** planner role requires workflow */
  planner: boolean;
}

export interface ModelReportRow {
  provider: string;
  model: string;
  state: ModelReportState;
  /** Registry capability value */
  capability: ReadOnlyNativeCapability | 'unregistered';
  /** Suite version of the certification artifact, if any */
  suiteVersion?: string;
  /** ISO 8601 certification timestamp, if any */
  certifiedAt?: string;
  /** Age of the certification in whole days, if certifiedAt is available */
  ageDays?: number;
  /** Highest phase level the current artifact certifies */
  maxCertifiedPhase?: CertificationPhase;
  /** Known limitations from the certification artifact, if any */
  knownLimitations?: string[];
  /** Per-router-role phase eligibility */
  phaseEligibility: PhaseEligibility;
  /** Human-readable explanation for non-ready states */
  reason?: string;
}

export interface ModelReport {
  /** ISO 8601 timestamp when this report was generated */
  generatedAt: string;
  rows: ModelReportRow[];
}

// ---------------------------------------------------------------------------
// Core: buildModelReport
// ---------------------------------------------------------------------------

/**
 * Build a certification status report for all known native-agent models.
 *
 * Joins configured providers (from wavemill-config) with on-disk artifacts
 * to produce a unified, state-classified report. Pure offline — makes no
 * network calls. Pass `now` for deterministic TTL evaluation in tests.
 */
export function buildModelReport(
  repoDir: string,
  opts: { now?: Date; registry?: ModelRegistry } = {},
): ModelReport {
  const now = opts.now ?? new Date();
  const registry = opts.registry ?? getEffectiveRegistry(repoDir);

  // ── Step 1: Collect (provider, model) pairs from configured providers ──────
  const configuredPairs = new Map<string, { provider: string; model: string }>();

  // certificationMode: enumerate all configured models regardless of task-routability
  const configuredEntries = resolveNativeAgentProviders(repoDir, {
    certificationMode: true,
    registry,
  });

  for (const entry of configuredEntries) {
    const key = `${entry.providerName}::${entry.modelId}`;
    configuredPairs.set(key, { provider: entry.providerName, model: entry.modelId });
  }

  // ── Step 2: Collect on-disk artifacts ────────────────────────────────────
  type DiskArtifact = { suiteVersion: string; artifact: import('./schema.ts').NativeCertificationArtifact };
  const artifactsByKey = new Map<string, DiskArtifact[]>();

  for (const artifactPath of listCertifications(repoDir)) {
    const parsed = parseCertificationPath(artifactPath);
    if (!parsed) continue;

    const result = readCertification(artifactPath);
    if (!result.ok) continue;

    const key = `${parsed.provider}::${parsed.model}`;
    const bucket = artifactsByKey.get(key) ?? [];
    bucket.push({ suiteVersion: parsed.suiteVersion, artifact: result.artifact });
    artifactsByKey.set(key, bucket);
  }

  // ── Step 3: Union all (provider, model) pairs ────────────────────────────
  const allKeys = new Set([...configuredPairs.keys(), ...artifactsByKey.keys()]);

  const rows: ModelReportRow[] = [];

  for (const key of allKeys) {
    const configPair = configuredPairs.get(key);
    const diskArtifacts = artifactsByKey.get(key) ?? [];

    let provider: string;
    let model: string;

    if (configPair) {
      provider = configPair.provider;
      model = configPair.model;
    } else {
      // Only known from disk — derive from the first artifact
      const first = diskArtifacts[0];
      if (!first) continue;
      provider = first.artifact.provider;
      model = first.artifact.model;
    }

    rows.push(buildRow(repoDir, provider, model, diskArtifacts, registry, now));
  }

  return {
    generatedAt: now.toISOString(),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Internal: per-row derivation
// ---------------------------------------------------------------------------

function buildRow(
  repoDir: string,
  provider: string,
  model: string,
  diskArtifacts: Array<{ suiteVersion: string; artifact: import('./schema.ts').NativeCertificationArtifact }>,
  registry: ModelRegistry,
  now: Date,
): ModelReportRow {
  const nativeCapability = registry.models[model]?.nativeCapability;
  const capability: ReadOnlyNativeCapability | 'unregistered' = nativeCapability?.readOnlyNative ?? 'unregistered';

  // ── Unsupported: registry has no usable capability ────────────────────────
  if (capability === 'unsupported' || capability === 'unregistered') {
    return {
      provider,
      model,
      state: 'unsupported',
      capability,
      phaseEligibility: { reviewer: false, coder: false, planner: false },
      reason: `Registry capability is "${capability}" — native routing is not supported for this model`,
    };
  }

  // Determine the suite version to use for certification eligibility checks.
  // Prefer the registry's recorded suite version; fall back to the default.
  const registrySuiteVersion = nativeCapability?.certification?.certificationSuiteVersion;
  const suiteVersion = registrySuiteVersion ?? DEFAULT_CERTIFICATION_SUITE_VERSION;

  // ── Evaluate eligibility for the minimum required phase ───────────────────
  const minEligibility = checkCertificationEligibility(
    repoDir,
    provider,
    model,
    suiteVersion,
    'read-only',
    now,
  );

  if (!minEligibility.eligible) {
    const reason = minEligibility.reason;

    if (reason === 'stale') {
      const artifact = minEligibility.artifact;
      const certifiedAt = artifact?.certifiedAt;
      const ageDays = certifiedAt !== undefined ? computeAgeDays(certifiedAt, now) : undefined;

      return {
        provider,
        model,
        state: 'stale',
        capability,
        suiteVersion: artifact?.suiteVersion,
        certifiedAt,
        ageDays,
        maxCertifiedPhase: artifact?.phase,
        knownLimitations: artifact?.knownLimitations,
        phaseEligibility: { reviewer: false, coder: false, planner: false },
        reason: ageDays !== undefined
          ? `Certification is stale (${ageDays} day${ageDays === 1 ? '' : 's'} old; TTL exceeded)`
          : 'Certification has expired (expiresAt exceeded)',
      };
    }

    // missing | malformed | wrong-version | scenario-failure | phase-insufficient
    return {
      provider,
      model,
      state: 'uncertified',
      capability,
      phaseEligibility: { reviewer: false, coder: false, planner: false },
      reason: `Not certified: ${reason}`,
    };
  }

  // ── Valid, fresh certification — evaluate per-role phase eligibility ───────
  const artifact = minEligibility.artifact;

  const coderEligibility = checkCertificationEligibility(repoDir, provider, model, suiteVersion, 'patch', now);
  const plannerEligibility = checkCertificationEligibility(repoDir, provider, model, suiteVersion, 'workflow', now);

  const phaseEligibility: PhaseEligibility = {
    reviewer: true, // minEligibility already confirmed read-only
    coder: coderEligibility.eligible,
    planner: plannerEligibility.eligible,
  };

  const certifiedAt = artifact.certifiedAt;
  const ageDays = computeAgeDays(certifiedAt, now);

  // ── Task routability check (certified vs partial) ──────────────────────────
  const taskDecision = evaluateNativeReadOnlyRouting({
    modelId: model,
    phase: 'planning',
    mode: 'task',
    registry,
  });

  if (!taskDecision.routable) {
    return {
      provider,
      model,
      state: 'certification-only',
      capability,
      suiteVersion: artifact.suiteVersion,
      certifiedAt,
      ageDays,
      maxCertifiedPhase: artifact.phase,
      knownLimitations: artifact.knownLimitations,
      phaseEligibility,
      reason: `Registry capability is "${capability}" — certified for certification runs but not task-routable`,
    };
  }

  return {
    provider,
    model,
    state: 'ready',
    capability,
    suiteVersion: artifact.suiteVersion,
    certifiedAt,
    ageDays,
    maxCertifiedPhase: artifact.phase,
    knownLimitations: artifact.knownLimitations,
    phaseEligibility,
  };
}

function computeAgeDays(certifiedAt: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(certifiedAt).getTime()) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<ModelReportState, string> = {
  ready: 'ready',
  uncertified: 'uncertified',
  stale: 'stale',
  'certification-only': 'cert-only',
  unsupported: 'unsupported',
};

/**
 * Format a ModelReport as an aligned text table for terminal output.
 */
export function formatModelReportText(report: ModelReport): string {
  const lines: string[] = [];
  lines.push(`Model Certification Report  (generated ${report.generatedAt})`);

  if (report.rows.length === 0) {
    lines.push('');
    lines.push('  No native-agent models found (no providers configured and no artifacts on disk).');
    return lines.join('\n');
  }

  lines.push('');

  // Build table data
  const headers = ['PROVIDER', 'MODEL', 'STATE', 'PHASE', 'SUITE', 'AGE', 'REVIEWER', 'CODER', 'PLANNER', 'LIMITATIONS'];

  type Cell = string;
  const tableRows: Cell[][] = report.rows.map((row) => [
    row.provider,
    row.model,
    STATE_LABEL[row.state],
    row.maxCertifiedPhase ?? '-',
    row.suiteVersion ?? '-',
    row.ageDays !== undefined ? `${row.ageDays}d` : '-',
    row.phaseEligibility.reviewer ? 'yes' : 'no',
    row.phaseEligibility.coder ? 'yes' : 'no',
    row.phaseEligibility.planner ? 'yes' : 'no',
    row.knownLimitations && row.knownLimitations.length > 0
      ? row.knownLimitations.join('; ')
      : '-',
  ]);

  // Compute column widths
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...tableRows.map((r) => r[i].length)),
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const sep = colWidths.map((w) => '-'.repeat(w)).join('  ');

  lines.push('  ' + headers.map((h, i) => pad(h, colWidths[i])).join('  '));
  lines.push('  ' + sep);

  for (const row of tableRows) {
    lines.push('  ' + row.map((cell, i) => pad(cell, colWidths[i])).join('  '));
  }

  // Append non-ready reason notes
  const nonReadyRows = report.rows.filter((r) => r.state !== 'ready' && r.reason);
  if (nonReadyRows.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const row of nonReadyRows) {
      lines.push(`  ${row.provider}/${row.model}: ${row.reason}`);
    }
  }

  return lines.join('\n');
}
