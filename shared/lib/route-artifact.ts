import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getMaxCostUsd } from './config.ts';
import { getEffectiveRegistry, getModel } from './model-registry.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

export type RouteSource =
  | 'bootstrap'
  | 'expanded'
  | 'startup-cache'
  | 'batch-cache'
  | 'live'
  | 'heuristic-fallback';

export type RouteInputKind = 'issue' | 'task-packet' | 'cache' | 'heuristic';

export interface RouteProvenance {
  source: RouteSource;
  inputKind: RouteInputKind;
  inputPath: string;
  inputHash: string;
  routedAt: string;
  routerMode: 'normal' | 'constrained' | 'survival';
}

export interface RouteDecisionWithProvenance extends WorkflowRouteDecision {
  provenance?: RouteProvenance;
  cache_hit?: boolean;
  route_source?: 'batch' | 'single' | 'cache';
  packet_hash?: string;
}

function isFiniteNonNegativeBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export interface ResolveRouteBudgetOptions {
  explicitMaxCostUsd?: number;
  repoDir?: string;
}

export function resolveRouteDecisionBudget(
  decision: Partial<WorkflowRouteDecision>,
  options: ResolveRouteBudgetOptions = {},
): number | null {
  if (isFiniteNonNegativeBudget(options.explicitMaxCostUsd)) {
    return options.explicitMaxCostUsd;
  }
  if (isFiniteNonNegativeBudget(decision.constraints?.maxCostUsd)) {
    return decision.constraints.maxCostUsd;
  }
  if (isFiniteNonNegativeBudget(decision.maxCostUsd)) {
    return decision.maxCostUsd;
  }

  const configured = getMaxCostUsd(options.repoDir);
  return isFiniteNonNegativeBudget(configured) ? configured : null;
}

export function withResolvedRouteBudget<T extends WorkflowRouteDecision>(
  decision: T,
  options: ResolveRouteBudgetOptions = {},
): T {
  const maxCostUsd = resolveRouteDecisionBudget(decision, options);
  if (maxCostUsd === null) {
    return {
      ...decision,
      maxCostUsd: null,
    };
  }

  return {
    ...decision,
    constraints: {
      ...(decision.constraints ?? {}),
      maxCostUsd,
    },
    maxCostUsd,
  };
}

export interface BuildRouteProvenanceParams {
  source: RouteSource;
  inputKind: RouteInputKind;
  inputPath?: string;
  inputBytes?: string | Buffer;
  routerMode: 'normal' | 'constrained' | 'survival';
  routedAt?: string;
}

export function buildRouteProvenance(params: BuildRouteProvenanceParams): RouteProvenance {
  const hasInputBytes = typeof params.inputBytes !== 'undefined';
  const isHeuristicFallbackWithoutInput = params.source === 'heuristic-fallback' && !hasInputBytes;
  const bytes = hasInputBytes
    ? (Buffer.isBuffer(params.inputBytes) ? params.inputBytes : Buffer.from(params.inputBytes, 'utf-8'))
    : null;

  return {
    source: params.source,
    inputKind: isHeuristicFallbackWithoutInput ? 'heuristic' : params.inputKind,
    inputPath: isHeuristicFallbackWithoutInput ? '' : (params.inputPath || ''),
    inputHash: bytes ? createHash('sha256').update(bytes).digest('hex') : '',
    routedAt: params.routedAt || new Date().toISOString(),
    routerMode: params.routerMode,
  };
}

export function withRouteProvenance<T extends WorkflowRouteDecision>(decision: T, provenance: RouteProvenance): T & {
  provenance: RouteProvenance;
} {
  return {
    ...decision,
    provenance,
  };
}

export function withExpandedRouteMetadata<T extends WorkflowRouteDecision>(
  decision: T,
  metadata: Pick<RouteDecisionWithProvenance, 'cache_hit' | 'route_source' | 'packet_hash'>,
): T & Pick<RouteDecisionWithProvenance, 'cache_hit' | 'route_source' | 'packet_hash'> {
  return {
    ...decision,
    ...metadata,
  };
}

export function stringifyRouteArtifact(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string') {
    throw new TypeError('Route artifact must serialize to a JSON document');
  }

  JSON.parse(serialized);
  return `${serialized}\n`;
}

