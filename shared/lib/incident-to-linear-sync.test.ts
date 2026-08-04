import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IncidentToLinearSync,
  type IncidentLinearClient,
} from './incident-to-linear-sync.ts';
import { IncidentStore } from './wavemill-incident-store.ts';
import { createIncidentDraft, type IncidentRecord } from './wavemill-incident-model.ts';
import { IncidentToLinearFormatter, redactSensitiveContent } from './linear-incident-formatter.ts';
import type { IncidentLinearConfig } from './config.ts';
import type { LinearIssueSummary } from './linear.ts';

function incident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return createIncidentDraft({
    taskId: 'HOK-1_c',
    session: 'wavemill',
    category: 'product_defect',
    severity: 'high',
    confidence: 'definite',
    lifecycle: 'observed',
    rootCauseClass: 'planning_turn_limit',
    summary: 'Planning exceeded turn limit for HOK-1_c',
    operatorAction: 'Inspect planning turn budget and correlate with eval outcome tracking.',
    evidence: [{
      type: 'planning_result',
      source: '.planning-result.json',
      timestamp: '2026-08-03T12:00:00.000Z',
      redactedData: 'status=failed OPENAI_API_KEY=sk-secret1234567890 prompt: write code that leaks data',
      key: 'turn_limit',
    }],
    metadata: {},
    ...overrides,
  });
}

async function activeStoredIncident(store: IncidentStore, input: IncidentRecord = incident()): Promise<IncidentRecord> {
  await store.upsert(input);
  await store.upsert(input);
  return store.upsert(input);
}

function config(overrides: IncidentLinearConfig = {}): IncidentLinearConfig {
  return {
    enabled: true,
    teamKey: 'HOK',
    projectId: 'project-1',
    labelName: 'incident-detector',
    updateCooldownMinutes: 30,
    ...overrides,
  };
}

function mockClient(): IncidentLinearClient & {
  issues: LinearIssueSummary[];
  created: Array<{ title: string; description: string; labelIds?: string[]; priority?: number }>;
  comments: Array<{ issueId: string; body: string }>;
  searches: string[];
} {
  return {
    issues: [],
    created: [],
    comments: [],
    searches: [],
    async resolveTeamId() {
      return 'team-1';
    },
    async searchIssues(term) {
      this.searches.push(term);
      return this.issues.filter((issue) => issue.title.includes(term));
    },
    async getIssue(identifier) {
      const issue = this.issues.find((item) => item.identifier === identifier);
      if (!issue) throw new Error(`not found: ${identifier}`);
      return issue;
    },
    async getOrCreateLabel(name) {
      return { id: `label-${name}`, name };
    },
    async createIssue(params) {
      this.created.push(params);
      const issue = {
        id: `issue-${this.created.length}`,
        identifier: `HOK-${100 + this.created.length}`,
        title: params.title,
        url: `https://linear.app/hokusai/issue/HOK-${100 + this.created.length}`,
      };
      this.issues.push(issue);
      return issue;
    },
    async createComment(issueId, body) {
      this.comments.push({ issueId, body });
      return { id: `comment-${this.comments.length}`, url: `https://linear.app/comment-${this.comments.length}` };
    },
  };
}

