import type { Channel, ModelSelector } from './model-registry.ts';
import type { ResolvedModelRoutingDecision, RoutingRole } from './eval-schema.ts';

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
