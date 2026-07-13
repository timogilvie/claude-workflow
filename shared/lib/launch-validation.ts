import {
  auditLaunchPriorityCoverage,
  type AuditOptions,
  type Blocker as AuditBlocker,
  type CoverageStatus,
  type LaunchPriorityAudit,
  type LaunchPriorityRole,
  type ModelRoleEvidence,
} from './launch-priority-audit.ts';
import {
  buildCatalogSnapshot,
  hashLaunchPriorityFixture,
  loadLaunchPriorityFixture,
  normalizeCatalog,
  type LaunchPriorityFixture,
  type LaunchPriorityModel,
  type ModelFamily,
  type ModelStatus,
  type NormalizedCatalog,
  type NormalizedCatalogEntry,
  type OpenRouterModel,
} from './openrouter-catalog.ts';
import type { BlockerCategory } from './openrouter-runtime.ts';
import type { SmokeReport } from './openrouter-smoke.ts';

export type LaunchPriorityTrack = 'anchor' | 'target';
export type ValidationStatus = 'covered' | 'blocked' | 'gap';
export type LaunchValidationStatus = 'ok' | 'blocked' | 'failed';

export interface LaunchPriorityProvenance {
  schemaVersion: string;
  sourceHash: string;
  modelCount: number;
  activeWatchlistCount: number;
}

export interface LaunchPriorityModelMetadata extends LaunchPriorityModel {
  track: LaunchPriorityTrack;
  provenance: LaunchPriorityProvenance;
}

export interface LaunchValidationDocumentedBlocker {
  source: 'catalog' | 'audit' | 'smoke';
  code: string;
  detail: string;
  role?: LaunchPriorityRole;
  category?: BlockerCategory;
}

export interface LaunchValidationRoleCoverage {
  role: LaunchPriorityRole;
  directEvidenceCount: number;
  availablePoolExposureCount: number;
  evalAttempts: number;
  evalSuccesses: number;
  evalFailures: number;
  status: CoverageStatus;
  blockers: AuditBlocker[];
}

export interface LaunchValidationModelCoverage {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  track: LaunchPriorityTrack;
  launchPriorityStatus: ModelStatus;
  priorityTier: number;
  roleEligibility: LaunchPriorityRole[];
  smoke:
    | ({ status: 'ok'; costUsd: number | null })
    | ({ status: 'blocker'; category: BlockerCategory; detail: string })
    | ({ status: 'not-run'; reason: 'missing-smoke-report' | 'catalog-blocked' });
  roles: LaunchValidationRoleCoverage[];
  totals: {
    directEvidenceCount: number;
    availablePoolExposureCount: number;
    evalAttempts: number;
    evalSuccesses: number;
    evalFailures: number;
  };
  blockers: LaunchValidationDocumentedBlocker[];
  validationStatus: ValidationStatus;
}

export interface LaunchValidationFamilyCoverage {
  family: Extract<ModelFamily, 'qwen' | 'deepseek' | 'kimi'>;
  lowCostChallenger: {
    wavemillAlias: string;
    openrouterId: string;
    inputCostPerMTok: number | null;
  } | null;
  successfulModels: string[];
  blockedModels: string[];
  status: 'covered' | 'blocked' | 'gap';
}

export interface LaunchValidationDiagnostics {
  coverageTargetPerRole: number;
  overrepresentedAnchors: Array<{
    wavemillAlias: string;
    family: ModelFamily;
    directEvidenceCount: number;
    targetEvidenceCount: number;
    excessEvidenceCount: number;
  }>;
  underSampledTargets: Array<{
    wavemillAlias: string;
    family: ModelFamily;
    launchPriorityStatus: ModelStatus;
    directEvidenceCount: number;
    targetEvidenceCount: number;
    gapEvidenceCount: number;
    zeroEvidenceRoles: LaunchPriorityRole[];
    belowTargetRoles: LaunchPriorityRole[];
  }>;
}

