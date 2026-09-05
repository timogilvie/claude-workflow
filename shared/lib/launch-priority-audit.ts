import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CertificationPhase } from './native-agent/certification/schema.ts';
import {
  evaluateNativeProviderGate,
  type NativeGateRejectReason,
} from './native-agent/certification/eligibility-gate.ts';
import type {
  LaunchPriorityModel,
  ModelStatus,
  NormalizedCatalog,
  NormalizedCatalogEntry,
  RoleEligibility,
} from './openrouter-catalog.ts';
import { loadLaunchPriorityList } from './openrouter-catalog.ts';
import type { EvalRecord, RoutingRole } from './eval-schema.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { isEvalSuccess } from './eval-success-policy.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import { getEffectiveRegistry, getModel } from './model-registry.ts';
import type { QuotaStatus } from './quota-state.ts';
import { getModelStatus } from './quota-state.ts';
import { partitionEvidence } from './model-evidence-policy.ts';

export type LaunchPriorityRole = RoleEligibility;
export type LaunchPriorityStatus = ModelStatus;
export type BlockerReason =
  | 'not-in-catalog'
  | 'not-available-via-openrouter'
  | 'missing-native-certification'
  | 'quota-exhausted'
  | 'agent-resolution-fails-closed'
  | 'deprecated';
export type CoverageStatus = 'zero-evidence' | 'below-target' | 'at-target';

export interface Blocker {
  reason: BlockerReason;
  role?: LaunchPriorityRole;
  detail?: string;
}

export interface ModelRoleEvidence {
  wavemillAlias: string;
  openrouterId: string;
  family: LaunchPriorityModel['family'];
  launchPriorityStatus: LaunchPriorityStatus;
  priorityTier: number;
  role: LaunchPriorityRole;
  directEvidenceCount: number;
  availablePoolExposureCount: number;
  evalAttempts: number;
  evalSuccesses: number;
  blockers: Blocker[];
  status: CoverageStatus;
}

export interface SamplingPlanEntry {
  wavemillAlias: string;
  openrouterId: string;
  role: LaunchPriorityRole;
  tier: 'zero-evidence-active' | 'zero-evidence-watchlist' | 'below-target';
  reason: string;
  gap: number;
  cost: number | null;
}

export interface LaunchPriorityAudit {
  generatedAt: string;
  schemaVersion: '1';
  coverageTargetPerRole: number;
  models: ModelRoleEvidence[];
  excludedRecords: number;
  exclusionReasonCounts: Record<string, number>;
  zeroEvidence: string[];
  belowTarget: string[];
  samplingPlan: SamplingPlanEntry[];
  summary: {
    totalLaunchPriority: number;
    blockedCount: number;
    sampledCount: number;
    byRole: Record<LaunchPriorityRole, { zero: number; below: number; at: number }>;
  };
}

export interface AuditOptions {
  catalog?: NormalizedCatalog | LaunchPriorityModel[];
  openRouterAvailability?: Set<string>;
  evalRecords?: EvalRecord[];
  evalsPath?: string;
  repoDir?: string;
  coverageTargetPerRole?: number;
  maxAttempts?: number;
  now?: Date;
  nativeCertificationApiKeyPresent?: boolean;
  nativeCertificationApiKeyEnv?: string;
  checkNativeCertification?: (
    provider: string,
    model: string,
    role: LaunchPriorityRole,
  ) => { eligible: boolean; reason?: string };
  quotaStatus?: (modelId: string) => QuotaStatus;
  costOfModel?: (entry: NormalizedCatalogEntry | undefined) => number | null;
}

interface ResolvedLaunchPriorityModel extends LaunchPriorityModel {
  pricingEntry?: NormalizedCatalogEntry;
  catalogBlocker?: {
    reason: 'not-in-catalog';
    detail: string;
  };
}

interface Counter {
  attempts: number;
  successes: number;
}

const AUDIT_SCHEMA_VERSION = '1' as const;
const DEFAULT_COVERAGE_TARGET = 3;
const DEFAULT_MAX_ATTEMPTS = 10;
const ROLE_ORDER: readonly LaunchPriorityRole[] = ['planning', 'coding', 'review'];
const STATUS_ORDER: readonly LaunchPriorityStatus[] = ['active', 'watchlist', 'deprecated'];
const TIER_ORDER = {
  'zero-evidence-active': 0,
  'zero-evidence-watchlist': 1,
  'below-target': 2,
} as const;