export function writeRouteArtifact(path: string, value: unknown): void {
  const tmpPath = join(dirname(path), `.tmp-route-artifact-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    writeFileSync(tmpPath, stringifyRouteArtifact(value), 'utf-8');
    renameSync(tmpPath, path);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export interface NormalizedExpandedRouteArtifact {
  coder: string;
  codeDepth: string;
  reviewer: string;
  reviewMode: string;
}

export type RouteArtifactRouterMode = 'normal' | 'constrained' | 'survival';
export type RouteArtifactBatchSource = 'batch' | 'single' | 'cache';

export interface RouteArtifactSnapshot extends NormalizedExpandedRouteArtifact {
  planDepth?: string;
  planner?: string;
  cache_hit?: boolean;
  route_source?: RouteArtifactBatchSource;
  packet_hash?: string;
  routerMode?: RouteArtifactRouterMode;
  artifactSource?: RouteSource;
  expectedSuccess?: number;
  confidence?: number;
  expectedCost?: number;
  expectedCostPlan?: number;
  expectedCostCode?: number;
  expectedCostReview?: number;
  artifactPath?: string;
  artifactHash?: string;
}

export interface RouteArtifactView {
  coder: string;
  codeDepth: string;
  reviewer: string;
  reviewMode: string;
  planner?: string;
  planDepth?: string;
  packetHash?: string;
  cacheHit?: boolean;
  routeSource?: RouteArtifactBatchSource;
  routerMode?: RouteArtifactRouterMode;
  artifactSource?: RouteSource;
  expectedSuccess?: number;
  confidence?: number;
  expectedCost?: number;
  expectedCostPlan?: number;
  expectedCostCode?: number;
  expectedCostReview?: number;
  artifactPath?: string;
  artifactHash?: string;
}

export interface RouteLifecycleArtifacts {
  bootstrap: RouteArtifactSnapshot | null;
  expanded: RouteArtifactSnapshot | null;
  active: RouteArtifactSnapshot | null;
}

export interface RouteLifecycleProvenance {
  bootstrapRoute?: RouteArtifactView;
  expandedRoute?: RouteArtifactView;
  activeRoute?: RouteArtifactView;
  routeChanged?: boolean;
  decisionSource?: 'bootstrap' | 'expanded' | 'preserved';
  expandedCacheHit?: boolean;
  packetHash?: string;
  routeSource?: RouteArtifactBatchSource;
}

export type ExpandedRouteValidation = {
  valid: boolean;
  missing: string[];
  invalid: string[];
  normalized?: NormalizedExpandedRouteArtifact;
};

export function validateExpandedRouteArtifact(value: unknown): ExpandedRouteValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      valid: false,
      missing: [],
      invalid: ['artifact'],
    };
  }

  const artifact = value as Record<string, unknown>;
  const missing: string[] = [];
  const invalid: string[] = [];

  const readStringField = (field: 'coder' | 'codeDepth' | 'reviewer'): string | undefined => {
    const raw = artifact[field];
    if (typeof raw === 'undefined') {
      missing.push(field);
      return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
      invalid.push(field);
      return undefined;
    }
    return raw;
  };

  const coder = readStringField('coder');
  const codeDepth = readStringField('codeDepth');
  const reviewer = readStringField('reviewer');

  const reviewModeCandidate = artifact.reviewMode ?? artifact.reviewRecommended;
  let reviewMode: string | undefined;
  if (typeof reviewModeCandidate === 'undefined') {
    missing.push('reviewMode');
  } else if (typeof reviewModeCandidate !== 'string' || reviewModeCandidate.trim() === '') {
    invalid.push('reviewMode');
  } else {
    reviewMode = reviewModeCandidate;
  }

  if (missing.length > 0 || invalid.length > 0 || !coder || !codeDepth || !reviewer || !reviewMode) {
    return {
      valid: false,
      missing,
      invalid,
    };
  }

  if (typeof artifact.cache_hit !== 'undefined' && typeof artifact.cache_hit !== 'boolean') {
    invalid.push('cache_hit');
  }

  if (
    typeof artifact.route_source !== 'undefined'
    && artifact.route_source !== 'batch'
    && artifact.route_source !== 'single'
    && artifact.route_source !== 'cache'
  ) {
    invalid.push('route_source');
  }

  if (
    typeof artifact.packet_hash !== 'undefined'
    && (typeof artifact.packet_hash !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.packet_hash))
  ) {
    invalid.push('packet_hash');
  }

  if (invalid.length > 0) {
    return {
      valid: false,
      missing,
      invalid,
    };
  }

  return {
    valid: true,
    missing: [],
    invalid: [],
    normalized: {
      coder,
      codeDepth,
      reviewer,
      reviewMode,
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBatchSource(value: unknown): RouteArtifactBatchSource | undefined {
  return value === 'batch' || value === 'single' || value === 'cache' ? value : undefined;
}

function readRouterMode(value: unknown): RouteArtifactRouterMode | undefined {
  return value === 'normal' || value === 'constrained' || value === 'survival' ? value : undefined;
}

const ROUTE_SOURCE_VALUES = new Set<RouteSource>([
  'bootstrap',
  'expanded',
  'startup-cache',
  'batch-cache',
  'live',
  'heuristic-fallback',
]);

function readArtifactSource(value: unknown): RouteSource | undefined {
  return typeof value === 'string' && ROUTE_SOURCE_VALUES.has(value as RouteSource)
    ? (value as RouteSource)
    : undefined;
}

interface RouteArtifactExtras {
  planner?: string;
  planDepth?: string;
  cache_hit?: boolean;
  route_source?: RouteArtifactBatchSource;
  packet_hash?: string;
  routerMode?: RouteArtifactRouterMode;
  artifactSource?: RouteSource;
  expectedSuccess?: number;
  confidence?: number;
  expectedCost?: number;
  expectedCostPlan?: number;
  expectedCostCode?: number;
  expectedCostReview?: number;
  artifactPath?: string;
  artifactHash?: string;
}

function extractRouteArtifactExtras(
  artifact: Record<string, unknown>,
  meta?: ArtifactMeta,
): RouteArtifactExtras {
  const provenance = artifact.provenance && typeof artifact.provenance === 'object' && !Array.isArray(artifact.provenance)
    ? (artifact.provenance as Record<string, unknown>)
    : undefined;

  const extras: RouteArtifactExtras = {};
  const planner = readString(artifact.planner);
  if (planner) extras.planner = planner;
  const planDepth = readString(artifact.planDepth);
  if (planDepth) extras.planDepth = planDepth;
  if (typeof artifact.cache_hit === 'boolean') extras.cache_hit = artifact.cache_hit;
  const routeSource = readBatchSource(artifact.route_source);
  if (routeSource) extras.route_source = routeSource;
  if (typeof artifact.packet_hash === 'string') extras.packet_hash = artifact.packet_hash;

  const routerMode = readRouterMode(provenance?.routerMode);
  if (routerMode) extras.routerMode = routerMode;
  const artifactSource = readArtifactSource(provenance?.source);
  if (artifactSource) extras.artifactSource = artifactSource;

  const expectedSuccess = readFiniteNumber(artifact.expectedSuccess);
  if (typeof expectedSuccess === 'number') extras.expectedSuccess = expectedSuccess;
  const confidence = readFiniteNumber(artifact.confidence);
  if (typeof confidence === 'number') extras.confidence = confidence;
  const expectedCost = readFiniteNumber(artifact.expectedCost);
  if (typeof expectedCost === 'number') extras.expectedCost = expectedCost;
  const expectedCostPlan = readFiniteNumber(artifact.expectedCostPlan);
  if (typeof expectedCostPlan === 'number') extras.expectedCostPlan = expectedCostPlan;
  const expectedCostCode = readFiniteNumber(artifact.expectedCostCode);
  if (typeof expectedCostCode === 'number') extras.expectedCostCode = expectedCostCode;
  const expectedCostReview = readFiniteNumber(artifact.expectedCostReview);
  if (typeof expectedCostReview === 'number') extras.expectedCostReview = expectedCostReview;

  if (meta?.path) extras.artifactPath = meta.path;
  if (meta?.hash) extras.artifactHash = meta.hash;
  return extras;
}

function parseBootstrapRouteArtifact(
  value: unknown,
  meta?: ArtifactMeta,
): RouteArtifactSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const artifact = value as Record<string, unknown>;
  const coder = readString(artifact.coder);
  const codeDepth = readString(artifact.codeDepth);
  const reviewer = readString(artifact.reviewer);
  const reviewMode = readString(artifact.reviewMode ?? artifact.reviewRecommended);

  if (!coder || !codeDepth || !reviewer || !reviewMode) {
    return null;
  }

  return {
    coder,
    codeDepth,
    reviewer,
    reviewMode,
    ...extractRouteArtifactExtras(artifact, meta),
  };
}

interface ArtifactMeta {
  path: string;
  hash: string;
}

function loadJsonWithMeta(filePath: string): { value: unknown; path: string; hash: string } | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const value = JSON.parse(raw);
    const hash = createHash('sha256').update(raw).digest('hex');
    return { value, path: filePath, hash };
  } catch {
    return null;
  }
}

function parseExpandedRouteArtifact(
  value: unknown,
  meta?: ArtifactMeta,
): RouteArtifactSnapshot | null {
  if (value === null) {
    return null;
  }

  const validation = validateExpandedRouteArtifact(value);
  if (!validation.valid || !validation.normalized) {
    return null;
  }

  const artifact = value as Record<string, unknown>;
  return {
    ...validation.normalized,
    ...extractRouteArtifactExtras(artifact, meta),
  };
}

function loadBootstrapRouteArtifact(filePath: string): RouteArtifactSnapshot | null {
  const meta = loadJsonWithMeta(filePath);
  if (!meta) return null;
  return parseBootstrapRouteArtifact(meta.value, { path: meta.path, hash: meta.hash });
}

function loadExpandedRouteArtifact(filePath: string): RouteArtifactSnapshot | null {
  const meta = loadJsonWithMeta(filePath);
  if (!meta) return null;
  return parseExpandedRouteArtifact(meta.value, { path: meta.path, hash: meta.hash });
}

export function readBothRouteArtifacts(featureDir: string): {
  bootstrap: RouteArtifactSnapshot | null;
  expanded: RouteArtifactSnapshot | null;
} {
  return {
    bootstrap: loadBootstrapRouteArtifact(join(featureDir, '.initial-route.json')),
    expanded: loadExpandedRouteArtifact(join(featureDir, '.post-expansion-route.json')),
  };
}

function firstSnapshot<T>(loaders: Array<() => T | null>): T | null {
  for (const load of loaders) {
    const value = load();
    if (value) {
      return value;
    }
  }
  return null;
}

export function readRouteLifecycleArtifacts(
  featureDir?: string,
  archiveDir?: string,
): RouteLifecycleArtifacts {
  const bootstrap = firstSnapshot([
    () => featureDir ? loadBootstrapRouteArtifact(join(featureDir, '.initial-route.json')) : null,
    () => archiveDir ? loadBootstrapRouteArtifact(join(archiveDir, 'initial-route.json')) : null,
  ]);
  const expanded = firstSnapshot([
    () => featureDir ? loadExpandedRouteArtifact(join(featureDir, '.post-expansion-route.json')) : null,
    () => featureDir ? loadExpandedRouteArtifact(join(featureDir, '.expanded-route.json')) : null,
    () => archiveDir ? loadExpandedRouteArtifact(join(archiveDir, 'post-expansion-route.json')) : null,
  ]);
  const active = firstSnapshot([
    () => featureDir ? loadBootstrapRouteArtifact(join(featureDir, '.routing-complete')) : null,
    () => archiveDir ? loadBootstrapRouteArtifact(join(archiveDir, 'routing-complete.json')) : null,
  ]);

  return { bootstrap, expanded, active };
}

export function toRouteArtifactView(route: RouteArtifactSnapshot): RouteArtifactView {
  return {
    coder: route.coder,
    codeDepth: route.codeDepth,
    reviewer: route.reviewer,
    reviewMode: route.reviewMode,
    ...(route.planner ? { planner: route.planner } : {}),
    ...(route.planDepth ? { planDepth: route.planDepth } : {}),
    ...(route.packet_hash ? { packetHash: route.packet_hash } : {}),
    ...(typeof route.cache_hit === 'boolean' ? { cacheHit: route.cache_hit } : {}),
    ...(route.route_source ? { routeSource: route.route_source } : {}),
    ...(route.routerMode ? { routerMode: route.routerMode } : {}),
    ...(route.artifactSource ? { artifactSource: route.artifactSource } : {}),
    ...(typeof route.expectedSuccess === 'number' ? { expectedSuccess: route.expectedSuccess } : {}),
    ...(typeof route.confidence === 'number' ? { confidence: route.confidence } : {}),
    ...(typeof route.expectedCost === 'number' ? { expectedCost: route.expectedCost } : {}),
    ...(typeof route.expectedCostPlan === 'number' ? { expectedCostPlan: route.expectedCostPlan } : {}),
    ...(typeof route.expectedCostCode === 'number' ? { expectedCostCode: route.expectedCostCode } : {}),
    ...(typeof route.expectedCostReview === 'number' ? { expectedCostReview: route.expectedCostReview } : {}),
    ...(route.artifactPath ? { artifactPath: route.artifactPath } : {}),
    ...(route.artifactHash ? { artifactHash: route.artifactHash } : {}),
  };
}

export function formatRouteArtifactSignature(route: RouteArtifactView | RouteArtifactSnapshot): string {
  return `coder=${route.coder},codeDepth=${route.codeDepth},reviewer=${route.reviewer},reviewMode=${route.reviewMode}`;
}

function modelClassOrId(modelId: string, repoDir?: string): string {
  const registry = getEffectiveRegistry(repoDir);
  return getModel(registry, modelId)?.class || modelId;
}

export function routeChangedMaterially(
  bootstrap: RouteArtifactSnapshot,
  expanded: RouteArtifactSnapshot,
  repoDir?: string,
): { changed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (modelClassOrId(bootstrap.coder, repoDir) !== modelClassOrId(expanded.coder, repoDir)) {
    reasons.push('coder_class');
  }

  if (bootstrap.codeDepth !== expanded.codeDepth) {
    reasons.push('code_depth');
  }

  if (modelClassOrId(bootstrap.reviewer, repoDir) !== modelClassOrId(expanded.reviewer, repoDir)) {
    reasons.push('reviewer_class');
  }

  return {
    changed: reasons.length > 0,
    reasons,
  };
}

function routesMatchExactly(
  left: RouteArtifactSnapshot | null | undefined,
  right: RouteArtifactSnapshot | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return left.coder === right.coder
    && left.codeDepth === right.codeDepth
    && left.reviewer === right.reviewer
    && left.reviewMode === right.reviewMode;
}

export function deriveRouteDecisionSource(
  artifacts: RouteLifecycleArtifacts,
  repoDir?: string,
): 'bootstrap' | 'expanded' | 'preserved' | undefined {
  const { bootstrap, expanded, active } = artifacts;

  if (!bootstrap && !expanded && !active) {
    return undefined;
  }

  if (!expanded) {
    return 'bootstrap';
  }

  if (!bootstrap) {
    return 'expanded';
  }

  if (active && routesMatchExactly(active, bootstrap) && !routesMatchExactly(active, expanded)) {
    return 'preserved';
  }

  if (active && routesMatchExactly(active, expanded)) {
    return routeChangedMaterially(bootstrap, expanded, repoDir).changed ? 'expanded' : 'preserved';
  }

  return routeChangedMaterially(bootstrap, expanded, repoDir).changed ? 'expanded' : 'preserved';
}

export function buildRouteLifecycleProvenance(
  artifacts: RouteLifecycleArtifacts,
  repoDir?: string,
): RouteLifecycleProvenance | null {
  const decisionSource = deriveRouteDecisionSource(artifacts, repoDir);
  if (!decisionSource) {
    return null;
  }

  const active = artifacts.active
    ?? (decisionSource === 'expanded' ? artifacts.expanded : artifacts.bootstrap)
    ?? artifacts.expanded
    ?? artifacts.bootstrap;
  const routeChanged = artifacts.bootstrap && active
    ? routeChangedMaterially(artifacts.bootstrap, active, repoDir).changed
    : undefined;
  const metadataCarrier = artifacts.expanded ?? active ?? undefined;

  return {
    ...(artifacts.bootstrap ? { bootstrapRoute: toRouteArtifactView(artifacts.bootstrap) } : {}),
    ...(artifacts.expanded ? { expandedRoute: toRouteArtifactView(artifacts.expanded) } : {}),
    ...(active ? { activeRoute: toRouteArtifactView(active) } : {}),
    ...(typeof routeChanged === 'boolean' ? { routeChanged } : {}),
    decisionSource,
    ...(typeof metadataCarrier?.cache_hit === 'boolean' ? { expandedCacheHit: metadataCarrier.cache_hit } : {}),
    ...(metadataCarrier?.packet_hash ? { packetHash: metadataCarrier.packet_hash } : {}),
    ...(metadataCarrier?.route_source ? { routeSource: metadataCarrier.route_source } : {}),
  };
}

export function hasValidPostExpansionRoute(routeDir: string): { ok: boolean; reason?: string } {
  const routePath = join(routeDir, '.post-expansion-route.json');
  if (!existsSync(routePath)) {
    return { ok: false, reason: 'missing' };
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(routePath, 'utf-8'));
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  const validation = validateExpandedRouteArtifact(value);
  if (!validation.valid) {
    const fields = validation.missing.length > 0
      ? validation.missing.join(',')
      : validation.invalid.join(',');
    return { ok: false, reason: `missing-required-field:${fields}` };
  }

  return { ok: true };
}