export interface LaunchValidationArtifact {
  schemaVersion: '1';
  generatedAt: string;
  status: LaunchValidationStatus;
  coverageTargetPerRole: number;
  provenance: {
    launchPriorityList: LaunchPriorityProvenance;
    catalogSnapshot: {
      schemaVersion: string;
      generatedAt: string;
      sourceHash: string;
      entryCount: number;
      blockerCount: number;
    };
    smoke: {
      mode: 'fixture' | 'live';
      prompt: string;
    };
  };
  summary: {
    totalModels: number;
    smokeOkCount: number;
    smokeBlockerCount: number;
    documentedBlockerCount: number;
    coveredCount: number;
    blockedCount: number;
    gapCount: number;
    evalAttempts: number;
    evalSuccesses: number;
    evalFailures: number;
    familyCoveredCount: number;
    familyBlockedCount: number;
    familyGapCount: number;
  };
  families: LaunchValidationFamilyCoverage[];
  diagnostics: LaunchValidationDiagnostics;
  models: LaunchValidationModelCoverage[];
}

export interface BuildLaunchValidationArtifactOptions {
  catalogSnapshot: NormalizedCatalog;
  smokeReports: SmokeReport[];
  smokeMode: 'fixture' | 'live';
  smokePrompt?: string;
  launchPriorityFixture?: LaunchPriorityFixture;
  launchPrioritySourceHash?: string;
  audit?: LaunchPriorityAudit;
  auditOptions?: AuditOptions;
  now?: Date;
}

const VALIDATION_SCHEMA_VERSION = '1' as const;
const TARGET_FAMILIES = new Set<LaunchValidationFamilyCoverage['family']>(['qwen', 'deepseek', 'kimi']);

function compareByPriorityAndAlias(
  left: { priorityTier: number; wavemillAlias: string },
  right: { priorityTier: number; wavemillAlias: string },
): number {
  return left.priorityTier - right.priorityTier
    || left.wavemillAlias.localeCompare(right.wavemillAlias);
}

function compareRole(left: LaunchPriorityRole, right: LaunchPriorityRole): number {
  return roleOrder(left) - roleOrder(right);
}

function roleOrder(role: LaunchPriorityRole): number {
  return role === 'planning' ? 0 : role === 'coding' ? 1 : 2;
}

export function classifyLaunchPriorityTrack(family: ModelFamily): LaunchPriorityTrack {
  return family === 'claude' || family === 'gpt' ? 'anchor' : 'target';
}

function getFixtureProvenance(
  fixture: LaunchPriorityFixture,
  sourceHash: string,
): LaunchPriorityProvenance {
  const activeWatchlistCount = fixture.models.filter((model) => model.status !== 'deprecated').length;
  return {
    schemaVersion: fixture.schemaVersion,
    sourceHash,
    modelCount: fixture.models.length,
    activeWatchlistCount,
  };
}

function resolveFixtureAndHash(
  fixture?: LaunchPriorityFixture,
  sourceHash?: string,
): { fixture: LaunchPriorityFixture; sourceHash: string; provenance: LaunchPriorityProvenance } {
  const resolvedFixture = fixture ?? loadLaunchPriorityFixture();
  const resolvedHash = sourceHash ?? hashLaunchPriorityFixture();
  return {
    fixture: resolvedFixture,
    sourceHash: resolvedHash,
    provenance: getFixtureProvenance(resolvedFixture, resolvedHash),
  };
}

export function resolveLaunchPriorityMetadata(
  identifier: string | null | undefined,
  options: { fixture?: LaunchPriorityFixture; sourceHash?: string } = {},
): LaunchPriorityModelMetadata | null {
  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    return null;
  }

  const { fixture, provenance } = resolveFixtureAndHash(options.fixture, options.sourceHash);
  const resolved = fixture.models.find((model) =>
    model.wavemillAlias === identifier || model.openrouterId === identifier);
  if (!resolved) {
    return null;
  }

  return {
    ...resolved,
    track: classifyLaunchPriorityTrack(resolved.family),
    provenance,
  };
}

