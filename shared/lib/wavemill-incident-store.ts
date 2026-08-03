import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { mutateJsonState, StateParseError } from './state-mutex.ts';
import {
  INCIDENT_SCHEMA_VERSION,
  type IncidentEvidence,
  type IncidentCategory,
  type IncidentLifecycleState,
  type IncidentSeverity,
  type WavemillIncident,
} from './wavemill-incident-model.ts';

export interface IncidentThresholds {
  repeatedFailureCount: number;
  timeWindowMinutes: number;
  cooldownMinutes: number;
}

export interface IncidentStoreState {
  schemaVersion: typeof INCIDENT_SCHEMA_VERSION;
  incidents: WavemillIncident[];
  thresholds: IncidentThresholds;
  lastUpdated: string;
}

export interface IncidentStoreOptions {
  repoDir: string;
  thresholds?: Partial<IncidentThresholds>;
  now?: Date;
}

export interface IncidentStoreResult {
  incident: WavemillIncident;
  changed: boolean;
  appendedEvidenceCount: number;
  suppressedByCooldown: boolean;
}

export interface IncidentQuery {
  category?: IncidentCategory;
  severity?: IncidentSeverity;
  lifecycleState?: IncidentLifecycleState;
}

const DEFAULT_THRESHOLDS: IncidentThresholds = {
  repeatedFailureCount: 3,
  timeWindowMinutes: 60,
  cooldownMinutes: 0,
};

function storeDir(repoDir: string): string {
  return join(repoDir, '.wavemill', 'incidents');
}

function statePath(repoDir: string): string {
  return join(storeDir(repoDir), 'incident-state.json');
}

function evidencePath(repoDir: string): string {
  return join(storeDir(repoDir), 'evidence.jsonl');
}

function thresholds(opts: IncidentStoreOptions): IncidentThresholds {
  const overrides = opts.thresholds ?? {};
  return {
    repeatedFailureCount: overrides.repeatedFailureCount ?? DEFAULT_THRESHOLDS.repeatedFailureCount,
    timeWindowMinutes: overrides.timeWindowMinutes ?? DEFAULT_THRESHOLDS.timeWindowMinutes,
    cooldownMinutes: overrides.cooldownMinutes ?? DEFAULT_THRESHOLDS.cooldownMinutes,
  };
}

function initialState(opts: IncidentStoreOptions): IncidentStoreState {
  return {
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    incidents: [],
    thresholds: thresholds(opts),
    lastUpdated: (opts.now ?? new Date()).toISOString(),
  };
}

function normalizeState(value: unknown, opts: IncidentStoreOptions): IncidentStoreState {
  const current = value && typeof value === 'object' ? value as Partial<IncidentStoreState> : {};
  return {
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    incidents: Array.isArray(current.incidents) ? current.incidents : [],
    thresholds: { ...thresholds(opts), ...(current.thresholds ?? {}) },
    lastUpdated: typeof current.lastUpdated === 'string' ? current.lastUpdated : (opts.now ?? new Date()).toISOString(),
  };
}

function appendEvidence(repoDir: string, incident: WavemillIncident, evidence: IncidentEvidence[]): number {
  if (evidence.length === 0) return 0;
  mkdirSync(storeDir(repoDir), { recursive: true });
  const lines = evidence.map((item) => JSON.stringify({
    timestamp: item.timestamp,
    fingerprint: incident.fingerprint,
    evidenceType: item.evidenceType,
    path: item.path ? relative(repoDir, item.path) : undefined,
    value: item.value,
    description: item.description,
  })).join('\n');
  appendFileSync(evidencePath(repoDir), `${lines}\n`, 'utf-8');
  return evidence.length;
}

function evidenceKey(item: IncidentEvidence): string {
  return `${item.evidenceType}\0${item.path ?? ''}\0${item.description}\0${JSON.stringify(item.value ?? {})}`;
}

export async function initIncidentStore(repoDir: string): Promise<void> {
  mkdirSync(storeDir(repoDir), { recursive: true });
  if (!existsSync(statePath(repoDir))) {
    writeFileSync(statePath(repoDir), `${JSON.stringify(initialState({ repoDir }), null, 2)}\n`, 'utf-8');
  }
  if (!existsSync(evidencePath(repoDir))) {
    writeFileSync(evidencePath(repoDir), '', { flag: 'a' });
  }
}

