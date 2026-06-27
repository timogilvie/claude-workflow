/**
 * Linear-facing native workflow tool executors (HOK-2356).
 *
 * Implements linear_get_issue, linear_comment, and expand_issue on top of the
 * contracts, policy matrix, and dedupe-key helpers from HOK-2355.
 *
 * All three tools are created via factory functions that accept injectable
 * dependencies so tests can supply fakes without hitting the network.
 */

import { createHash } from 'node:crypto';
import {
  type WorkflowPhase,
  type LinearGetIssueResult,
  type LinearCommentResult,
  type ExpandIssueResult,
  type LinearCommentRef,
  type WavemillTaskPacketRef,
} from './contracts.ts';
import { isMutationAllowed } from './mutation-policy.ts';
import {
  linearCommentKey,
  expandIssueKey,
  type DedupeRegistry,
  type DedupeRecord,
} from './dedupe.ts';

// ---------------------------------------------------------------------------
// Observable transcript + stage-artifact seams
// ---------------------------------------------------------------------------

export interface WorkflowToolTranscriptEvent {
  type: 'workflow_tool_call';
  tool: string;
  phase: WorkflowPhase;
  action: string;
  details?: Record<string, unknown>;
  idempotency?: {
    key: string;
    outcome: string;
    ref: { system: string; kind: string; id: string; url?: string } | null;
  };
  at: number;
}

export interface WorkflowToolStageArtifactEntry {
  tool: string;
  phase: WorkflowPhase;
  details?: Record<string, unknown>;
  idempotency: {
    key: string;
    outcome: string;
    ref: { system: string; kind: string; id: string; url?: string } | null;
  };
  at: number;
}

// ---------------------------------------------------------------------------
// Injectable Linear client interface
// ---------------------------------------------------------------------------

export interface LinearIssueData {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state?: { name: string } | string;
  assignee?: { name: string; email?: string } | string;
  labels?: { nodes: Array<{ id: string; name: string }> } | string[];
  url?: string;
}

export interface LinearCommentData {
  id: string;
  url: string;
}

export interface LinearClient {
  getIssue(identifier: string): Promise<LinearIssueData>;
  createComment(issueId: string, body: string): Promise<LinearCommentData>;
  updateComment(commentId: string, body: string): Promise<LinearCommentData>;
}

// ---------------------------------------------------------------------------
// Expansion context injected into expand_issue
// ---------------------------------------------------------------------------

export interface ExpansionContext {
  sessionId: string;
  phase: WorkflowPhase;
  outputDir?: string;
}

export type ExpanderFn = (req: { issue: string; outputDir?: string }, ctx: ExpansionContext) => Promise<string>;

// ---------------------------------------------------------------------------
// Tool factory deps
// ---------------------------------------------------------------------------

export interface LinearToolsDeps {
  client: LinearClient;
  registry: DedupeRegistry;
  transcript: { append(event: WorkflowToolTranscriptEvent): void };
  stageArtifact: { append(entry: WorkflowToolStageArtifactEntry): void };
  sessionId: string;
  phase: WorkflowPhase;
  expander?: ExpanderFn;
  clock?: () => number;
}

