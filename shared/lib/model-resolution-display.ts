import type { Channel, ModelSelector } from './model-registry.ts';
import type { ResolvedModelRoutingDecision, RoutingRole } from './eval-schema.ts';
import { existsSync, readFileSync } from 'node:fs';

export interface SubagentRoutingRecord extends Partial<ResolvedModelRoutingDecision> {
  requested?: string;
  resolved?: string;
  fallback?: string;
  fallbackModelId?: string;
  inheritedFrom?: string;
  channel?: Channel | string;
  parentContextId?: string;
}

export interface SubagentModelDisplay {
  role: string;
  requested: string;
  resolved: string;
  hasFallback: boolean;
  fallback?: string;
  fallbackReason?: string;
  inheritedFrom?: string;
  channel?: string;
  unavailable?: boolean;
}

export interface RouteLifecycleDisplayRoute {
  planner?: string;
  coder?: string;
  reviewer?: string;
}

export interface ExecutedPlanningDisplay {
  agent?: string;
  model?: string;
  status?: string;
  unavailable?: boolean;
}

export interface RouteLifecycleDisplayInput {
  bootstrapRoute?: RouteLifecycleDisplayRoute;
  executedPlanning?: ExecutedPlanningDisplay;
  expandedRoute?: RouteLifecycleDisplayRoute;
  activeRoute?: RouteLifecycleDisplayRoute;
  executionTelemetry?: unknown[];
}

export interface RouteLifecycleDisplayPaths {
  planningResultPath?: string;
  initialRoutePath?: string;
  postExpansionRoutePath?: string;
  routingCompletePath?: string;
  phaseConfigPath?: string;
  routingJsonlPath?: string;
}

export const PLAN_SUBAGENT_ROLES: readonly RoutingRole[] = ['planner', 'coder', 'reviewer'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readJsonFile(path: string | undefined): unknown {
  if (!path || !existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function readJsonlFile(path: string | undefined): unknown[] | undefined {
  if (!path || !existsSync(path)) {
    return undefined;
  }

  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter((record): record is unknown => typeof record !== 'undefined');
  } catch {
    return undefined;
  }
}

function normalizeRole(value: unknown) {
  return readString(value) ?? 'subagent';
}

function selectorToRequested(selector: ModelSelector): string {
  switch (selector.kind) {
    case 'alias':
      return selector.family;
    case 'pinned':
      return selector.modelId;
    case 'inherit':
      return 'inherit';
  }
}

function selectorToChannel(selector: ModelSelector): string | undefined {
  if (selector.kind !== 'alias') {
    return undefined;
  }

  return selector.channel;
}

function normalizeRequested(record: Record<string, unknown>) {
  const requested = readString(record.requested);
  if (requested) {
    return requested;
  }

  if (!isRecord(record.requestedSelector)) {
    return undefined;
  }

  const selector = record.requestedSelector as ModelSelector;
  if (selector.kind !== 'alias' && selector.kind !== 'pinned' && selector.kind !== 'inherit') {
    return undefined;
  }

  return selectorToRequested(selector);
}

function normalizeChannel(record: Record<string, unknown>) {
  const requestedChannel = readString(record.channel);
  if (requestedChannel && requestedChannel !== 'stable') {
    return requestedChannel;
  }

  if (!isRecord(record.requestedSelector)) {
    return undefined;
  }

  const selector = record.requestedSelector as ModelSelector;
  const selectorChannel = selectorToChannel(selector);
  if (selectorChannel && selectorChannel !== 'stable') {
    return selectorChannel;
  }

  return undefined;
}

function normalizeInheritedFrom(record: Record<string, unknown>) {
  return readString(record.inheritedFrom) ?? readString(record.parentContextId);
}

function normalizeFallback(record: Record<string, unknown>, resolved: string | undefined) {
  return (
    readString(record.fallback)
    ?? readString(record.fallbackModelId)
    ?? (readString(record.fallbackReason) ? resolved : undefined)
  );
}

function normalizeModelName(value: unknown): string | undefined {
  const model = readString(value);
  return model ? model.toLowerCase() : undefined;
}

function parseRouteArtifact(value: unknown): RouteLifecycleDisplayRoute | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const planner = readString(value.planner);
  const coder = readString(value.coder);
  const reviewer = readString(value.reviewer);

  if (!planner && !coder && !reviewer) {
    return undefined;
  }

  return {
    ...(planner ? { planner } : {}),
    ...(coder ? { coder } : {}),
    ...(reviewer ? { reviewer } : {}),
  };
}

function parsePlanningResult(value: unknown): ExecutedPlanningDisplay | undefined {
  if (value === null) {
    return { unavailable: true };
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const agent = readString(value.agent);
  const model = readString(value.model);
  const status = readString(value.status);

  if (!agent && !model && !status) {
    return { unavailable: true };
  }

  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(status ? { status } : {}),
    ...(!model ? { unavailable: true } : {}),
  };
}

function parsePhaseConfigActiveRoute(value: unknown): RouteLifecycleDisplayRoute | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const planning = isRecord(value.planning) ? value.planning : undefined;
  const coding = isRecord(value.coding) ? value.coding : undefined;
  const review = isRecord(value.review) ? value.review : undefined;

  const planner = planning ? readString(planning.model) : undefined;
  const coder = coding ? readString(coding.model) : undefined;
  const reviewer = review ? readString(review.model) : undefined;

  if (!planner && !coder && !reviewer) {
    return undefined;
  }

  return {
    ...(planner ? { planner } : {}),
    ...(coder ? { coder } : {}),
    ...(reviewer ? { reviewer } : {}),
  };
}

