/**
 * Model certification status reporting.
 *
 * Reads purely from the model registry and on-disk certification artifacts.
 * Never triggers live provider calls. Suitable for CI status dashboards and
 * operator tooling.
 *
 * @module native-agent/certification/report
 */

import {
  phaseSatisfies,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from './schema.ts';
import { evaluateEligibility, loadCertification, loadGlobalCertification } from './loader.ts';
import { STAGE_PHASE_REQUIREMENT, type RouterRole } from './router-filter.ts';
import { getEffectiveRegistry, type ModelRegistry, type ReadOnlyNativeCapability } from '../../model-registry.ts';
import { resolveCertificationStorageIdentity } from './identity.ts';
import { checkIdentity } from './validator.ts';
import { findModelExclusion, type ModelExclusionDiagnostic } from '../../model-exclusions.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getNativePatchCodingConfig } from '../../config.ts';
import { PATCH_CODING_CERTIFICATION_RELATIVE_PATH } from '../coding-certification.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Operator-facing certification state for a single model. */
export type ModelCertificationState =
  | 'ready'
  | 'uncertified'
  | 'stale'
  | 'unsupported'
  | 'certification-only';

/** Outcome of a single scenario from the on-disk artifact. */
export interface ScenarioOutcome {
  scenarioId: string;
  passed: boolean;
  failureMessage?: string;
}

/** One row of the model certification report. */
export interface ModelCertificationReportRow {
  provider: string;
  model: string;
  /** Raw `readOnlyNative` value from the registry. */
  native: ReadOnlyNativeCapability;
  state: ModelCertificationState;
  /** Certified phase from the best available certification. */
  certifiedPhase?: CertificationPhase;
  /** Router roles for which the model is eligible to run. */
  eligibleStages: RouterRole[];
  /** Suite version from the best available certification. */
  suiteVersion?: string;
  /** ISO 8601 datetime of certification. */
  certifiedAt?: string;
  /** Age of certification in days (from certifiedAt to now). */
  ageDays?: number;
  /** Deduplicated known limitations from registry + artifact. */
  knownLimitations: string[];
  /** Per-scenario outcomes from the on-disk artifact. */
  scenarios: ScenarioOutcome[];
  globalCertification: {
    state: ModelCertificationState;
    artifactPath?: string;
    storageScope?: 'global' | 'legacy-repo';
  };
  localReadiness: Partial<Record<RouterRole, { ready: boolean; reasons: string[] }>>;
  exclusion?: ModelExclusionDiagnostic;
}

// ---------------------------------------------------------------------------
// Report options
// ---------------------------------------------------------------------------

export interface BuildModelCertificationReportOptions {
  /** Repository root for loading on-disk certification artifacts. */
  repoDir?: string;
  /** Registry to use. Defaults to the effective registry for repoDir. */
  registry?: ModelRegistry;
  /** Current time for TTL evaluation. Defaults to `new Date()`. */
  now?: Date;
  /**
   * Injectable load function for testing — same signature as
   * `loadCertification` from ./loader.ts.
   */
  loadCertificationFn?: typeof loadCertification;
  /** Optional provider filter. Only rows matching this provider are returned. */
  provider?: string;
  /** Optional model filter. Only rows matching this model ID are returned. */
  model?: string;
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Build a certification report for all native-capable models in the registry.
 *
 * Reads from the registry and on-disk artifacts only — no live provider calls.
 * Rows are sorted by (provider, model).
 */
export function buildModelCertificationReport(
  opts: BuildModelCertificationReportOptions = {},
): ModelCertificationReportRow[] {
  const repoDir = opts.repoDir ?? process.cwd();
  const registry = opts.registry ?? getEffectiveRegistry(repoDir);
  const now = opts.now ?? new Date();
  const loadCertFn = opts.loadCertificationFn ?? loadCertification;

  const rows: ModelCertificationReportRow[] = [];

  for (const [modelId, capabilities] of Object.entries(registry.models)) {
    const nativeCapability = capabilities.nativeCapability;
    if (!nativeCapability) continue;

    // Apply optional filters
    if (opts.provider && nativeCapability.nativeProvider !== opts.provider) continue;
    if (opts.model && modelId !== opts.model) continue;

    const readOnlyNative = nativeCapability.readOnlyNative;

    // Unsupported — short-circuit before disk access
    if (readOnlyNative === 'unsupported') {
      rows.push({
        provider: nativeCapability.nativeProvider,
        model: modelId,
        native: readOnlyNative,
        state: 'unsupported',
        eligibleStages: [],
        knownLimitations: flattenLimitations([nativeCapability.limitations]),
        scenarios: [],
        globalCertification: { state: 'unsupported' },
        localReadiness: buildLocalReadiness(repoDir, []),
        ...(findModelExclusion(modelId, 'coding', repoDir) ? { exclusion: findModelExclusion(modelId, 'coding', repoDir) } : {}),
      });
      continue;
    }

    // Partial — routable only in certification mode
    if (readOnlyNative === 'partial') {
      const registryMeta = nativeCapability.certification;
      rows.push({
        provider: nativeCapability.nativeProvider,
        model: modelId,
        native: readOnlyNative,
        state: 'certification-only',
        certifiedPhase: registryMeta?.maxCertifiedPhase,
        eligibleStages: [],
        suiteVersion: registryMeta?.certificationSuiteVersion,
        certifiedAt: registryMeta?.certifiedAt,
        ageDays: registryMeta?.certifiedAt ? computeAgeDays(registryMeta.certifiedAt, now) : undefined,
        knownLimitations: flattenLimitations([nativeCapability.limitations, registryMeta?.knownLimitations]),
        scenarios: [],
        globalCertification: { state: 'certification-only' },
        localReadiness: buildLocalReadiness(repoDir, []),
        ...(findModelExclusion(modelId, 'coding', repoDir) ? { exclusion: findModelExclusion(modelId, 'coding', repoDir) } : {}),
      });
      continue;
    }

    // Certified — determine state from on-disk artifact only so the report
    // matches provider-resolution fail-closed semantics.
    const certMeta = nativeCapability.certification;

    if (!certMeta) {
      rows.push({
        provider: nativeCapability.nativeProvider,
        model: modelId,
        native: readOnlyNative,
        state: 'uncertified',
        eligibleStages: [],
        knownLimitations: flattenLimitations([nativeCapability.limitations]),
        scenarios: [],
        globalCertification: { state: 'uncertified' },
        localReadiness: buildLocalReadiness(repoDir, []),
        ...(findModelExclusion(modelId, 'coding', repoDir) ? { exclusion: findModelExclusion(modelId, 'coding', repoDir) } : {}),
      });
      continue;
    }

    // Try loading the global on-disk artifact. Explicit injected loaders are
    // reserved for compatibility tests and migration tooling.
    const loaded = opts.loadCertificationFn
      ? loadCertFn(repoDir, nativeCapability.nativeProvider, modelId, certMeta.certificationSuiteVersion)
      : loadGlobalCertification(nativeCapability.nativeProvider, modelId, certMeta.certificationSuiteVersion);

    if (!loaded.ok) {
      rows.push({
        provider: nativeCapability.nativeProvider,
        model: modelId,
        native: readOnlyNative,
        state: 'uncertified',
        eligibleStages: [],
        suiteVersion: certMeta.certificationSuiteVersion,
        knownLimitations: flattenLimitations([nativeCapability.limitations, certMeta.knownLimitations]),
        scenarios: [],
        globalCertification: {
          state: 'uncertified',
          ...(getLoadedPath(loaded) ? { artifactPath: getLoadedPath(loaded) } : {}),
          ...(getLoadedScope(loaded) ? { storageScope: getLoadedScope(loaded) } : {}),
        },
        localReadiness: buildLocalReadiness(repoDir, []),
        ...(findModelExclusion(modelId, 'coding', repoDir) ? { exclusion: findModelExclusion(modelId, 'coding', repoDir) } : {}),
      });
      continue;
    }

    const storageIdentity = resolveCertificationStorageIdentity(nativeCapability.nativeProvider, modelId);
    const identityError = checkIdentity(
      loaded.artifact,
      storageIdentity.provider,
      storageIdentity.model,
    );
    if (identityError) {
      rows.push(withReadiness(rowFromArtifactState(
        nativeCapability.nativeProvider,
        modelId,
        readOnlyNative,
        loaded.artifact,
        'uncertified',
        now,
        flattenLimitations([nativeCapability.limitations, certMeta.knownLimitations]),
      ), repoDir, [], 'uncertified', getLoadedPath(loaded), getLoadedScope(loaded), findModelExclusion(modelId, 'coding', repoDir)));
      continue;
    }

    const eligibility = evaluateEligibility(
      loaded.artifact,
      certMeta.certificationSuiteVersion,
      'read-only',
      now,
    );
    if (eligibility.eligible) {
      const row = rowFromArtifact(
        nativeCapability.nativeProvider,
        modelId,
        readOnlyNative,
        loaded.artifact,
        now,
        flattenLimitations([nativeCapability.limitations, certMeta.knownLimitations]),
      );
      rows.push(withReadiness(row, repoDir, row.eligibleStages, 'ready', getLoadedPath(loaded), getLoadedScope(loaded), findModelExclusion(modelId, 'coding', repoDir)));
      continue;
    }

    const row = rowFromArtifactState(
      nativeCapability.nativeProvider,
      modelId,
      readOnlyNative,
      loaded.artifact,
      eligibility.reason === 'stale' ? 'stale' : 'uncertified',
      now,
      flattenLimitations([nativeCapability.limitations, certMeta.knownLimitations]),
    );
    rows.push(withReadiness(
      row,
      repoDir,
      [],
      row.state,
      getLoadedPath(loaded),
      getLoadedScope(loaded),
      findModelExclusion(modelId, 'coding', repoDir),
    ));
  }

  rows.sort((a, b) => {
    const providerCmp = a.provider.localeCompare(b.provider);
    return providerCmp !== 0 ? providerCmp : a.model.localeCompare(b.model);
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function rowFromArtifact(
  provider: string,
  model: string,
  native: ReadOnlyNativeCapability,
  artifact: NativeCertificationArtifact,
  now: Date,
  registryLimitations: string[],
): ModelCertificationReportRow {
  return rowFromArtifactState(provider, model, native, artifact, 'ready', now, registryLimitations);
}

function rowFromArtifactState(
  provider: string,
  model: string,
  native: ReadOnlyNativeCapability,
  artifact: NativeCertificationArtifact,
  state: Extract<ModelCertificationState, 'ready' | 'stale' | 'uncertified'>,
  now: Date,
  registryLimitations: string[],
): ModelCertificationReportRow {
  const artLimitations = artifact.knownLimitations ?? [];
  const knownLimitations = deduplicateStrings([...registryLimitations, ...artLimitations]);
  const scenarios: ScenarioOutcome[] = artifact.scenarios.map(s => ({
    scenarioId: s.scenarioId,
    passed: s.passed,
    ...(s.failureMessage ? { failureMessage: s.failureMessage } : {}),
  }));
  const ageDays = computeAgeDays(artifact.certifiedAt, now);
  const eligibleStages = state === 'ready' ? computeEligibleStages(artifact.phase) : [];

  return {
    provider, model, native,
    state: state === 'ready' && eligibleStages.length === 0 ? 'uncertified' : state,
    certifiedPhase: artifact.phase,
    eligibleStages,
    suiteVersion: artifact.suiteVersion,
    certifiedAt: artifact.certifiedAt,
    ageDays,
    knownLimitations,
    scenarios,
    globalCertification: { state },
    localReadiness: {},
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedReport {
  schemaVersion: 1;
  generatedAt: string;
  models: ModelCertificationReportRow[];
}

/**
 * Serialize the report to a stable JSON-serializable object.
 *
 * Rows are sorted by (provider, model). `generatedAt` is derived from `now`
 * (inject via `buildModelCertificationReport({ now })` for stable snapshots).
 */
export function serializeReport(
  rows: ModelCertificationReportRow[],
  now: Date = new Date(),
): SerializedReport {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    models: rows,
  };
}

// ---------------------------------------------------------------------------
// Human-readable table
// ---------------------------------------------------------------------------

const COLUMN_HEADERS = ['Provider', 'Model', 'State', 'Local Ready', 'Eligible Stages', 'Suite', 'Age (days)', 'Exclusion', 'Limitations'] as const;

/**
 * Render the report as a human-readable table.
 */
export function renderReportTable(rows: ModelCertificationReportRow[]): string {
  if (rows.length === 0) {
    return 'No native-capable models found in the registry.\n';
  }

  const dataRows: string[][] = rows.map(row => [
    row.provider,
    row.model,
    row.globalCertification.storageScope
      ? `${row.globalCertification.state} (${row.globalCertification.storageScope})`
      : row.globalCertification.state,
    summarizeLocalReadiness(row),
    row.eligibleStages.length > 0 ? row.eligibleStages.join(', ') : '—',
    row.suiteVersion ?? '—',
    row.ageDays !== undefined ? String(row.ageDays) : '—',
    row.exclusion
      ? `${row.exclusion.source}${row.exclusion.reason ? `: ${row.exclusion.reason}` : ''}`
      : '—',
    row.knownLimitations.length > 0 ? row.knownLimitations.join('; ') : '—',
  ]);

  const allRows = [Array.from(COLUMN_HEADERS), ...dataRows];
  const colWidths = COLUMN_HEADERS.map((_, colIdx) =>
    Math.max(...allRows.map(row => (row[colIdx] ?? '').length)),
  );

  const separator = colWidths.map(w => '-'.repeat(w + 2)).join('+');
  const lines: string[] = [separator];

  for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
    const row = allRows[rowIdx];
    const line = row.map((cell, colIdx) => ` ${cell.padEnd(colWidths[colIdx])} `).join('|');
    lines.push(`|${line}|`);
    if (rowIdx === 0) lines.push(separator);
  }

  lines.push(separator);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_ROLES: RouterRole[] = ['reviewer', 'coder', 'planner'];

function computeEligibleStages(certifiedPhase: CertificationPhase): RouterRole[] {
  return ALL_ROLES.filter(role => phaseSatisfies(certifiedPhase, STAGE_PHASE_REQUIREMENT[role]));
}

function computeAgeDays(certifiedAt: string, now: Date): number {
  const ms = now.getTime() - Date.parse(certifiedAt);
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function flattenLimitations(sources: (string[] | undefined)[]): string[] {
  return deduplicateStrings(sources.flatMap(s => s ?? []));
}

function deduplicateStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function summarizeLocalReadiness(row: ModelCertificationReportRow): string {
  const ready = Object.entries(row.localReadiness)
    .filter(([, state]) => state.ready)
    .map(([role]) => role);
  return ready.length > 0 ? ready.join(', ') : '—';
}

function getLoadedPath(loaded: unknown): string | undefined {
  return typeof loaded === 'object'
    && loaded !== null
    && 'path' in loaded
    && typeof (loaded as { path?: unknown }).path === 'string'
    ? (loaded as { path: string }).path
    : undefined;
}

function getLoadedScope(loaded: unknown): 'global' | 'legacy-repo' | undefined {
  return typeof loaded === 'object'
    && loaded !== null
    && 'scope' in loaded
    && ((loaded as { scope?: unknown }).scope === 'global' || (loaded as { scope?: unknown }).scope === 'legacy-repo')
    ? (loaded as { scope: 'global' | 'legacy-repo' }).scope
    : undefined;
}

function withReadiness(
  row: ModelCertificationReportRow,
  repoDir: string,
  eligibleStages: RouterRole[],
  certificationState: ModelCertificationState,
  artifactPath?: string,
  storageScope?: 'global' | 'legacy-repo',
  exclusion?: ModelExclusionDiagnostic,
): ModelCertificationReportRow {
  return {
    ...row,
    globalCertification: {
      state: certificationState,
      ...(artifactPath ? { artifactPath } : {}),
      ...(storageScope ? { storageScope } : {}),
    },
    localReadiness: buildLocalReadiness(repoDir, eligibleStages),
    ...(exclusion ? { exclusion } : {}),
  };
}

function buildLocalReadiness(
  repoDir: string,
  eligibleStages: RouterRole[],
): Partial<Record<RouterRole, { ready: boolean; reasons: string[] }>> {
  const readiness: Partial<Record<RouterRole, { ready: boolean; reasons: string[] }>> = {};
  const patchCodingConfig = getNativePatchCodingConfig(repoDir);
  const patchCertificationPresent = existsSync(join(repoDir, PATCH_CODING_CERTIFICATION_RELATIVE_PATH));
  const hasCodingLauncher = existsSync(join(repoDir, 'tools', 'launch-native-coding.ts'));

  for (const role of ALL_ROLES) {
    const reasons: string[] = [];
    if (!eligibleStages.includes(role)) {
      reasons.push('global certification not eligible for stage');
    }
    if (role === 'coder') {
      if (patchCodingConfig.enabled !== true) reasons.push('local patch-coding readiness disabled');
      if (!patchCertificationPresent) reasons.push('local patch-coding certification missing');
      if (!hasCodingLauncher) reasons.push('local native coding launcher missing');
    }
    readiness[role] = {
      ready: reasons.length === 0,
      reasons,
    };
  }
  return readiness;
}