function createFixtureOpenRouterModel(model: LaunchPriorityModel): OpenRouterModel {
  const familyPricing = {
    claude: { prompt: '0.0000035', completion: '0.000015' },
    gpt: { prompt: '0.0000025', completion: '0.00001' },
    deepseek: { prompt: '0.0000008', completion: '0.000002' },
    glm: { prompt: '0.0000007', completion: '0.0000015' },
    qwen: { prompt: '0.0000006', completion: '0.0000018' },
    kimi: { prompt: '0.0000009', completion: '0.0000022' },
    gemini: { prompt: '0.0000012', completion: '0.000003' },
    llama: { prompt: '0.00000085', completion: '0.0000021' },
    mistral: { prompt: '0.000001', completion: '0.0000025' },
    grok: { prompt: '0.0000015', completion: '0.000004' },
  } satisfies Record<ModelFamily, { prompt: string; completion: string }>;

  return {
    id: model.openrouterId,
    context_length: model.family === 'qwen' || model.family === 'kimi' ? 262_144 : 200_000,
    pricing: familyPricing[model.family],
  };
}

export function buildFixtureCatalogSnapshot(
  options: {
    fixture?: LaunchPriorityFixture;
    sourceHash?: string;
    now?: Date;
  } = {},
): NormalizedCatalog {
  const { fixture, sourceHash } = resolveFixtureAndHash(options.fixture, options.sourceHash);
  const timestamp = (options.now ?? new Date()).toISOString();
  const openRouterModels = new Map<string, OpenRouterModel>();
  for (const model of fixture.models) {
    if (model.status === 'deprecated') {
      continue;
    }
    openRouterModels.set(model.openrouterId, createFixtureOpenRouterModel(model));
  }
  const normalized = normalizeCatalog(fixture.models, openRouterModels, { resolvedAt: timestamp });
  return buildCatalogSnapshot(normalized.entries, normalized.blockers, sourceHash, { generatedAt: timestamp });
}

function makeFallbackRoleCoverage(model: LaunchPriorityModel): LaunchValidationRoleCoverage[] {
  return [...model.roleEligibility]
    .sort(compareRole)
    .map((role) => ({
      role,
      directEvidenceCount: 0,
      availablePoolExposureCount: 0,
      evalAttempts: 0,
      evalSuccesses: 0,
      evalFailures: 0,
      status: 'zero-evidence',
      blockers: [],
    }));
}

function dedupeBlockers(blockers: LaunchValidationDocumentedBlocker[]): LaunchValidationDocumentedBlocker[] {
  const seen = new Set<string>();
  const deduped: LaunchValidationDocumentedBlocker[] = [];
  for (const blocker of blockers) {
    const key = [
      blocker.source,
      blocker.code,
      blocker.role ?? '',
      blocker.category ?? '',
      blocker.detail,
    ].join(':');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(blocker);
  }
  return deduped;
}

function sumCounts(roles: LaunchValidationRoleCoverage[]) {
  return roles.reduce(
    (acc, role) => {
      acc.directEvidenceCount += role.directEvidenceCount;
      acc.availablePoolExposureCount += role.availablePoolExposureCount;
      acc.evalAttempts += role.evalAttempts;
      acc.evalSuccesses += role.evalSuccesses;
      acc.evalFailures += role.evalFailures;
      return acc;
    },
    {
      directEvidenceCount: 0,
      availablePoolExposureCount: 0,
      evalAttempts: 0,
      evalSuccesses: 0,
      evalFailures: 0,
    },
  );
}

function normalizeRoleCoverage(entries: ModelRoleEvidence[] | undefined, model: LaunchPriorityModel): LaunchValidationRoleCoverage[] {
  if (!entries || entries.length === 0) {
    return makeFallbackRoleCoverage(model);
  }

  return [...entries]
    .sort((left, right) => compareRole(left.role, right.role))
    .map((entry) => ({
      role: entry.role,
      directEvidenceCount: entry.directEvidenceCount,
      availablePoolExposureCount: entry.availablePoolExposureCount,
      evalAttempts: entry.evalAttempts,
      evalSuccesses: entry.evalSuccesses,
      evalFailures: Math.max(0, entry.evalAttempts - entry.evalSuccesses),
      status: entry.status,
      blockers: entry.blockers,
    }));
}