test('formatter includes required sections and redacts sensitive content', () => {
  const formatter = new IncidentToLinearFormatter();
  const record = incident({ fingerprint: 'abcdef1234567890' });
  const description = formatter.formatIssueDescription(record, config());

  assert.match(formatter.formatIssueTitle(record), /incident-abcdef123456/);
  assert.match(description, /## Root Cause Class/);
  assert.match(description, /## Severity & Confidence/);
  assert.match(description, /## Evidence Summary/);
  assert.doesNotMatch(description, /sk-secret/);
  assert.doesNotMatch(description, /write code that leaks/);
  assert.match(redactSensitiveContent('Authorization: Bearer eyJ123456789012345'), /Bearer \[redacted\]/);
});

test('create sync writes one Linear issue and persists metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-linear-create-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const record = await activeStoredIncident(store);
    const client = mockClient();
    const sync = new IncidentToLinearSync(client, store, config(), { now: () => new Date('2026-08-04T12:00:00.000Z') });

    const [result] = await sync.sync([record]);

    assert.equal(result.action, 'created');
    assert.equal(client.created.length, 1);
    assert.match(client.created[0].title, /incident-/);
    assert.doesNotMatch(client.created[0].description, /sk-secret/);
    assert.deepEqual(client.created[0].labelIds, ['label-incident-detector', 'label-incident:product_defect']);

    const [stored] = await store.getIncidents();
    assert.equal(stored.metadata.linearIssueId, 'issue-1');
    assert.equal(stored.metadata.linearIssueIdentifier, 'HOK-101');
    assert.equal(stored.metadata.linearEvidenceRevision, 1);
    assert.equal(typeof stored.metadata.linearEvidenceHash, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same stored evidence after restart is skipped without duplicate comments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-linear-restart-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const record = await activeStoredIncident(store);
    const client = mockClient();
    const sync = new IncidentToLinearSync(client, store, config(), { now: () => new Date('2026-08-04T12:00:00.000Z') });
    await sync.sync([record]);

    const [fresh] = await store.getIncidents();
    const [again] = await sync.sync([fresh]);

    assert.equal(again.action, 'skipped');
    assert.equal(client.created.length, 1);
    assert.equal(client.comments.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new evidence updates linked issue once cooldown expires', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-linear-update-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const record = await activeStoredIncident(store);
    const client = mockClient();
    const sync = new IncidentToLinearSync(client, store, config(), { now: () => new Date('2026-08-04T12:00:00.000Z') });
    await sync.sync([record]);

    await store.upsert(incident({
      evidence: [{
        type: 'planning_result',
        source: '.planning-result.json',
        timestamp: '2026-08-04T13:00:00.000Z',
        redactedData: 'status=failed failureReason=turn_limit',
        key: 'turn_limit',
      }],
    }));
    const [fresh] = await store.getIncidents();
    const laterSync = new IncidentToLinearSync(client, store, config(), { now: () => new Date('2026-08-04T12:31:00.000Z') });
    const [updated] = await laterSync.sync([fresh]);

    assert.equal(updated.action, 'updated');
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0].body, /Revision 2/);
    const [stored] = await store.getIncidents();
    assert.equal(stored.metadata.linearEvidenceRevision, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search correlation updates open issue instead of creating duplicate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-linear-search-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const record = await activeStoredIncident(store);
    const client = mockClient();
    client.issues.push({
      id: 'existing-1',
      identifier: 'HOK-2593',
      title: `existing ${record.rootCauseClass} planning issue`,
      url: 'https://linear.app/hokusai/issue/HOK-2593',
    });
    const sync = new IncidentToLinearSync(client, store, config(), { now: () => new Date('2026-08-04T12:00:00.000Z') });

    const [result] = await sync.sync([record]);

    assert.equal(result.action, 'updated');
    assert.equal(client.created.length, 0);
    assert.equal(client.comments.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('policy blocks model outcomes without existing issue and one-off external transients', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-linear-policy-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 1 });
    const client = mockClient();
    const sync = new IncidentToLinearSync(client, store, config(), { dryRun: true });
    const modelOutcome = incident({
      category: 'model_task_harness_outcome',
      lifecycle: 'active',
      occurrenceCount: 1,
      rootCauseClass: 'turn_limit',
      metadata: { thresholdTriggered: true },
    });
    const transient = incident({
      category: 'external_transient_dependency',
      lifecycle: 'active',
      occurrenceCount: 1,
      rootCauseClass: 'github_ssh_disconnect',
      metadata: { thresholdTriggered: true },
    });

    assert.equal(sync.shouldSync(modelOutcome, null), false);
    assert.equal(sync.shouldSync(transient, null), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run reports create without Linear writes or metadata mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-linear-dryrun-'));
  try {
    const store = new IncidentStore(dir, { escalationThreshold: 3 });
    const record = await activeStoredIncident(store);
    const client = mockClient();
    const sync = new IncidentToLinearSync(client, store, config({ dryRun: true }), { dryRun: true, log: { log() {}, warn() {}, error() {} } });

    const [result] = await sync.sync([record]);

    assert.equal(result.action, 'created');
    assert.equal(client.created.length, 0);
    const [stored] = await store.getIncidents();
    assert.equal(stored.metadata.linearIssueId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
