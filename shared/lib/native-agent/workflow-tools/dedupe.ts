/**
 * Dedupe key derivation for workflow tools (HOK-2355).
 *
 * Pure helpers — no filesystem, network, clock, env, or process access.
 * Keys are stable: identical inputs always produce identical outputs.
 * Keys do not embed secrets, full comment bodies, or untrusted payloads.
 *
 * Canonical dedupe key registry (parent epic: docs/native-agent-runtime-plan.md):
 *
 * | Tool               | Key format |
 * |--------------------|------------|
 * | github_create_pr   | github_create_pr:<repo>:<head>:<base>:<headSha> |
 * | github_add_label   | github_add_label:<repo>:<targetKind>:<targetNumber>:<normalizedLabel> |
 * | linear_comment     | linear_comment:<issue>:<phase>:<sessionId>:<contentHash> |
 * | write_stage_result | write_stage_result:<issueOrFeature>:<stage>:<status> |
 */

import { createHash } from 'node:crypto';
import type { WorkflowPhase } from './contracts.ts';

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Trim and lower-case a string for case-insensitive provider semantics. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Produce a short, stable content hash for dedupe key embedding.
 * Uses the first 16 hex chars of SHA-256 — long enough to be collision-safe,
 * short enough not to bloat the key or expose the full content.
 */
function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// github_create_pr
// ---------------------------------------------------------------------------

export interface GitHubCreatePrDedupeInput {
  /** Repository in "owner/repo" form. Lower-cased during normalization. */
  repo: string;
  head: string;
  base: string;
  headSha: string;
}

/**
 * Derive the dedupe key for github_create_pr.
 * Key changes when repo, head branch, base branch, or head SHA changes.
 */
export function githubCreatePrKey(input: GitHubCreatePrDedupeInput): string {
  const repo = normalize(input.repo);
  const head = input.head.trim();
  const base = input.base.trim();
  const sha = input.headSha.trim();
  return `github_create_pr:${repo}:${head}:${base}:${sha}`;
}

// ---------------------------------------------------------------------------
// github_add_label
// ---------------------------------------------------------------------------

export interface GitHubAddLabelDedupeInput {
  /** Repository in "owner/repo" form. Lower-cased during normalization. */
  repo: string;
  targetKind: 'pull_request' | 'issue';
  targetNumber: number;
  /** Label name. Lower-cased to prevent case-only duplicates. */
  label: string;
}

/**
 * Derive the dedupe key for github_add_label.
 * Label is normalized to lower-case because GitHub label lookup is case-insensitive.
 */
export function githubAddLabelKey(input: GitHubAddLabelDedupeInput): string {
  const repo = normalize(input.repo);
  const label = normalize(input.label);
  return `github_add_label:${repo}:${input.targetKind}:${input.targetNumber}:${label}`;
}

// ---------------------------------------------------------------------------
// linear_comment
// ---------------------------------------------------------------------------

export interface LinearCommentDedupeInput {
  /** Linear issue ID or key. */
  issue: string;
  phase: WorkflowPhase;
  sessionId: string;
  /** Full comment body. Only the hash is embedded in the key. */
  body: string;
}

/**
 * Derive the dedupe key for linear_comment.
 * Uses a SHA-256 prefix of the comment body so the key changes when content
 * changes but never embeds the full text in the key.
 */
export function linearCommentKey(input: LinearCommentDedupeInput): string {
  const issue = input.issue.trim();
  const hash = contentHash(input.body);
  return `linear_comment:${issue}:${input.phase}:${input.sessionId.trim()}:${hash}`;
}

// ---------------------------------------------------------------------------
// write_stage_result
// ---------------------------------------------------------------------------

export interface WriteStageResultDedupeInput {
  /** Feature directory path or issue ID — whichever is the stable identifier. */
  issueOrFeature: string;
  stage: string;
  status: string;
}

/**
 * Derive the dedupe key for write_stage_result.
 * Same issue/feature + stage + status always maps to the same key, so
 * idempotent re-runs update rather than duplicate.
 */
export function writeStageResultKey(input: WriteStageResultDedupeInput): string {
  const id = input.issueOrFeature.trim();
  return `write_stage_result:${id}:${input.stage.trim()}:${input.status.trim()}`;
}

// ---------------------------------------------------------------------------
// expand_issue
// ---------------------------------------------------------------------------

export interface ExpandIssueDedupeInput {
  /** Linear issue ID or key. */
  issue: string;
  phase: WorkflowPhase;
  sessionId: string;
  /** SHA-256 prefix of the prior expansion output (or empty string on first run). */
  contentHash: string;
}

/**
 * Derive the dedupe key for expand_issue.
 * Key changes when the issue, phase, session, or expansion content changes.
 */
export function expandIssueKey(input: ExpandIssueDedupeInput): string {
  const issue = input.issue.trim();
  return `expand_issue:${issue}:${input.phase}:${input.sessionId.trim()}:${input.contentHash.trim()}`;
}

// ---------------------------------------------------------------------------
// In-memory dedupe registry
// ---------------------------------------------------------------------------

import type { IdempotencyOutcome, ExternalRef } from './contracts.ts';

export type DedupeOutcome = IdempotencyOutcome;

export interface DedupeRecord<TRef extends ExternalRef = ExternalRef> {
  key: string;
  outcome: DedupeOutcome;
  ref: TRef | null;
  reason?: string;
  recordedAt?: number;
}

export interface DedupeRegistry {
  get(key: string): DedupeRecord | undefined;
  record(key: string, rec: DedupeRecord): void;
  size(): number;
}

/**
 * Create a process-scoped in-memory dedupe registry.
 * Denials and errors must NOT call record() — only the tool layer writes entries.
 */
export function createInMemoryDedupeRegistry(opts?: { clock?: () => number }): DedupeRegistry {
  const clock = opts?.clock ?? (() => Date.now());
  const store = new Map<string, DedupeRecord>();
  return {
    get(key: string) {
      return store.get(key);
    },
    record(key: string, rec: DedupeRecord) {
      store.set(key, { ...rec, recordedAt: rec.recordedAt ?? clock() });
    },
    size() {
      return store.size;
    },
  };
}
