export const WAVEMILL_INCIDENT_SCHEMA_VERSION = '1.0';

export type IncidentCategory =
  | 'product_defect'
  | 'model_task_harness_outcome'
  | 'external_transient_dependency'
  | 'configuration_operator_condition'
  | 'stale_orphaned_state';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type IncidentConfidence = 'definite' | 'high' | 'medium' | 'low';
export type IncidentLifecycle = 'observed' | 'active' | 'resolved' | 'archived';

export type IncidentEvidenceType =
  | 'planning_result'
  | 'workflow_state'
  | 'job_state'
  | 'hook_status'
  | 'backstage_health'
  | 'log_excerpt';

export interface IncidentEvidence {
  type: IncidentEvidenceType;
  source: string;
  timestamp: string;
  lineNumber?: number;
  redactedData: string;
  key?: string;
}

export interface IncidentMetadata {
  thresholdTriggered?: boolean;
  cooldownExpiresAt?: string;
  escalatedAt?: string;
  linearIssueId?: string;
  linearIssueIdentifier?: string;
  linearIssueUrl?: string;
  linearSyncedAt?: string;
  linearEvidenceRevision?: number;
  linearEvidenceHash?: string;
  linearSyncCooldownExpires?: string;
  linearRelatedIssueId?: string;
  relatedLinearId?: string;
  persistent?: boolean;
  [key: string]: unknown;
}

export interface IncidentRecord {
  schemaVersion: typeof WAVEMILL_INCIDENT_SCHEMA_VERSION;
  id: string;
  fingerprint: string;
  taskId?: string | null;
  session?: string | null;
  category: IncidentCategory;
  severity: IncidentSeverity;
  confidence: IncidentConfidence;
  lifecycle: IncidentLifecycle;
  createdAt: string;
  lastObservedAt: string;
  occurrenceCount: number;
  rootCauseClass: string;
  summary: string;
  operatorAction: string;
  evidence: IncidentEvidence[];
  metadata: IncidentMetadata;
}

export type NewIncidentRecord = Omit<
  IncidentRecord,
  'schemaVersion' | 'id' | 'fingerprint' | 'createdAt' | 'lastObservedAt' | 'occurrenceCount'
> & Partial<Pick<IncidentRecord, 'schemaVersion' | 'id' | 'fingerprint' | 'createdAt' | 'lastObservedAt' | 'occurrenceCount'>>;

export function createIncidentDraft(input: NewIncidentRecord): IncidentRecord {
  return {
    schemaVersion: WAVEMILL_INCIDENT_SCHEMA_VERSION,
    id: input.id ?? '',
    fingerprint: input.fingerprint ?? '',
    taskId: input.taskId ?? null,
    session: input.session ?? null,
    category: input.category,
    severity: input.severity,
    confidence: input.confidence,
    lifecycle: input.lifecycle,
    createdAt: input.createdAt ?? '',
    lastObservedAt: input.lastObservedAt ?? '',
    occurrenceCount: input.occurrenceCount ?? 0,
    rootCauseClass: input.rootCauseClass,
    summary: input.summary,
    operatorAction: input.operatorAction,
    evidence: input.evidence,
    metadata: input.metadata ?? {},
  };
}