function mapRoutingRole(role: RoutingRole): LaunchPriorityRole {
  switch (role) {
    case 'planner':
      return 'planning';
    case 'coder':
      return 'coding';
    case 'reviewer':
      return 'review';
  }
}

function roleIndex(role: LaunchPriorityRole): number {
  return ROLE_ORDER.indexOf(role);
}

function statusIndex(status: LaunchPriorityStatus): number {
  return STATUS_ORDER.indexOf(status);
}

function phaseForRole(role: LaunchPriorityRole): CertificationPhase {
  switch (role) {
    case 'planning':
      return 'workflow';
    case 'coding':
      return 'patch';
    case 'review':
      return 'read-only';
  }
}

function mapAuditGateReason(reason: NativeGateRejectReason): string {
  return reason;
}

function normalizeCoverageStatus(count: number, target: number): CoverageStatus {
  if (count <= 0) {
    return 'zero-evidence';
  }
  if (count < target) {
    return 'below-target';
  }
  return 'at-target';
}

function counterKey(alias: string, role: LaunchPriorityRole): string {
  return `${alias}:${role}`;
}

function getCounter(counters: Map<string, Counter>, alias: string, role: LaunchPriorityRole): Counter {
  const key = counterKey(alias, role);
  const existing = counters.get(key);
  if (existing) {
    return existing;
  }
  const created: Counter = { attempts: 0, successes: 0 };
  counters.set(key, created);
  return created;
}

function resolveModels(
  catalog: NormalizedCatalog | LaunchPriorityModel[] | undefined,
): ResolvedLaunchPriorityModel[] {
  if (!catalog || Array.isArray(catalog)) {
    return (catalog ?? loadLaunchPriorityList()).map((entry) => ({ ...entry }));
  }

  const fallbackList = loadLaunchPriorityList();
  const baseByAlias = new Map<string, LaunchPriorityModel>(
    fallbackList.map((entry) => [entry.wavemillAlias, entry]),
  );
  const models = new Map<string, ResolvedLaunchPriorityModel>();

  for (const entry of catalog.entries) {
    models.set(entry.wavemillAlias, {
      wavemillAlias: entry.wavemillAlias,
      openrouterId: entry.openrouterId,
      family: entry.family,
      status: entry.status,
      priorityTier: entry.priorityTier,
      roleEligibility: [...entry.roleEligibility],
      pricingEntry: entry,
    });
  }

  for (const blocker of catalog.blockers) {
    if (models.has(blocker.wavemillAlias)) {
      continue;
    }
    const base = baseByAlias.get(blocker.wavemillAlias);
    models.set(blocker.wavemillAlias, {
      wavemillAlias: blocker.wavemillAlias,
      openrouterId: blocker.openrouterId,
      family: blocker.family,
      status: blocker.status,
      priorityTier: blocker.priorityTier,
      roleEligibility: base?.roleEligibility ?? [],
      catalogBlocker: blocker.reason === 'not_found_in_openrouter'
        ? { reason: 'not-in-catalog', detail: blocker.detail }
        : undefined,
    });
  }

  return [...models.values()];
}

function resolveIdentifierMap(models: ResolvedLaunchPriorityModel[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const model of models) {
    map.set(model.wavemillAlias, model.wavemillAlias);
    map.set(model.openrouterId, model.wavemillAlias);
  }
  return map;
}

function warnMalformedEvalLines(path: string): void {
  const content = readFileSync(path, 'utf-8');
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      JSON.parse(line);
    } catch {
      console.warn(`Skipping malformed eval JSONL line ${index + 1} in ${path}`);
    }
  }
}

function loadEvalRecords(options: AuditOptions): EvalRecord[] {
  if (options.evalRecords) {
    return options.evalRecords;
  }

  const evalsPath = options.evalsPath
    ?? join(resolveEvalsDir(undefined, options.repoDir).dir, 'evals.jsonl');
  if (!existsSync(evalsPath)) {
    return [];
  }

  warnMalformedEvalLines(evalsPath);
  return readJsonlFile<EvalRecord>(evalsPath);
}