function mergeRoutes(
  primary: RouteLifecycleDisplayRoute | undefined,
  fallback: RouteLifecycleDisplayRoute | undefined,
): RouteLifecycleDisplayRoute | undefined {
  if (!primary && !fallback) {
    return undefined;
  }

  return {
    planner: primary?.planner ?? fallback?.planner,
    coder: primary?.coder ?? fallback?.coder,
    reviewer: primary?.reviewer ?? fallback?.reviewer,
  };
}

function routeDetails(
  route: RouteLifecycleDisplayRoute | undefined,
  roles: ReadonlyArray<'planner' | 'coder' | 'reviewer'>,
): string | undefined {
  if (!route) {
    return undefined;
  }

  const pairs = roles
    .map((role) => {
      const value = route[role];
      return value ? `${role[0]}=${value}` : undefined;
    })
    .filter((entry): entry is string => Boolean(entry));

  return pairs.length > 0 ? pairs.join(', ') : undefined;
}

export function formatSubagentModelResolution(record: unknown): SubagentModelDisplay {
  if (!isRecord(record)) {
    return {
      role: 'subagent',
      requested: '',
      resolved: '',
      hasFallback: false,
      unavailable: true,
    };
  }

  const role = normalizeRole(record.role);
  const requested = normalizeRequested(record);
  const resolved = readString(record.resolved) ?? readString(record.resolvedModelId);

  if (!requested || !resolved) {
    return {
      role,
      requested: requested ?? '',
      resolved: resolved ?? '',
      hasFallback: false,
      unavailable: true,
    };
  }

  const fallback = normalizeFallback(record, resolved);
  const fallbackReason = fallback ? readString(record.fallbackReason) ?? 'unspecified' : undefined;

  return {
    role,
    requested,
    resolved,
    hasFallback: Boolean(fallback),
    fallback,
    fallbackReason,
    inheritedFrom: requested === 'inherit' ? normalizeInheritedFrom(record) ?? 'unknown' : undefined,
    channel: normalizeChannel(record),
  };
}

