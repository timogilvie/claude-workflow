import { dirname, join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import {
  classifyLinearError,
  createComment,
  createIssue,
  getIssue,
  getOrCreateLabel,
  resolveTeamId,
  searchIssues,
  type ClassifiedLinearError,
  type LinearIssueSummary,
} from './linear.ts';
import type { IncidentLinearConfig, IncidentLinearPolicyConfig } from './config.ts';
import type { IncidentRecord } from './wavemill-incident-model.ts';
import { IncidentStore } from './wavemill-incident-store.ts';
import { evidenceHash, IncidentToLinearFormatter } from './linear-incident-formatter.ts';

export type SyncAction = 'created' | 'updated' | 'skipped' | 'error';

export interface SyncResult {
  incident: IncidentRecord;
  action: SyncAction;
  linearIssueId?: string;
  linearIssueUrl?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface IncidentLinearClient {
  resolveTeamId(teamKeyOrId: string): Promise<string>;
  searchIssues(term: string, options: { teamKey?: string; projectId?: string; includeCompleted?: boolean; first?: number }): Promise<LinearIssueSummary[]>;
  getIssue(identifier: string): Promise<LinearIssueSummary>;
  getOrCreateLabel(name: string, teamId: string): Promise<{ id: string; name: string }>;
  createIssue(params: { title: string; description: string; teamId: string; projectId?: string; priority?: number; labelIds?: string[] }): Promise<LinearIssueSummary>;
  createComment(issueId: string, body: string): Promise<{ id: string; url: string }>;
}

export interface IncidentToLinearSyncOptions {
  dryRun?: boolean;
  now?: () => Date;
  log?: Pick<Console, 'warn' | 'error' | 'log'>;
  formatter?: IncidentToLinearFormatter;
}

const DEFAULT_POLICIES: Required<NonNullable<IncidentLinearConfig['policies']>> = {
  product_defect: { enabled: true, priority: 2 },
  model_task_harness_outcome: { enabled: true, updateExistingOnly: true, correlateWith: ['HOK-2593'] },
  external_transient_dependency: { enabled: true, requireThreshold: true, minOccurrences: 3 },
  configuration_operator_condition: { enabled: true, requirePersistent: true },
  stale_orphaned_state: { enabled: true, requirePersistent: true },
};

const locks = new Map<string, Promise<unknown>>();

export class IncidentToLinearSync {
  private readonly linearClient: IncidentLinearClient;
  private readonly store: IncidentStore;
  private readonly config: IncidentLinearConfig;
  private readonly dryRun: boolean;
  private readonly now: () => Date;
  private readonly formatter: IncidentToLinearFormatter;
  private readonly log: Pick<Console, 'warn' | 'error' | 'log'>;

  constructor(
    linearClient: IncidentLinearClient,
    store: IncidentStore,
    config: IncidentLinearConfig,
    options: IncidentToLinearSyncOptions = {},
  ) {
    this.linearClient = linearClient;
    this.store = store;
    this.config = config;
    this.dryRun = options.dryRun ?? config.dryRun ?? false;
    this.now = options.now ?? (() => new Date());
    this.formatter = options.formatter ?? new IncidentToLinearFormatter();
    this.log = options.log ?? console;
  }

  async searchExistingIssue(incident: IncidentRecord): Promise<LinearIssueSummary | null> {
    const hinted = await this.issueFromMetadata(incident);
    if (hinted && isOpenIssue(hinted)) return hinted;

    const terms = [
      `incident-${incident.fingerprint.slice(0, 12)}`,
      incident.fingerprint,
      incident.rootCauseClass,
      componentFromRootCause(incident.rootCauseClass),
    ].filter((term, index, arr): term is string => Boolean(term) && arr.indexOf(term) === index);

    for (const term of terms) {
      try {
        const matches = await this.linearClient.searchIssues(term, {
          teamKey: this.config.teamKey,
          projectId: this.config.projectId,
          includeCompleted: false,
          first: 10,
        });
        const match = matches.find((issue) => isOpenIssue(issue) && issueMatchesIncident(issue, incident, term));
        if (match) return match;
      } catch (error) {
        this.log.warn(`incident linear search failed for ${incident.fingerprint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return null;
  }

  async createIssue(incident: IncidentRecord): Promise<LinearIssueSummary> {
    const title = this.formatter.formatIssueTitle(incident);

    if (this.dryRun) {
      this.log.log(`DRY-RUN: Would create Linear issue ${title}`);
      return {
        id: `dry-run-${incident.fingerprint}`,
        identifier: `DRY-${incident.fingerprint.slice(0, 6)}`,
        title,
        url: undefined,
      };
    }

    const teamId = await this.resolveTeamId();
    const labelIds = await this.resolveLabelIds(teamId, incident);
    const policy = this.policyFor(incident);
    const description = this.formatter.formatIssueDescription(incident, this.config);
    const hash = evidenceHash(incident);
    const syncedAt = this.now().toISOString();
    const issue = await this.linearClient.createIssue({
      title,
      description,
      teamId,
      projectId: this.config.projectId,
      priority: policy.priority,
      labelIds,
    });
    await this.store.updateMetadata(incident.fingerprint, (stored) => ({
      ...(stored.metadata ?? {}),
      linearIssueId: issue.id,
      linearIssueIdentifier: issue.identifier,
      linearIssueUrl: issue.url,
      linearSyncedAt: syncedAt,
      linearEvidenceRevision: 1,
      linearEvidenceHash: hash,
      linearSyncCooldownExpires: this.cooldownExpiry().toISOString(),
    }));
    return issue;
  }

  async updateExistingIssue(issue: LinearIssueSummary, incident: IncidentRecord): Promise<'updated' | 'skipped'> {
    const currentHash = evidenceHash(incident);
    const storedHash = typeof incident.metadata.linearEvidenceHash === 'string' ? incident.metadata.linearEvidenceHash : undefined;
    const cooldown = typeof incident.metadata.linearSyncCooldownExpires === 'string'
      ? Date.parse(incident.metadata.linearSyncCooldownExpires)
      : 0;
    const nowMs = this.now().getTime();

    if (storedHash === currentHash) return 'skipped';
    if (Number.isFinite(cooldown) && cooldown > nowMs) return 'skipped';

    const oldRevision = typeof incident.metadata.linearEvidenceRevision === 'number' ? incident.metadata.linearEvidenceRevision : 0;
    const newRevision = oldRevision + 1;
    const body = oldRevision > 0
      ? this.formatter.formatCommentAsUpdate(incident, oldRevision, newRevision)
      : this.formatter.formatEvidenceComment(incident, newRevision);

    if (this.dryRun) {
      this.log.log(`DRY-RUN: Would append evidence comment to ${issue.identifier}`);
      return 'updated';
    }

    await this.linearClient.createComment(issue.id, body);
    await this.store.updateMetadata(incident.fingerprint, (stored) => ({
      ...(stored.metadata ?? {}),
      linearIssueId: issue.id,
      linearIssueIdentifier: issue.identifier,
      linearIssueUrl: issue.url ?? stored.metadata.linearIssueUrl,
      linearSyncedAt: this.now().toISOString(),
      linearEvidenceRevision: newRevision,
      linearEvidenceHash: currentHash,
      linearSyncCooldownExpires: this.cooldownExpiry().toISOString(),
    }));
    return 'updated';
  }

  shouldSync(incident: IncidentRecord, existingIssue?: LinearIssueSummary | null): boolean {
    if (this.config.enabled !== true && !this.dryRun) return false;
    if (incident.lifecycle !== 'active' || incident.metadata.thresholdTriggered !== true) return false;

    const policy = this.policyFor(incident);
    if (policy.enabled === false) return false;
    if (incident.category === 'model_task_harness_outcome') {
      return policy.updateExistingOnly === true ? Boolean(existingIssue) : true;
    }
    if (incident.category === 'external_transient_dependency') {
      const min = policy.minOccurrences ?? 3;
      return policy.requireThreshold === false || incident.occurrenceCount >= min;
    }
    if (incident.category === 'configuration_operator_condition' || incident.category === 'stale_orphaned_state') {
      return policy.requirePersistent === false || incident.metadata.persistent === true;
    }
    return true;
  }

  async sync(incidents: IncidentRecord[]): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const incident of incidents) {
      results.push(await this.withIncidentLock(incident.fingerprint, () => this.syncOne(incident)));
    }
    return results;
  }

  private async syncOne(incident: IncidentRecord): Promise<SyncResult> {
    try {
      if (incident.metadata.linearIssueId && incident.metadata.linearIssueIdentifier) {
        const issue = {
          id: String(incident.metadata.linearIssueId),
          identifier: String(incident.metadata.linearIssueIdentifier),
          title: '',
          url: typeof incident.metadata.linearIssueUrl === 'string' ? incident.metadata.linearIssueUrl : undefined,
        };
        const action = await this.updateExistingIssue(issue, incident);
        return {
          incident,
          action: action === 'updated' ? 'updated' : 'skipped',
          linearIssueId: issue.id,
          linearIssueUrl: issue.url,
        };
      }

      const existing = await this.searchExistingIssue(incident);
      if (!this.shouldSync(incident, existing)) {
        return { incident, action: 'skipped', metadata: { reason: 'policy' } };
      }
      if (existing) {
        const action = await this.updateExistingIssue(existing, incident);
        return { incident, action: action === 'updated' ? 'updated' : 'skipped', linearIssueId: existing.id, linearIssueUrl: existing.url };
      }

      const issue = await this.createIssue(incident);
      return { incident, action: 'created', linearIssueId: issue.id, linearIssueUrl: issue.url };
    } catch (error) {
      const classified = classifyLinearError(error);
      await this.persistSyncFailure(incident, classified);
      return {
        incident,
        action: 'error',
        errorMessage: classified.message,
        metadata: { retryable: classified.isRetryable, category: classified.category },
      };
    }
  }

  private async issueFromMetadata(incident: IncidentRecord): Promise<LinearIssueSummary | null> {
    const ids = [incident.metadata.linearRelatedIssueId, incident.metadata.relatedLinearId]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const id of ids) {
      if (!/^[A-Z]+-\d+(?:_c)?$/.test(id)) continue;
      try {
        const issue = await this.linearClient.getIssue(id);
        if (isOpenIssue(issue)) return issue;
      } catch {
        // A stale detector hint should not block search-before-create.
      }
    }
    return null;
  }

  private async resolveTeamId(): Promise<string> {
    if (!this.config.teamKey) {
      throw new Error('incident.linear.teamKey is required for Linear incident sync');
    }
    return this.linearClient.resolveTeamId(this.config.teamKey);
  }

  private async resolveLabelIds(teamId: string, incident: IncidentRecord): Promise<string[]> {
    const names = [this.config.labelName ?? 'incident-detector', `incident:${incident.category}`];
    const ids: string[] = [];
    for (const name of names) {
      const label = await this.linearClient.getOrCreateLabel(name, teamId);
      ids.push(label.id);
    }
    return ids;
  }

  private policyFor(incident: IncidentRecord): IncidentLinearPolicyConfig {
    return {
      ...DEFAULT_POLICIES[incident.category],
      ...(this.config.policies?.[incident.category] ?? {}),
    };
  }

  private cooldownExpiry(): Date {
    return new Date(this.now().getTime() + (this.config.updateCooldownMinutes ?? 30) * 60_000);
  }

  private async persistSyncFailure(incident: IncidentRecord, classified: ClassifiedLinearError): Promise<void> {
    try {
      await this.store.updateMetadata(incident.fingerprint, (stored) => ({
        ...(stored.metadata ?? {}),
        linearLastSyncError: classified.message,
        linearLastSyncErrorAt: this.now().toISOString(),
        linearLastSyncRetryable: classified.isRetryable,
      }));
    } catch {
      // Preserve observer stability; original error is returned in SyncResult.
    }
  }

  private async withIncidentLock<T>(fingerprint: string, work: () => Promise<T>): Promise<T> {
    const prior = locks.get(fingerprint) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = prior.then(() => current);
    locks.set(fingerprint, chained);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (locks.get(fingerprint) === chained) {
        locks.delete(fingerprint);
      }
    }
  }
}

export const defaultIncidentLinearClient: IncidentLinearClient = {
  resolveTeamId,
  searchIssues,
  async getIssue(identifier: string): Promise<LinearIssueSummary> {
    const issue = await getIssue(identifier);
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      completedAt: issue.completedAt,
      canceledAt: issue.canceledAt,
      url: issue.url,
    };
  },
  async getOrCreateLabel(name: string, teamId: string) {
    return getOrCreateLabel(name, teamId);
  },
  async createIssue(params) {
    const issue = await createIssue(params);
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      completedAt: issue.completedAt,
      canceledAt: issue.canceledAt,
      url: issue.url,
    };
  },
  createComment,
};

export function writeIncidentLinearAudit(repoDir: string, results: SyncResult[], now = new Date()): void {
  if (results.length === 0) return;
  const path = join(repoDir, '.wavemill', 'incidents', 'sync-audit.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  const lines = results.map((result) => JSON.stringify({
    timestamp: now.toISOString(),
    incidentFingerprint: result.incident.fingerprint,
    action: result.action,
    linearIssueId: result.linearIssueId,
    linearIssueUrl: result.linearIssueUrl,
    occurrenceCount: result.incident.occurrenceCount,
    errorMessage: result.errorMessage,
    metadata: result.metadata,
  }));
  appendFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
}

function issueMatchesIncident(issue: LinearIssueSummary, incident: IncidentRecord, term: string): boolean {
  const title = issue.title.toLowerCase();
  return title.includes(incident.fingerprint.slice(0, 12).toLowerCase())
    || title.includes(incident.rootCauseClass.toLowerCase())
    || title.includes(term.toLowerCase());
}

function isOpenIssue(issue: LinearIssueSummary): boolean {
  return issue.completedAt == null && issue.canceledAt == null;
}

function componentFromRootCause(rootCauseClass: string): string | null {
  const first = rootCauseClass.split(/[_:\-.]/)[0]?.trim();
  return first && first !== rootCauseClass ? first : null;
}