function normalizeAvailableModels(record: EvalRecord): string[] {
  const available = record.taskDescriptor?.constraints?.models_available;
  if (!Array.isArray(available)) {
    return [];
  }
  return [...new Set(available.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function pushRoleAssignment(
  assignments: Map<string, { alias: string; role: LaunchPriorityRole }>,
  alias: string | undefined,
  role: LaunchPriorityRole,
  eligibleRolesByAlias: Map<string, Set<LaunchPriorityRole>>,
): void {
  if (!alias || !eligibleRolesByAlias.get(alias)?.has(role)) {
    return;
  }
  assignments.set(counterKey(alias, role), { alias, role });
}

function buildRoleAssignments(
  record: EvalRecord,
  aliasByIdentifier: Map<string, string>,
  eligibleRolesByAlias: Map<string, Set<LaunchPriorityRole>>,
): Array<{ alias: string; role: LaunchPriorityRole }> {
  const attemptedAlias = typeof record.attempted_model === 'string'
    ? aliasByIdentifier.get(record.attempted_model)
    : undefined;
  const fallbackAlias = attemptedAlias ?? (typeof record.modelId === 'string'
    ? aliasByIdentifier.get(record.modelId)
    : undefined);
  const assignments = new Map<string, { alias: string; role: LaunchPriorityRole }>();
  const routingEntries = Object.entries(record.routing ?? {}) as Array<[RoutingRole, NonNullable<EvalRecord['routing']>[RoutingRole]]>;

  if (routingEntries.length > 0) {
    for (const [routingRole, decision] of routingEntries) {
      if (!decision) {
        continue;
      }
      const role = mapRoutingRole(routingRole);
      pushRoleAssignment(assignments, fallbackAlias, role, eligibleRolesByAlias);
      if (assignments.has(counterKey(fallbackAlias ?? '', role))) {
        continue;
      }
      const resolvedAlias = aliasByIdentifier.get(decision.resolvedModelId);
      pushRoleAssignment(assignments, resolvedAlias, role, eligibleRolesByAlias);
    }
    return [...assignments.values()];
  }

  if (!fallbackAlias) {
    return [];
  }

  for (const role of eligibleRolesByAlias.get(fallbackAlias) ?? []) {
    assignments.set(counterKey(fallbackAlias, role), { alias: fallbackAlias, role });
  }

  return [...assignments.values()];
}

function defaultCostOfModel(entry: NormalizedCatalogEntry | undefined): number | null {
  return entry?.pricing.inputPerMTok ?? null;
}

function toCostEntry(model: ResolvedLaunchPriorityModel): NormalizedCatalogEntry {
  return model.pricingEntry ?? {
    wavemillAlias: model.wavemillAlias,
    openrouterId: model.openrouterId,
    family: model.family,
    contextTokens: null,
    pricing: { inputPerMTok: null, outputPerMTok: null },
    roleEligibility: [...model.roleEligibility],
    status: model.status,
    priorityTier: model.priorityTier,
    resolvedAt: '',
  };
}

export function auditLaunchPriorityCoverage(options: AuditOptions = {}): LaunchPriorityAudit {
  const coverageTargetPerRole = options.coverageTargetPerRole ?? DEFAULT_COVERAGE_TARGET;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const models = resolveModels(options.catalog);
  const aliasByIdentifier = resolveIdentifierMap(models);
  const eligibleRolesByAlias = new Map(
    models.map((model) => [model.wavemillAlias, new Set<LaunchPriorityRole>(model.roleEligibility)]),
  );
  const attemptCounters = new Map<string, Counter>();
  const exposureCounters = new Map<string, number>();
  const evidencePartition = partitionEvidence(loadEvalRecords(options), 'launch_priority_persistence');
  const records = evidencePartition.eligible;
  const registry = getEffectiveRegistry(options.repoDir);
  const quotaStatus = options.quotaStatus ?? ((modelId: string) => getModelStatus(modelId, options.repoDir));
  const costOfModel = options.costOfModel ?? defaultCostOfModel;
  const checkNativeCertification = options.checkNativeCertification
    ?? ((_provider: string, model: string, role: LaunchPriorityRole) => {
      const capability = getModel(registry, model)?.nativeCapability;
      const suiteVersion = capability?.certification?.certificationSuiteVersion;
      if (!suiteVersion) {
        return { eligible: false, reason: mapAuditGateReason('wrong_suite') };
      }
      const decision = evaluateNativeProviderGate({
        modelId: model,
        mode: 'task',
        requiredPhase: phaseForRole(role),
        ...(role === 'coding' ? { launchPhase: 'coding' as const } : {}),
        registry,
        repoDir: options.repoDir,
        apiKeyPresent: options.nativeCertificationApiKeyPresent ?? true,
        apiKeyEnv: options.nativeCertificationApiKeyEnv ?? 'LAUNCH_PRIORITY_AUDIT_CHECK',
        now: options.now,
      });
      return decision.ok
        ? { eligible: true }
        : { eligible: false, reason: decision.message || mapAuditGateReason(decision.reason) };
    });

  for (const record of records) {
    const success = isEvalSuccess(record, { repoDir: options.repoDir });
    for (const { alias, role } of buildRoleAssignments(record, aliasByIdentifier, eligibleRolesByAlias)) {
      const counter = getCounter(attemptCounters, alias, role);
      counter.attempts += 1;
      if (success) {
        counter.successes += 1;
      }
    }

    for (const id of normalizeAvailableModels(record)) {
      const alias = aliasByIdentifier.get(id);
      if (!alias) {
        continue;
      }
      for (const role of eligibleRolesByAlias.get(alias) ?? []) {
        const key = counterKey(alias, role);
        exposureCounters.set(key, (exposureCounters.get(key) ?? 0) + 1);
      }
    }
  }

  const modelEvidence: ModelRoleEvidence[] = [];
  for (const model of models) {
    for (const role of model.roleEligibility) {
      const counter = attemptCounters.get(counterKey(model.wavemillAlias, role)) ?? { attempts: 0, successes: 0 };
      const blockers: Blocker[] = [];
      const registryModel = getModel(registry, model.wavemillAlias);

      if (model.catalogBlocker) {
        blockers.push({ reason: model.catalogBlocker.reason, role, detail: model.catalogBlocker.detail });
      }
      if (model.status === 'deprecated') {
        blockers.push({ reason: 'deprecated', role, detail: `${model.wavemillAlias} is deprecated` });
      }
      if (options.openRouterAvailability && !options.openRouterAvailability.has(model.openrouterId)) {
        blockers.push({
          reason: 'not-available-via-openrouter',
          role,
          detail: `${model.openrouterId} is not reachable via the current OpenRouter pool`,
        });
      }
      if (!registryModel || registryModel.disabled === true) {
        blockers.push({
          reason: 'agent-resolution-fails-closed',
          role,
          detail: `${model.wavemillAlias} is missing or disabled in the active model registry`,
        });
      } else if (
        options.checkNativeCertification
        || (
          registryModel.nativeCapability?.nativeProvider === 'openrouter'
          && registryModel.nativeCapability.certification
        )
      ) {
        const certification = checkNativeCertification('openrouter', model.wavemillAlias, role);
        if (!certification.eligible) {
          blockers.push({
            reason: 'missing-native-certification',
            role,
            detail: certification.reason
              ? `${model.wavemillAlias} lacks ${phaseForRole(role)} certification (${certification.reason})`
              : `${model.wavemillAlias} lacks ${phaseForRole(role)} certification`,
          });
        }
      }
      if (quotaStatus(model.wavemillAlias) === 'exhausted') {
        blockers.push({
          reason: 'quota-exhausted',
          role,
          detail: `${model.wavemillAlias} quota is exhausted`,
        });
      }

      modelEvidence.push({
        wavemillAlias: model.wavemillAlias,
        openrouterId: model.openrouterId,
        family: model.family,
        launchPriorityStatus: model.status,
        priorityTier: model.priorityTier,
        role,
        directEvidenceCount: counter.attempts,
        availablePoolExposureCount: exposureCounters.get(counterKey(model.wavemillAlias, role)) ?? 0,
        evalAttempts: counter.attempts,
        evalSuccesses: counter.successes,
        blockers,
        status: normalizeCoverageStatus(counter.attempts, coverageTargetPerRole),
      });
    }
  }

  modelEvidence.sort((left, right) =>
    left.priorityTier - right.priorityTier
    || statusIndex(left.launchPriorityStatus) - statusIndex(right.launchPriorityStatus)
    || left.wavemillAlias.localeCompare(right.wavemillAlias)
    || roleIndex(left.role) - roleIndex(right.role));

  const evidenceByAlias = new Map<string, ModelRoleEvidence[]>();
  for (const entry of modelEvidence) {
    const existing = evidenceByAlias.get(entry.wavemillAlias);
    if (existing) {
      existing.push(entry);
    } else {
      evidenceByAlias.set(entry.wavemillAlias, [entry]);
    }
  }

  const zeroEvidence = [...evidenceByAlias.entries()]
    .filter(([, entries]) =>
      entries.some((entry) => entry.status === 'zero-evidence')
      && entries.some((entry) => entry.blockers.length === 0))
    .map(([alias]) => alias)
    .sort((left, right) => left.localeCompare(right));

  const zeroEvidenceSet = new Set(zeroEvidence);
  const belowTarget = [...evidenceByAlias.entries()]
    .filter(([alias, entries]) =>
      !zeroEvidenceSet.has(alias)
      && entries.some((entry) => entry.status === 'below-target')
      && entries.some((entry) => entry.blockers.length === 0))
    .map(([alias]) => alias)
    .sort((left, right) => left.localeCompare(right));

  const samplingCandidates = modelEvidence
    .filter((entry) => entry.blockers.length === 0 && entry.status !== 'at-target' && entry.launchPriorityStatus !== 'deprecated')
    .map((entry) => {
      const tier = entry.status === 'zero-evidence'
        ? (entry.launchPriorityStatus === 'active' ? 'zero-evidence-active' : 'zero-evidence-watchlist')
        : 'below-target';
      const gap = Math.max(0, coverageTargetPerRole - entry.directEvidenceCount);
      const resolvedModel = models.find((model) => model.wavemillAlias === entry.wavemillAlias);
      const cost = resolvedModel ? costOfModel(toCostEntry(resolvedModel)) : null;
      return {
        wavemillAlias: entry.wavemillAlias,
        openrouterId: entry.openrouterId,
        role: entry.role,
        tier,
        reason: entry.status === 'zero-evidence'
          ? `${entry.wavemillAlias} has zero direct evidence for ${entry.role}`
          : `${entry.wavemillAlias} is below target for ${entry.role}`,
        gap,
        cost,
      } satisfies SamplingPlanEntry;
    })
    .sort((left, right) =>
      TIER_ORDER[left.tier] - TIER_ORDER[right.tier]
      || (left.cost ?? Number.POSITIVE_INFINITY) - (right.cost ?? Number.POSITIVE_INFINITY)
      || left.wavemillAlias.localeCompare(right.wavemillAlias)
      || roleIndex(left.role) - roleIndex(right.role))
    .slice(0, Math.max(0, maxAttempts));

  const summary: LaunchPriorityAudit['summary'] = {
    totalLaunchPriority: new Set(modelEvidence.map((entry) => entry.wavemillAlias)).size,
    blockedCount: modelEvidence.filter((entry) => entry.blockers.length > 0).length,
    sampledCount: samplingCandidates.length,
    byRole: {
      planning: { zero: 0, below: 0, at: 0 },
      coding: { zero: 0, below: 0, at: 0 },
      review: { zero: 0, below: 0, at: 0 },
    },
  };

  for (const entry of modelEvidence) {
    if (entry.status === 'zero-evidence') {
      summary.byRole[entry.role].zero += 1;
    } else if (entry.status === 'below-target') {
      summary.byRole[entry.role].below += 1;
    } else {
      summary.byRole[entry.role].at += 1;
    }
  }

  return {
    generatedAt,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    coverageTargetPerRole,
    models: modelEvidence,
    excludedRecords: evidencePartition.excluded.length,
    exclusionReasonCounts: evidencePartition.reasonCounts,
    zeroEvidence,
    belowTarget,
    samplingPlan: samplingCandidates,
    summary,
  };
}