function makeSmokeIndex(reports: SmokeReport[]): Map<string, SmokeReport> {
  return new Map(reports.map((report) => [report.modelId, report]));
}

function makeAuditByAlias(audit: LaunchPriorityAudit): Map<string, ModelRoleEvidence[]> {
  const grouped = new Map<string, ModelRoleEvidence[]>();
  for (const row of audit.models) {
    const existing = grouped.get(row.wavemillAlias);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.wavemillAlias, [row]);
    }
  }
  return grouped;
}

function inputCostOf(entry: NormalizedCatalogEntry | undefined): number | null {
  return entry?.pricing.inputPerMTok ?? null;
}

function buildModelCoverage(
  models: LaunchPriorityModel[],
  catalogSnapshot: NormalizedCatalog,
  smokeReports: SmokeReport[],
  audit: LaunchPriorityAudit,
  provenance: LaunchPriorityProvenance,
): LaunchValidationModelCoverage[] {
  const auditByAlias = makeAuditByAlias(audit);
  const smokeByAlias = makeSmokeIndex(smokeReports);
  const catalogBlockersByAlias = new Map<string, NormalizedCatalog['blockers'][number][]>();
  for (const blocker of catalogSnapshot.blockers) {
    const existing = catalogBlockersByAlias.get(blocker.wavemillAlias);
    if (existing) {
      existing.push(blocker);
    } else {
      catalogBlockersByAlias.set(blocker.wavemillAlias, [blocker]);
    }
  }

  return [...models]
    .sort(compareByPriorityAndAlias)
    .map((model) => {
      const roleCoverage = normalizeRoleCoverage(auditByAlias.get(model.wavemillAlias), model);
      const totals = sumCounts(roleCoverage);
      const smoke = smokeByAlias.get(model.wavemillAlias);
      const blockers: LaunchValidationDocumentedBlocker[] = [];

      for (const blocker of catalogBlockersByAlias.get(model.wavemillAlias) ?? []) {
        blockers.push({
          source: 'catalog',
          code: blocker.reason,
          detail: blocker.detail,
        });
      }
      for (const role of roleCoverage) {
        for (const blocker of role.blockers) {
          blockers.push({
            source: 'audit',
            code: blocker.reason,
            detail: blocker.detail ?? blocker.reason,
            role: blocker.role ?? role.role,
          });
        }
      }
      if (smoke?.status === 'blocker') {
        blockers.push({
          source: 'smoke',
          code: smoke.category ?? 'unknown',
          detail: smoke.detail ?? smoke.category ?? 'smoke blocker',
          category: smoke.category,
        });
      }

      const documentedBlockers = dedupeBlockers(blockers);
      const smokeStatus: LaunchValidationModelCoverage['smoke'] = smoke
        ? (smoke.status === 'ok'
          ? { status: 'ok', costUsd: smoke.costUsd ?? null }
          : {
            status: 'blocker',
            category: smoke.category ?? 'provider_unavailable',
            detail: smoke.detail ?? 'OpenRouter smoke blocked',
          })
        : {
          status: documentedBlockers.some((blocker) => blocker.source === 'catalog')
            ? 'not-run'
            : 'not-run',
          reason: documentedBlockers.some((blocker) => blocker.source === 'catalog')
            ? 'catalog-blocked'
            : 'missing-smoke-report',
        };

      let validationStatus: ValidationStatus;
      if (smoke?.status === 'ok' || totals.directEvidenceCount > 0) {
        validationStatus = 'covered';
      } else if (documentedBlockers.length > 0) {
        validationStatus = 'blocked';
      } else {
        validationStatus = 'gap';
      }

      return {
        wavemillAlias: model.wavemillAlias,
        openrouterId: model.openrouterId,
        family: model.family,
        track: classifyLaunchPriorityTrack(model.family),
        launchPriorityStatus: model.status,
        priorityTier: model.priorityTier,
        roleEligibility: [...model.roleEligibility].sort(compareRole),
        smoke: smokeStatus,
        roles: roleCoverage,
        totals,
        blockers: documentedBlockers,
        validationStatus,
        provenance,
      } as LaunchValidationModelCoverage & { provenance: LaunchPriorityProvenance };
    })
    .map(({ provenance: _provenance, ...model }) => model);
}