export interface ExpandIssueDeps {
  registry: DedupeRegistry;
  transcript: { append(event: WorkflowToolTranscriptEvent): void };
  stageArtifact: { append(entry: WorkflowToolStageArtifactEntry): void };
  sessionId: string;
  phase: WorkflowPhase;
  expander?: ExpanderFn;
  clock?: () => number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(deps: Pick<LinearToolsDeps, 'clock'>): number {
  return deps.clock ? deps.clock() : Date.now();
}

/** Trim and collapse interior whitespace for stable body hashing. */
function normalizeBody(body: string): string {
  return body.trim().replace(/\s+/g, ' ');
}

function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function flattenState(state: LinearIssueData['state']): string | undefined {
  if (!state) return undefined;
  if (typeof state === 'string') return state;
  return state.name;
}

function flattenAssignee(assignee: LinearIssueData['assignee']): string | undefined {
  if (!assignee) return undefined;
  if (typeof assignee === 'string') return assignee;
  return assignee.name;
}

function flattenLabels(labels: LinearIssueData['labels']): string[] | undefined {
  if (!labels) return undefined;
  if (Array.isArray(labels)) return labels as string[];
  return labels.nodes.map(l => l.name);
}

// ---------------------------------------------------------------------------
// linear_get_issue
// ---------------------------------------------------------------------------

export async function executeLinearGetIssue(
  params: { issue: string; includeRelations?: boolean; includeComments?: boolean },
  deps: LinearToolsDeps,
): Promise<LinearGetIssueResult> {
  const ts = now(deps);
  try {
    const raw = await deps.client.getIssue(params.issue);
    const result: LinearGetIssueResult = {
      ok: true,
      tool: 'linear_get_issue',
      issue: {
        id: raw.id,
        identifier: raw.identifier,
        title: raw.title,
        description: raw.description,
        state: flattenState(raw.state),
        assignee: flattenAssignee(raw.assignee),
        labels: flattenLabels(raw.labels),
        url: raw.url,
      },
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'linear_get_issue', phase: deps.phase, action: 'read', at: ts });
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNotFound = msg.includes('not found') || msg.includes('not_found');
    const result: LinearGetIssueResult = {
      ok: false,
      tool: 'linear_get_issue',
      error: isNotFound ? 'not_found' : 'external_error',
      message: msg,
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'linear_get_issue', phase: deps.phase, action: 'read', at: ts });
    return result;
  }
}

// ---------------------------------------------------------------------------
// linear_comment
// ---------------------------------------------------------------------------

export async function executeLinearComment(
  params: { issue: string; body: string; sessionId: string; phase: WorkflowPhase; dedupeOverride?: string },
  deps: LinearToolsDeps,
): Promise<LinearCommentResult> {
  const ts = now(deps);
  const phase = params.phase;

  const policy = isMutationAllowed(phase, 'linear_comment', 'comment');
  if (!policy.allowed) {
    const result: LinearCommentResult = {
      ok: false,
      tool: 'linear_comment',
      error: 'policy_denied',
      message: policy.reason,
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'linear_comment', phase, action: 'comment', at: ts });
    deps.stageArtifact.append({ tool: 'linear_comment', phase, idempotency: { key: '', outcome: 'skipped', ref: null }, at: ts });
    return result;
  }

  const normalizedBody = normalizeBody(params.body);
  const key = params.dedupeOverride ?? linearCommentKey({
    issue: params.issue,
    phase,
    sessionId: params.sessionId,
    body: normalizedBody,
  });

  const existing = deps.registry.get(key);
  if (existing) {
    const ref = existing.ref as LinearCommentRef | null;
    const idempotency = { key, outcome: 'reused' as const, ref };
    const result: LinearCommentResult = {
      ok: true,
      tool: 'linear_comment',
      idempotency: { key, outcome: 'reused', ref },
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'linear_comment', phase, action: 'comment', idempotency, at: ts });
    deps.stageArtifact.append({ tool: 'linear_comment', phase, idempotency, at: ts });
    return result;
  }

  try {
    const issue = await deps.client.getIssue(params.issue);
    const comment = await deps.client.createComment(issue.id, params.body);
    const ref: LinearCommentRef = { system: 'linear', kind: 'comment', id: comment.id, url: comment.url };
    const rec: DedupeRecord<LinearCommentRef> = { key, outcome: 'created', ref };
    deps.registry.record(key, rec);
    const idempotency = { key, outcome: 'created' as const, ref };
    const result: LinearCommentResult = {
      ok: true,
      tool: 'linear_comment',
      idempotency: { key, outcome: 'created', ref },
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'linear_comment', phase, action: 'comment', idempotency, at: ts });
    deps.stageArtifact.append({ tool: 'linear_comment', phase, idempotency, at: ts });
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: LinearCommentResult = {
      ok: false,
      tool: 'linear_comment',
      error: 'external_error',
      message: msg,
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'linear_comment', phase, action: 'comment', at: ts });
    deps.stageArtifact.append({ tool: 'linear_comment', phase, idempotency: { key, outcome: 'skipped', ref: null }, at: ts });
    return result;
  }
}

