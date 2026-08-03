import { createHash, randomUUID } from 'node:crypto';

export const INCIDENT_SCHEMA_VERSION = '1.0';

export const INCIDENT_EVIDENCE_TYPES = [
  'planning_result',
  'stage_result',
  'job_state',
  'job_result',
  'eval_record',
  'queue_health',
  'dependency_probe',
  'hook_status',
  'artifact_diagnostic',
  'coverage_gap',
] as const;

export type IncidentEvidenceType = typeof INCIDENT_EVIDENCE_TYPES[number];

/**
 * Stable root-cause category.
 *
 * Examples:
 * - `model_task_harness_outcome`: native planning stopped at `turn_limit`.
 * - `external_transient_dependency`: repeated GitHub SSH probe failures.
 * - `stale_orphaned_state`: a comparison job failed because eval records are missing.
 */
export type IncidentCategory =
  | 'wavemill_product_defect'
  | 'model_task_harness_outcome'
  | 'external_transient_dependency'
  | 'configuration_operator'
  | 'stale_orphaned_state';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type IncidentConfidence = 'high' | 'medium' | 'low';
export type IncidentLifecycleState = 'active' | 'acknowledged' | 'resolved';

export interface IncidentEvidence {
  evidenceType: IncidentEvidenceType;
  timestamp: string;
  path?: string;
  description: string;
  value?: Record<string, unknown>;
}

export interface WavemillIncident {
  schemaVersion: typeof INCIDENT_SCHEMA_VERSION;
  id: string;
  fingerprint: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  confidence: IncidentConfidence;
  lifecycleState: IncidentLifecycleState;
  normalizedRootCauseClass: string;
  evidence: IncidentEvidence[];
  occurrenceCount: number;
  firstObserved: string;
  lastObserved: string;
  escalated: boolean;
  redactedSummary: string;
  recommendedAction: string;
  issue?: string;
  session?: string;
  repoDir?: string;
}

export interface CreateIncidentInput {
  category: IncidentCategory;
  severity: IncidentSeverity;
  confidence: IncidentConfidence;
  normalizedRootCauseClass: string;
  evidence: IncidentEvidence[];
  redactedSummary: string;
  recommendedAction: string;
  observedAt?: string;
  issue?: string;
  session?: string;
  repoDir?: string;
  escalated?: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicalize((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
  }
  return value;
}

export function computeIncidentFingerprint(incident: Pick<WavemillIncident, 'category' | 'normalizedRootCauseClass' | 'evidence'>): string {
  const payload = {
    category: incident.category,
    normalizedRootCauseClass: incident.normalizedRootCauseClass,
    evidenceTypes: [...new Set(incident.evidence.map((item) => item.evidenceType))].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

export function createIncident(input: CreateIncidentInput): WavemillIncident {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const incident: WavemillIncident = {
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    id: `incident-${randomUUID()}`,
    fingerprint: '',
    category: input.category,
    severity: input.severity,
    confidence: input.confidence,
    lifecycleState: 'active',
    normalizedRootCauseClass: input.normalizedRootCauseClass,
    evidence: input.evidence,
    occurrenceCount: 1,
    firstObserved: observedAt,
    lastObserved: observedAt,
    escalated: input.escalated ?? false,
    redactedSummary: input.redactedSummary,
    recommendedAction: input.recommendedAction,
  };
  if (input.issue) incident.issue = input.issue;
  if (input.session) incident.session = input.session;
  if (input.repoDir) incident.repoDir = input.repoDir;
  incident.fingerprint = computeIncidentFingerprint(incident);
  return incident;
}