export async function recordIncident(opts: IncidentStoreOptions, incident: WavemillIncident): Promise<IncidentStoreResult> {
  await initIncidentStore(opts.repoDir);
  const now = opts.now ?? new Date();
  let result: IncidentStoreResult | null = null;

  const runMutation = async () => mutateJsonState<IncidentStoreState>(
    statePath(opts.repoDir),
    (rawCurrent) => {
      const current = normalizeState(rawCurrent, opts);
      const configuredThresholds = thresholds(opts);
      const nextIncidents = [...current.incidents];
      const index = nextIncidents.findIndex((item) => item.fingerprint === incident.fingerprint);
      const observedAt = now.toISOString();

      if (index === -1) {
        const nextIncident = {
          ...incident,
          lifecycleState: 'active' as const,
          occurrenceCount: Math.max(incident.occurrenceCount, 1),
          firstObserved: incident.firstObserved || observedAt,
          lastObserved: observedAt,
          escalated: incident.escalated || incident.occurrenceCount >= configuredThresholds.repeatedFailureCount,
        };
        nextIncidents.push(nextIncident);
        const appended = appendEvidence(opts.repoDir, nextIncident, incident.evidence);
        result = { incident: nextIncident, changed: true, appendedEvidenceCount: appended, suppressedByCooldown: false };
      } else {
        const existing = nextIncidents[index];
        const minutesSinceLast = (now.getTime() - Date.parse(existing.lastObserved)) / 60000;
        const suppressedByCooldown = configuredThresholds.cooldownMinutes > 0 && Number.isFinite(minutesSinceLast) && minutesSinceLast < configuredThresholds.cooldownMinutes;
        const mergedEvidence = [...existing.evidence];
        const seen = new Set(mergedEvidence.map(evidenceKey));
        for (const item of incident.evidence) {
          if (!seen.has(evidenceKey(item))) {
            mergedEvidence.push(item);
          }
        }
        const nextIncident: WavemillIncident = {
          ...existing,
          severity: severityRank(incident.severity) > severityRank(existing.severity) ? incident.severity : existing.severity,
          confidence: confidenceRank(incident.confidence) > confidenceRank(existing.confidence) ? incident.confidence : existing.confidence,
          lifecycleState: existing.lifecycleState === 'resolved' ? 'active' : existing.lifecycleState,
          evidence: mergedEvidence.slice(-50),
          occurrenceCount: suppressedByCooldown ? existing.occurrenceCount : existing.occurrenceCount + 1,
          lastObserved: suppressedByCooldown ? existing.lastObserved : observedAt,
          escalated: existing.escalated || incident.escalated || (!suppressedByCooldown && existing.occurrenceCount + 1 >= configuredThresholds.repeatedFailureCount),
          redactedSummary: incident.redactedSummary || existing.redactedSummary,
          recommendedAction: incident.recommendedAction || existing.recommendedAction,
        };
        nextIncidents[index] = nextIncident;
        const appended = suppressedByCooldown ? 0 : appendEvidence(opts.repoDir, nextIncident, incident.evidence);
        result = { incident: nextIncident, changed: !suppressedByCooldown, appendedEvidenceCount: appended, suppressedByCooldown };
      }

      return {
        schemaVersion: INCIDENT_SCHEMA_VERSION,
        incidents: nextIncidents,
        thresholds: configuredThresholds,
        lastUpdated: observedAt,
      };
    },
    { createIfMissing: true, initial: initialState(opts) },
  );

  try {
    await runMutation();
  } catch (error) {
    if (!(error instanceof StateParseError)) throw error;
    writeFileSync(statePath(opts.repoDir), `${JSON.stringify(initialState(opts), null, 2)}\n`, 'utf-8');
    await runMutation();
  }

  if (!result) {
    throw new Error('incident store mutation did not produce a result');
  }
  return result;
}

export async function queryIncidents(opts: IncidentStoreOptions & { query?: IncidentQuery }): Promise<WavemillIncident[]> {
  const path = statePath(opts.repoDir);
  if (!existsSync(path)) return [];
  try {
    const state = normalizeState(JSON.parse(readFileSync(path, 'utf-8')), opts);
    return state.incidents.filter((incident) =>
      (!opts.query?.category || incident.category === opts.query.category)
      && (!opts.query?.severity || incident.severity === opts.query.severity)
      && (!opts.query?.lifecycleState || incident.lifecycleState === opts.query.lifecycleState)
    );
  } catch {
    return [];
  }
}

export async function acknowledgeIncident(opts: IncidentStoreOptions, fingerprintOrId: string): Promise<void> {
  await updateLifecycle(opts, fingerprintOrId, 'acknowledged');
}

export async function resolveIncident(opts: IncidentStoreOptions, fingerprintOrId: string): Promise<void> {
  await updateLifecycle(opts, fingerprintOrId, 'resolved');
}

async function updateLifecycle(opts: IncidentStoreOptions, fingerprintOrId: string, lifecycleState: IncidentLifecycleState): Promise<void> {
  await initIncidentStore(opts.repoDir);
  await mutateJsonState<IncidentStoreState>(
    statePath(opts.repoDir),
    (rawCurrent) => {
      const current = normalizeState(rawCurrent, opts);
      return {
        ...current,
        incidents: current.incidents.map((incident) =>
          incident.id === fingerprintOrId || incident.fingerprint === fingerprintOrId
            ? { ...incident, lifecycleState, lastObserved: (opts.now ?? new Date()).toISOString() }
            : incident
        ),
        lastUpdated: (opts.now ?? new Date()).toISOString(),
      };
    },
    { createIfMissing: true, initial: initialState(opts) },
  );
}

function severityRank(value: IncidentSeverity): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[value];
}

function confidenceRank(value: 'low' | 'medium' | 'high'): number {
  return { low: 0, medium: 1, high: 2 }[value];
}