export function formatSubagentModelDisplayText(display: SubagentModelDisplay): string {
  const role = display.role || 'subagent';
  if (display.unavailable) {
    return `${role}: model resolution unavailable`;
  }

  let requested = `requested=${display.requested}`;
  if (display.requested === 'inherit') {
    requested += ` (from ${display.inheritedFrom ?? 'unknown'})`;
  }
  if (display.channel) {
    requested += ` [channel=${display.channel}]`;
  }

  let output = `${role}: ${requested} → resolved=${display.resolved}`;
  if (display.hasFallback && display.fallback) {
    output += `\n         fallback=${display.fallback} (reason: ${display.fallbackReason ?? 'unspecified'})`;
  }

  return output;
}

export function formatAllSubagentModelDisplayText(records: unknown[]): string {
  if (records.length === 0) {
    return '';
  }

  return records
    .map((record) => formatSubagentModelDisplayText(formatSubagentModelResolution(record)))
    .join('\n');
}

export function loadRouteLifecycleDisplayInputFromPaths(
  paths: RouteLifecycleDisplayPaths,
): RouteLifecycleDisplayInput {
  const bootstrapRoute = parseRouteArtifact(readJsonFile(paths.initialRoutePath));
  const executedPlanning = parsePlanningResult(readJsonFile(paths.planningResultPath));
  const expandedRoute = parseRouteArtifact(readJsonFile(paths.postExpansionRoutePath));
  const activeRoute = mergeRoutes(
    parseRouteArtifact(readJsonFile(paths.routingCompletePath)),
    parsePhaseConfigActiveRoute(readJsonFile(paths.phaseConfigPath)),
  );
  const executionTelemetry = readJsonlFile(paths.routingJsonlPath);

  return {
    ...(bootstrapRoute ? { bootstrapRoute } : {}),
    ...(executedPlanning ? { executedPlanning } : {}),
    ...(expandedRoute ? { expandedRoute } : {}),
    ...(activeRoute ? { activeRoute } : {}),
    ...(executionTelemetry ? { executionTelemetry } : {}),
  };
}

export function formatRouteLifecycleDisplayText(input: RouteLifecycleDisplayInput): string {
  const lines: string[] = [];
  const executedPlanning = input.executedPlanning;
  const executedPlannerModel = executedPlanning?.model;
  const expandedPlannerModel = input.expandedRoute?.planner;

  if (executedPlanning?.unavailable) {
    lines.push('executed planning: model resolution unavailable');
  } else if (executedPlanning?.model || executedPlanning?.agent) {
    lines.push(`executed planning: ${executedPlanning.agent ?? 'unknown'} / ${executedPlanning.model ?? 'unknown'}`);
  } else {
    lines.push('planning execution: pending');
  }

  const bootstrap = routeDetails(input.bootstrapRoute, ['planner', 'coder', 'reviewer']);
  if (bootstrap) {
    lines.push(`bootstrap route: ${bootstrap}`);
  }

  const expandedPlanner = routeDetails(input.expandedRoute, ['planner']);
  if (
    expandedPlanner
    && (
      !executedPlannerModel
      || normalizeModelName(executedPlannerModel) !== normalizeModelName(expandedPlannerModel)
    )
  ) {
    lines.push(`recommended after expansion: ${expandedPlanner}`);
  }

  const activeRoute = routeDetails(input.activeRoute, ['coder', 'reviewer']);
  if (activeRoute) {
    lines.push(`active remaining route: ${activeRoute}`);
  }

  if (Array.isArray(input.executionTelemetry) && input.executionTelemetry.length > 0) {
    lines.push('execution telemetry:');
    lines.push(...input.executionTelemetry.map((record) =>
      formatSubagentModelDisplayText(formatSubagentModelResolution(record))));
  }

  return lines.join('\n');
}

export function formatRouteLifecycleDisplayTextFromPaths(
  paths: RouteLifecycleDisplayPaths,
): string {
  return formatRouteLifecycleDisplayText(loadRouteLifecycleDisplayInputFromPaths(paths));
}
