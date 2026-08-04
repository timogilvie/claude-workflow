import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type IncidentEvidence,
  type IncidentLifecycle,
  type IncidentRecord,
  WAVEMILL_INCIDENT_SCHEMA_VERSION,
} from './wavemill-incident-model.ts';
import { mutateJsonState, StateParseError } from './state-mutex.ts';

export interface IncidentStoreOptions {
  escalationThreshold?: number;
  maxEvidencePerRecord?: number;
  now?: () => Date;
}

export interface IncidentEvidenceLogEntry {
  observedAt: string;
  fingerprint: string;
  evidence: IncidentEvidence;
}

type IncidentIndex = Record<string, IncidentRecord>;

export class IncidentStore {
  private readonly incidentsDir: string;
  private readonly escalationThreshold: number;
  private readonly maxEvidencePerRecord: number;
  private readonly now: () => Date;

  constructor(
    incidentsDir: string,
    options: IncidentStoreOptions = {},
  ) {
    this.incidentsDir = incidentsDir;
    this.escalationThreshold = options.escalationThreshold ?? 3;
    this.maxEvidencePerRecord = options.maxEvidencePerRecord ?? 50;
    this.now = options.now ?? (() => new Date());
  }

  computeFingerprint(incident: Pick<IncidentRecord, 'category' | 'rootCauseClass' | 'taskId' | 'evidence'>): string {
    const evidenceKeys = incident.evidence
      .map((evidence) => evidence.key ?? `${evidence.type}:${evidence.source}`)
      .sort();
    const input = [
      incident.category,
      incident.rootCauseClass,
      incident.taskId ?? '',
      JSON.stringify(evidenceKeys),
    ].join('::');
    return createHash('sha256').update(input).digest('hex');
  }

  async upsert(incident: IncidentRecord): Promise<IncidentRecord> {
    mkdirSync(this.incidentsDir, { recursive: true });
    const fingerprint = this.computeFingerprint(incident);
    const indexPath = join(this.incidentsDir, 'index.json');
    const observedAt = this.now().toISOString();
    let stored: IncidentRecord | undefined;

    const updatedIndex = await this.mutateIndex(indexPath, (index) => {
      const existing = index[fingerprint];
      const redactedEvidence = incident.evidence.slice(-this.maxEvidencePerRecord);
      if (existing) {
        const occurrenceCount = (existing.occurrenceCount || 0) + 1;
        const lifecycle = this.nextLifecycle(existing.lifecycle, occurrenceCount);
        const metadata = {
          ...(existing.metadata ?? {}),
          thresholdTriggered: occurrenceCount >= this.escalationThreshold,
          ...(lifecycle === 'active' && existing.lifecycle !== 'active' ? { escalatedAt: observedAt } : {}),
        };
        stored = {
          ...existing,
          schemaVersion: WAVEMILL_INCIDENT_SCHEMA_VERSION,
          severity: this.maxSeverity(existing.severity, incident.severity),
          confidence: this.maxConfidence(existing.confidence, incident.confidence),
          lifecycle,
          lastObservedAt: observedAt,
          occurrenceCount,
          summary: incident.summary,
          operatorAction: incident.operatorAction,
          evidence: [...existing.evidence, ...redactedEvidence].slice(-this.maxEvidencePerRecord),
          metadata,
        };
        index[fingerprint] = stored;
        return index;
      }

      stored = {
        ...incident,
        schemaVersion: WAVEMILL_INCIDENT_SCHEMA_VERSION,
        id: incident.id || randomUUID(),
        fingerprint,
        createdAt: observedAt,
        lastObservedAt: observedAt,
        occurrenceCount: 1,
        lifecycle: incident.lifecycle ?? 'observed',
        evidence: redactedEvidence,
        metadata: {
          ...(incident.metadata ?? {}),
          thresholdTriggered: 1 >= this.escalationThreshold,
        },
      };
      index[fingerprint] = stored;
      return index;
    });

    const record = stored ?? updatedIndex[fingerprint];
    this.appendEvidence(fingerprint, incident.evidence, observedAt);
    return record;
  }