// ---------------------------------------------------------------------------
// expand_issue
// ---------------------------------------------------------------------------

export async function executeExpandIssue(
  params: { issue: string; outputDir?: string },
  deps: ExpandIssueDeps,
): Promise<ExpandIssueResult> {
  const ts = now(deps);
  const phase = deps.phase;

  const policy = isMutationAllowed(phase, 'expand_issue', 'read');
  if (!policy.allowed) {
    const result: ExpandIssueResult = {
      ok: false,
      tool: 'expand_issue',
      error: 'policy_denied',
      message: policy.reason,
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'expand_issue', phase, action: 'read', at: ts });
    return result;
  }

  if (!deps.expander) {
    const result: ExpandIssueResult = {
      ok: false,
      tool: 'expand_issue',
      error: 'expansion_failed',
      message: 'No expander function provided to expand_issue tool',
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'expand_issue', phase, action: 'read', at: ts });
    return result;
  }

  const intentKey = expandIssueKey({
    issue: params.issue,
    phase,
    sessionId: deps.sessionId,
    contentHash: '',
  });

  const existing = deps.registry.get(intentKey);
  if (existing) {
    const ref = existing.ref as WavemillTaskPacketRef | null;
    const taskPacketPath = ref?.id ?? '';
    const idempotency = { key: intentKey, outcome: 'reused' as const, ref };
    const result: ExpandIssueResult = {
      ok: true,
      tool: 'expand_issue',
      taskPacketPath,
      ref: ref ?? undefined,
      idempotency: { key: intentKey, outcome: 'reused', ref },
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'expand_issue', phase, action: 'read', idempotency, at: ts });
    return result;
  }

  try {
    const taskPacketPath = await deps.expander(params, { sessionId: deps.sessionId, phase, outputDir: params.outputDir });

    if (!taskPacketPath || taskPacketPath.trim() === '') {
      const result: ExpandIssueResult = {
        ok: false,
        tool: 'expand_issue',
        error: 'expansion_failed',
        message: 'Expander returned empty task packet path',
      };
      deps.transcript.append({ type: 'workflow_tool_call', tool: 'expand_issue', phase, action: 'read', at: ts });
      return result;
    }

    const ref: WavemillTaskPacketRef = { system: 'wavemill', kind: 'task_packet', id: taskPacketPath };
    const rec: DedupeRecord<WavemillTaskPacketRef> = { key: intentKey, outcome: 'created', ref };
    deps.registry.record(intentKey, rec);
    const idempotency = { key: intentKey, outcome: 'created' as const, ref };
    const result: ExpandIssueResult = {
      ok: true,
      tool: 'expand_issue',
      taskPacketPath,
      ref,
      idempotency: { key: intentKey, outcome: 'created', ref },
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'expand_issue', phase, action: 'read', idempotency, at: ts });
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: ExpandIssueResult = {
      ok: false,
      tool: 'expand_issue',
      error: 'expansion_failed',
      message: msg,
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'expand_issue', phase, action: 'read', at: ts });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

export function createLinearTools(deps: LinearToolsDeps) {
  return {
    linearGetIssue: (params: { issue: string; includeRelations?: boolean; includeComments?: boolean }) =>
      executeLinearGetIssue(params, deps),
    linearComment: (params: { issue: string; body: string; sessionId: string; phase: WorkflowPhase; dedupeOverride?: string }) =>
      executeLinearComment(params, deps),
    expandIssue: (params: { issue: string; outputDir?: string }) =>
      executeExpandIssue(params, deps),
  };
}