function buildFamilyCoverage(
  models: LaunchValidationModelCoverage[],
  catalogSnapshot: NormalizedCatalog,
): LaunchValidationFamilyCoverage[] {
  const catalogEntries = new Map(catalogSnapshot.entries.map((entry) => [entry.wavemillAlias, entry]));
  return [...TARGET_FAMILIES]
    .map((family) => {
      const familyModels = models.filter((model) => model.family === family);
      const lowCost = [...familyModels]
        .sort((left, right) => {
          const leftCost = inputCostOf(catalogEntries.get(left.wavemillAlias));
          const rightCost = inputCostOf(catalogEntries.get(right.wavemillAlias));
          return (leftCost ?? Number.POSITIVE_INFINITY) - (rightCost ?? Number.POSITIVE_INFINITY)
            || left.priorityTier - right.priorityTier
            || left.wavemillAlias.localeCompare(right.wavemillAlias);
        })[0];
      const successfulModels = familyModels
        .filter((model) => model.totals.evalSuccesses > 0)
        .map((model) => model.wavemillAlias)
        .sort((left, right) => left.localeCompare(right));
      const blockedModels = familyModels
        .filter((model) => model.validationStatus === 'blocked')
        .map((model) => model.wavemillAlias)
        .sort((left, right) => left.localeCompare(right));

      let status: LaunchValidationFamilyCoverage['status'];
      if (successfulModels.length > 0) {
        status = 'covered';
      } else if (familyModels.length > 0 && familyModels.every((model) => model.blockers.length > 0)) {
        status = 'blocked';
      } else {
        status = 'gap';
      }

      return {
        family,
        lowCostChallenger: lowCost
          ? {
            wavemillAlias: lowCost.wavemillAlias,
            openrouterId: lowCost.openrouterId,
            inputCostPerMTok: inputCostOf(catalogEntries.get(lowCost.wavemillAlias)),
          }
          : null,
        successfulModels,
        blockedModels,
        status,
      };
    })
    .sort((left, right) => left.family.localeCompare(right.family));
}

function buildDiagnostics(
  models: LaunchValidationModelCoverage[],
  coverageTargetPerRole: number,
): LaunchValidationDiagnostics {
  const overrepresentedAnchors = models
    .filter((model) => model.track === 'anchor')
    .map((model) => {
      const targetEvidenceCount = coverageTargetPerRole * model.roleEligibility.length;
      return {
        wavemillAlias: model.wavemillAlias,
        family: model.family,
        directEvidenceCount: model.totals.directEvidenceCount,
        targetEvidenceCount,
        excessEvidenceCount: Math.max(0, model.totals.directEvidenceCount - targetEvidenceCount),
      };
    })
    .filter((model) => model.excessEvidenceCount > 0)
    .sort((left, right) =>
      right.excessEvidenceCount - left.excessEvidenceCount
      || right.directEvidenceCount - left.directEvidenceCount
      || left.wavemillAlias.localeCompare(right.wavemillAlias));

  const underSampledTargets = models
    .filter((model) => model.track === 'target' && model.validationStatus !== 'blocked')
    .map((model) => {
      const targetEvidenceCount = coverageTargetPerRole * model.roleEligibility.length;
      const zeroEvidenceRoles = model.roles
        .filter((role) => role.status === 'zero-evidence')
        .map((role) => role.role);
      const belowTargetRoles = model.roles
        .filter((role) => role.status === 'below-target')
        .map((role) => role.role);
      return {
        wavemillAlias: model.wavemillAlias,
        family: model.family,
        launchPriorityStatus: model.launchPriorityStatus,
        directEvidenceCount: model.totals.directEvidenceCount,
        targetEvidenceCount,
        gapEvidenceCount: Math.max(0, targetEvidenceCount - model.totals.directEvidenceCount),
        zeroEvidenceRoles,
        belowTargetRoles,
      };
    })
    .filter((model) => model.zeroEvidenceRoles.length > 0 || model.belowTargetRoles.length > 0)
    .sort((left, right) =>
      right.gapEvidenceCount - left.gapEvidenceCount
      || left.wavemillAlias.localeCompare(right.wavemillAlias));

  return {
    coverageTargetPerRole,
    overrepresentedAnchors,
    underSampledTargets,
  };
}