  async getIncidents(): Promise<IncidentRecord[]> {
    const indexPath = join(this.incidentsDir, 'index.json');
    const index = this.readIndex(indexPath);
    return Object.values(index)
      .filter((incident) => incident.lifecycle === 'observed' || incident.lifecycle === 'active')
      .sort((a, b) => Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt));
  }

  async updateMetadata(
    fingerprint: string,
    transform: (incident: IncidentRecord) => IncidentRecord['metadata'],
  ): Promise<IncidentRecord | null> {
    mkdirSync(this.incidentsDir, { recursive: true });
    const indexPath = join(this.incidentsDir, 'index.json');
    let updated: IncidentRecord | null = null;
    await this.mutateIndex(indexPath, (index) => {
      const existing = index[fingerprint];
      if (!existing) return index;
      updated = {
        ...existing,
        metadata: transform(existing),
      };
      index[fingerprint] = updated;
      return index;
    });
    return updated;
  }

  async getEvidenceForIncident(fingerprint: string): Promise<IncidentEvidenceLogEntry[]> {
    const logPath = join(this.incidentsDir, `${fingerprint}.evidence.jsonl`);
    if (!existsSync(logPath)) return [];
    const entries: IncidentEvidenceLogEntry[] = [];
    for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as IncidentEvidenceLogEntry);
      } catch {
        // Evidence logs are append-only; skip malformed legacy/torn lines instead of crashing observer.
      }
    }
    return entries;
  }

  async summaryReport(): Promise<string> {
    const incidents = await this.getIncidents();
    if (incidents.length === 0) return 'No active Wavemill incidents.';

    const lines = ['Wavemill Incidents Report', `Total observed/active: ${incidents.length}`];
    for (const incident of incidents.slice(0, 20)) {
      lines.push('');
      lines.push(`[${incident.lifecycle}/${incident.severity}/${incident.category}] ${incident.summary}`);
      lines.push(`  task: ${incident.taskId ?? '(repo)'}`);
      lines.push(`  rootCause: ${incident.rootCauseClass}`);
      lines.push(`  occurrences: ${incident.occurrenceCount}`);
      lines.push(`  action: ${incident.operatorAction}`);
    }
    if (incidents.length > 20) {
      lines.push('');
      lines.push(`... ${incidents.length - 20} additional incident(s) omitted`);
    }
    return `${lines.join('\n')}\n`;
  }

  private async mutateIndex(indexPath: string, transform: (index: IncidentIndex) => IncidentIndex): Promise<IncidentIndex> {
    try {
      return await mutateJsonState<IncidentIndex>(
        indexPath,
        transform,
        { createIfMissing: true, initial: {} },
      );
    } catch (error) {
      if (!(error instanceof StateParseError)) throw error;
      this.quarantineMalformedIndex(indexPath);
      return mutateJsonState<IncidentIndex>(
        indexPath,
        transform,
        { createIfMissing: true, initial: {} },
      );
    }
  }

  private readIndex(indexPath: string): IncidentIndex {
    if (!existsSync(indexPath)) return {};
    try {
      return JSON.parse(readFileSync(indexPath, 'utf-8')) as IncidentIndex;
    } catch {
      return {};
    }
  }

  private quarantineMalformedIndex(indexPath: string): void {
    if (!existsSync(indexPath)) return;
    mkdirSync(dirname(indexPath), { recursive: true });
    const backupPath = `${indexPath}.malformed.${Date.now()}`;
    renameSync(indexPath, backupPath);
    writeFileSync(indexPath, '{}\n', 'utf-8');
  }

  private appendEvidence(fingerprint: string, evidence: IncidentEvidence[], observedAt: string): void {
    if (evidence.length === 0) return;
    const logPath = join(this.incidentsDir, `${fingerprint}.evidence.jsonl`);
    const lines = evidence.map((item) => JSON.stringify({ observedAt, fingerprint, evidence: item }));
    appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf-8');
  }

  private nextLifecycle(current: IncidentLifecycle, occurrenceCount: number): IncidentLifecycle {
    if (current === 'resolved' || current === 'archived') return current;
    if (occurrenceCount >= this.escalationThreshold) return 'active';
    return current;
  }

  private maxSeverity(a: IncidentRecord['severity'], b: IncidentRecord['severity']): IncidentRecord['severity'] {
    const order: IncidentRecord['severity'][] = ['info', 'low', 'medium', 'high', 'critical'];
    return order.indexOf(b) > order.indexOf(a) ? b : a;
  }

  private maxConfidence(a: IncidentRecord['confidence'], b: IncidentRecord['confidence']): IncidentRecord['confidence'] {
    const order: IncidentRecord['confidence'][] = ['low', 'medium', 'high', 'definite'];
    return order.indexOf(b) > order.indexOf(a) ? b : a;
  }
}