export function buildLaunchValidationArtifact(
  options: BuildLaunchValidationArtifactOptions,
): LaunchValidationArtifact {
  const { fixture, sourceHash, provenance } = resolveFixtureAndHash(
    options.launchPriorityFixture,
    options.launchPrioritySourceHash,
  );
  const scopedModels = fixture.models.filter((model) => model.status !== 'deprecated');
  const audit = options.audit ?? auditLaunchPriorityCoverage({
    ...options.auditOptions,
    catalog: options.catalogSnapshot,
    now: options.now,
  });
  const generatedAt = (options.now ?? new Date()).toISOString();
  const models = buildModelCoverage(
    scopedModels,
    options.catalogSnapshot,
    options.smokeReports,
    audit,
    provenance,
  );
  const families = buildFamilyCoverage(models, options.catalogSnapshot);
  const diagnostics = buildDiagnostics(models, audit.coverageTargetPerRole);
  const smokeOkCount = models.filter((model) => model.smoke.status === 'ok').length;
  const smokeBlockerCount = models.filter((model) => model.smoke.status === 'blocker').length;
  const documentedBlockerCount = models.reduce((sum, model) => sum + model.blockers.length, 0);
  const coveredCount = models.filter((model) => model.validationStatus === 'covered').length;
  const blockedCount = models.filter((model) => model.validationStatus === 'blocked').length;
  const gapCount = models.filter((model) => model.validationStatus === 'gap').length;
  const evalTotals = models.reduce(
    (acc, model) => {
      acc.attempts += model.totals.evalAttempts;
      acc.successes += model.totals.evalSuccesses;
      acc.failures += model.totals.evalFailures;
      return acc;
    },
    { attempts: 0, successes: 0, failures: 0 },
  );
  const familyCoveredCount = families.filter((family) => family.status === 'covered').length;
  const familyBlockedCount = families.filter((family) => family.status === 'blocked').length;
  const familyGapCount = families.filter((family) => family.status === 'gap').length;

  let status: LaunchValidationStatus;
  if (gapCount > 0 || familyGapCount > 0) {
    status = 'failed';
  } else if (blockedCount > 0 || familyBlockedCount > 0) {
    status = 'blocked';
  } else {
    status = 'ok';
  }

  return {
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    generatedAt,
    status,
    coverageTargetPerRole: audit.coverageTargetPerRole,
    provenance: {
      launchPriorityList: provenance,
      catalogSnapshot: {
        schemaVersion: options.catalogSnapshot.schemaVersion,
        generatedAt: options.catalogSnapshot.generatedAt,
        sourceHash: options.catalogSnapshot.sourceHash,
        entryCount: options.catalogSnapshot.entries.length,
        blockerCount: options.catalogSnapshot.blockers.length,
      },
      smoke: {
        mode: options.smokeMode,
        prompt: options.smokePrompt ?? 'ping',
      },
    },
    summary: {
      totalModels: models.length,
      smokeOkCount,
      smokeBlockerCount,
      documentedBlockerCount,
      coveredCount,
      blockedCount,
      gapCount,
      evalAttempts: evalTotals.attempts,
      evalSuccesses: evalTotals.successes,
      evalFailures: evalTotals.failures,
      familyCoveredCount,
      familyBlockedCount,
      familyGapCount,
    },
    families,
    diagnostics,
    models,
  };
}

export function summarizeLaunchValidationStatus(artifact: LaunchValidationArtifact): string {
  return `status=${artifact.status} models=${artifact.summary.totalModels} `
    + `covered=${artifact.summary.coveredCount} blocked=${artifact.summary.blockedCount} `
    + `gaps=${artifact.summary.gapCount} families=${artifact.summary.familyCoveredCount}/`
    + `${artifact.summary.familyBlockedCount}/${artifact.summary.familyGapCount}`;
}
