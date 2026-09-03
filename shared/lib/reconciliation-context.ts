/**
 * Post-PR reconciliation capsule (HOK-2936).
 *
 * A durable, head-keyed context contract persisted after PR creation so a
 * fresh agent can safely repair deterministic CI failures or merge conflicts
 * without relying on tmux scrollback, a live process, or provider
 * session-resume support. Conversational session resume is an optional cost
 * optimization; the capsule on disk is the source of truth.
 *
 * The capsule separates:
 *  - `foundation`: immutable task context (task identity, packet digest,
 *    PR/branch identity, execution-contract reference). Serialized first in
 *    canonical stable key order so provider prompt caches can reuse the
 *    projected prefix across attempts.
 *  - `incident`: volatile evidence for the current failure episode
 *    (classification, fingerprint, failing checks / conflict files, bounded
 *    excerpts). Appended after the foundation in the projection.
 *
 * Large artifacts (task packets, logs, review results) stay referenced by
 * digest-checked paths and are loaded on demand — never copied wholesale into
 * the prompt.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECONCILIATION_SCHEMA_VERSION = 1;

/** Hard ceiling on the serialized capsule and on the projected prompt (REQ-F8). */
export const MAX_CAPSULE_BYTES = 64 * 1024;
/** Per-excerpt bound for log evidence embedded in the incident. */
export const MAX_EXCERPT_BYTES = 4096;
/** Bound for free-form detail strings. */
export const MAX_DETAIL_BYTES = 4096;
/** Attempt history is bounded; oldest summaries are dropped first. */
export const MAX_ATTEMPTS = 100;
const MAX_FAILING_CHECKS = 50;
const MAX_CONFLICT_FILES = 200;

export const CAPSULE_FILE_NAME = '.reconciliation-context.json';

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'reconciliation-context.schema.json',
);

export type IncidentClassification =
  | 'stale_base_clean'
  | 'ci_transient'
  | 'ci_deterministic_safe'
  | 'merge_conflict'
  | 'ambiguous'
  | 'exhausted';

/** Classifications that may launch an LLM worker (REQ-F3). */
export const LLM_LAUNCHABLE_CLASSIFICATIONS: readonly IncidentClassification[] = [
  'ci_deterministic_safe',
  'merge_conflict',
];

export type CapsuleInvalidReason =
  | 'capsule_missing'
  | 'capsule_malformed'
  | 'capsule_oversized'
  | 'capsule_digest_mismatch'
  | 'capsule_schema_version_unsupported'
  | 'capsule_write_failed';

export interface ReconciliationFoundation {
  taskId: string;
  taskTitle: string;
  slug: string;
  branch: string;
  baseBranch: string;
  prNumber: number;
  taskPacketPath: string | null;
  taskPacketDigest: string | null;
  executionContractPath: string;
  executionContractStage: 'planning' | 'coding' | 'review';
  scopeSummary: string | null;
  createdAt: string;
}

export interface FailingCheckEvidence {
  name: string;
  failingJob?: string | null;
  localCommand?: string | null;
  logExcerpt?: string | null;
  logUrl?: string | null;
}

export interface ReconciliationIncident {
  classification: IncidentClassification;
  headSha: string;
  baseSha: string | null;
  failureFingerprint: string;
  detail: string;
  observedAt: string;
  failingChecks?: FailingCheckEvidence[];
  conflictFiles?: string[];
  evidenceGaps?: string[];
}

export interface UsageMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export type AttemptCost =
  | { available: true; usd: number }
  | { available: false; reason: string };

export type AttemptOutcome =
  | 'launched'
  | 'commit_pushed'
  | 'no_commit'
  | 'push_failed'
  | 'launch_failed'
  | 'unknown';

export interface ReconciliationAttempt {
  attemptNumber: number;
  classification: IncidentClassification;
  failureFingerprint: string;
  headSha: string;
  agent: string | null;
  model: string | null;
  provider: string | null;
  launchMode: 'fresh' | 'resume';
  startedAt: string;
  finishedAt?: string | null;
  usage: UsageMetrics | null;
  cost: AttemptCost;
  outcome: AttemptOutcome;
  resultCommitSha: string | null;
}

export interface ReconciliationCapsule {
  schemaVersion: typeof RECONCILIATION_SCHEMA_VERSION;
  foundation: ReconciliationFoundation;
  foundationDigest: string;
  review: {
    reviewHeadSha: string | null;
    reviewResultPath: string;
    verdict: string | null;
    recordedAt: string;
  };
  incident?: ReconciliationIncident | null;
  incidentFingerprint?: string | null;
  attempts: ReconciliationAttempt[];
  sessionResume?: { provider: string; sessionId: string } | null;
  updatedAt: string;
}

export type CapsuleReadResult =
  | { ok: true; capsule: ReconciliationCapsule }
  | { ok: false; reason: CapsuleInvalidReason; detail: string };

export type CapsuleWriteResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'capsule_oversized' | 'capsule_write_failed'; detail: string };

// ── Canonical serialization and digests ──────────────────────────────────────

/**
 * Canonical JSON: recursively sorted object keys, no whitespace. Reordering
 * keys in a source object never changes the canonical form (REQ-F2 edge case).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function computeFoundationDigest(foundation: ReconciliationFoundation): string {
  return sha256Hex(canonicalJson(foundation));
}

/**
 * Fingerprint of the volatile incident, excluding wall-clock fields so a
 * re-observation of the same failure keeps the same fingerprint.
 */
export function computeIncidentFingerprint(incident: ReconciliationIncident): string {
  const { observedAt: _observedAt, detail: _detail, ...stable } = incident;
  return sha256Hex(canonicalJson(stable));
}

/**
 * Stable failure fingerprint from arbitrary evidence parts (check names,
 * failing jobs, conflict file lists). Order-insensitive.
 */
export function buildFailureFingerprint(parts: string[]): string {
  const cleaned = parts.map((part) => part.trim()).filter(Boolean).sort();
  return sha256Hex(cleaned.join('\n')).slice(0, 32);
}

// ── Redaction and bounding ───────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  // KEY=value / TOKEN: value style assignments
  /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*[^\s"']+/g,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  // Common provider token prefixes
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\blin_api_[A-Za-z0-9]{8,}\b/g,
];

/** Remove secret-shaped content from free text (REQ-F8). */
export function redactText(text: string): string {
  let out = text;
  out = out.replace(SECRET_PATTERNS[0], '$1=[REDACTED]');
  for (const pattern of SECRET_PATTERNS.slice(1)) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/** Redact then truncate to a byte bound (UTF-8 safe at char granularity). */
export function boundText(text: string, maxBytes: number): string {
  const redacted = redactText(text);
  if (Buffer.byteLength(redacted, 'utf-8') <= maxBytes) return redacted;
  let sliced = redacted;
  while (Buffer.byteLength(sliced, 'utf-8') > maxBytes - 16) {
    const overshoot = Math.ceil((Buffer.byteLength(sliced, 'utf-8') - (maxBytes - 16)) / 4);
    sliced = sliced.slice(0, Math.max(0, sliced.length - Math.max(1, overshoot)));
  }
  return `${sliced}\n[truncated]`;
}

/** Normalize an incident: bound and redact all volatile evidence fields. */
export function normalizeIncident(incident: ReconciliationIncident): ReconciliationIncident {
  const normalized: ReconciliationIncident = {
    classification: incident.classification,
    headSha: incident.headSha,
    baseSha: incident.baseSha ?? null,
    failureFingerprint: incident.failureFingerprint,
    detail: boundText(incident.detail ?? '', MAX_DETAIL_BYTES),
    observedAt: incident.observedAt,
  };
  if (incident.failingChecks) {
    normalized.failingChecks = incident.failingChecks.slice(0, MAX_FAILING_CHECKS).map((check) => ({
      name: boundText(check.name, 256),
      ...(check.failingJob != null ? { failingJob: boundText(check.failingJob, 256) } : {}),
      ...(check.localCommand != null ? { localCommand: boundText(check.localCommand, 1024) } : {}),
      ...(check.logExcerpt != null ? { logExcerpt: boundText(check.logExcerpt, MAX_EXCERPT_BYTES) } : {}),
      ...(check.logUrl != null ? { logUrl: check.logUrl.slice(0, 1024) } : {}),
    }));
  }
  if (incident.conflictFiles) {
    normalized.conflictFiles = incident.conflictFiles.slice(0, MAX_CONFLICT_FILES).map((file) => file.slice(0, 1024));
  }
  if (incident.evidenceGaps && incident.evidenceGaps.length > 0) {
    normalized.evidenceGaps = incident.evidenceGaps.slice(0, 20).map((gap) => gap.slice(0, 512));
  }
  return normalized;
}

/** Normalize usage metrics: absent metrics are null, never zero (REQ-F7). */
export function normalizeUsage(raw: Partial<Record<keyof UsageMetrics, unknown>> | null | undefined): UsageMetrics | null {
  if (!raw) return null;
  const toCount = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const usage: UsageMetrics = {
    inputTokens: toCount(raw.inputTokens),
    outputTokens: toCount(raw.outputTokens),
    cacheReadTokens: toCount(raw.cacheReadTokens),
    cacheWriteTokens: toCount(raw.cacheWriteTokens),
  };
  if (usage.inputTokens === null && usage.outputTokens === null && usage.cacheReadTokens === null && usage.cacheWriteTokens === null) {
    return null;
  }
  return usage;
}

/**
 * Compute attempt cost from usage and optional per-million-token pricing.
 * Unknown pricing records cost as unavailable with a reason — never zero.
 */
export function computeAttemptCost(
  usage: UsageMetrics | null,
  pricing?: { inputPerMTok: number; outputPerMTok: number } | null,
): AttemptCost {
  if (!usage || (usage.inputTokens === null && usage.outputTokens === null)) {
    return { available: false, reason: 'usage_unavailable' };
  }
  if (!pricing) {
    return { available: false, reason: 'pricing_unavailable' };
  }
  const usd =
    ((usage.inputTokens ?? 0) / 1_000_000) * pricing.inputPerMTok +
    ((usage.outputTokens ?? 0) / 1_000_000) * pricing.outputPerMTok;
  return { available: true, usd: Number(usd.toFixed(6)) };
}

// ── Schema validation ────────────────────────────────────────────────────────

type SchemaValidator = (value: unknown) => boolean;
let cachedValidator: { validate: SchemaValidator; errorsText: () => string } | null = null;

function getValidator(): { validate: SchemaValidator; errorsText: () => string } {
  if (cachedValidator) return cachedValidator;
  const require = createRequire(import.meta.url);
  const ajvModule = require('ajv');
  const AjvCtor = ajvModule.default || ajvModule;
  const ajv = new AjvCtor({ allErrors: false, strict: false });
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  const compiled = ajv.compile(schema);
  cachedValidator = {
    validate: (value: unknown) => compiled(value) as boolean,
    errorsText: () => ajv.errorsText(compiled.errors),
  };
  return cachedValidator;
}

// ── Capsule construction, persistence, and reads ─────────────────────────────

export function capsulePath(featureDir: string): string {
  return path.join(featureDir, CAPSULE_FILE_NAME);
}

export function buildFoundation(input: {
  taskId: string;
  taskTitle: string;
  slug: string;
  branch: string;
  baseBranch: string;
  prNumber: number;
  taskPacketPath?: string | null;
  executionContractPath: string;
  executionContractStage?: 'planning' | 'coding' | 'review';
  scopeSummary?: string | null;
  createdAt?: string;
}): ReconciliationFoundation {
  let taskPacketDigest: string | null = null;
  let taskPacketPath: string | null = input.taskPacketPath ?? null;
  if (taskPacketPath) {
    try {
      taskPacketDigest = sha256Hex(readFileSync(taskPacketPath));
    } catch {
      taskPacketPath = null;
    }
  }
  return {
    taskId: input.taskId,
    taskTitle: boundText(input.taskTitle ?? '', 512),
    slug: input.slug,
    branch: input.branch,
    baseBranch: input.baseBranch,
    prNumber: input.prNumber,
    taskPacketPath,
    taskPacketDigest,
    executionContractPath: input.executionContractPath,
    executionContractStage: input.executionContractStage ?? 'coding',
    scopeSummary: input.scopeSummary != null ? boundText(input.scopeSummary, MAX_DETAIL_BYTES) : null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function serializeCapsule(capsule: ReconciliationCapsule): string {
  // Compact canonical form: keeps a 100-attempt history comfortably inside the
  // 64 KiB ceiling. Inspect with `jq .` rather than expecting pretty-printing.
  return `${canonicalJson(capsule)}\n`;
}

/**
 * Atomically persist the capsule: same-directory temp file + rename. Enforces
 * the serialized size ceiling and never leaves a partial file behind.
 */
export function writeCapsule(featureDir: string, capsule: ReconciliationCapsule): CapsuleWriteResult {
  const target = capsulePath(featureDir);
  const serialized = serializeCapsule(capsule);
  const bytes = Buffer.byteLength(serialized, 'utf-8');
  if (bytes > MAX_CAPSULE_BYTES) {
    return {
      ok: false,
      reason: 'capsule_oversized',
      detail: `serialized capsule is ${bytes} bytes (limit ${MAX_CAPSULE_BYTES})`,
    };
  }
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(tmp, serialized, 'utf-8');
    renameSync(tmp, target);
    return { ok: true, path: target };
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    return { ok: false, reason: 'capsule_write_failed', detail: String(error) };
  }
}

/**
 * Read and strictly validate a capsule. Missing, malformed, oversized,
 * unsupported-version, or digest-mismatched artifacts return a typed
 * needs-user reason and must never allow an agent launch (REQ-F4).
 */
export function readCapsule(featureDir: string): CapsuleReadResult {
  const file = capsulePath(featureDir);
  if (!existsSync(file)) {
    return { ok: false, reason: 'capsule_missing', detail: `${file} does not exist` };
  }
  let size: number;
  try {
    size = statSync(file).size;
  } catch (error) {
    return { ok: false, reason: 'capsule_malformed', detail: `cannot stat ${file}: ${String(error)}` };
  }
  if (size > MAX_CAPSULE_BYTES) {
    return { ok: false, reason: 'capsule_oversized', detail: `${file} is ${size} bytes (limit ${MAX_CAPSULE_BYTES})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    return { ok: false, reason: 'capsule_malformed', detail: `cannot parse ${file}: ${String(error)}` };
  }
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== RECONCILIATION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'capsule_schema_version_unsupported',
      detail: `capsule schemaVersion ${String(schemaVersion)} is not supported (expected ${RECONCILIATION_SCHEMA_VERSION})`,
    };
  }
  const validator = getValidator();
  if (!validator.validate(parsed)) {
    return { ok: false, reason: 'capsule_malformed', detail: `schema validation failed: ${validator.errorsText()}` };
  }
  const capsule = parsed as ReconciliationCapsule;
  const expectedDigest = computeFoundationDigest(capsule.foundation);
  if (capsule.foundationDigest !== expectedDigest) {
    return {
      ok: false,
      reason: 'capsule_digest_mismatch',
      detail: `foundationDigest ${capsule.foundationDigest} does not match recomputed ${expectedDigest}`,
    };
  }
  if (capsule.incident) {
    const expectedFingerprint = computeIncidentFingerprint(capsule.incident);
    if (capsule.incidentFingerprint !== expectedFingerprint) {
      return {
        ok: false,
        reason: 'capsule_digest_mismatch',
        detail: `incidentFingerprint ${String(capsule.incidentFingerprint)} does not match recomputed ${expectedFingerprint}`,
      };
    }
  }
  return { ok: true, capsule };
}

/** Build a fresh capsule (no incident yet) from foundation + review identity. */
export function createCapsule(input: {
  foundation: ReconciliationFoundation;
  reviewHeadSha: string | null;
  reviewResultPath: string;
  reviewVerdict: string | null;
  now?: string;
}): ReconciliationCapsule {
  const now = input.now ?? new Date().toISOString();
  return {
    schemaVersion: RECONCILIATION_SCHEMA_VERSION,
    foundation: input.foundation,
    foundationDigest: computeFoundationDigest(input.foundation),
    review: {
      reviewHeadSha: input.reviewHeadSha,
      reviewResultPath: input.reviewResultPath,
      verdict: input.reviewVerdict,
      recordedAt: now,
    },
    incident: null,
    incidentFingerprint: null,
    attempts: [],
    sessionResume: null,
    updatedAt: now,
  };
}

/** Replace the volatile incident on an existing capsule (foundation untouched). */
export function withIncident(capsule: ReconciliationCapsule, incident: ReconciliationIncident): ReconciliationCapsule {
  const normalized = normalizeIncident(incident);
  return {
    ...capsule,
    incident: normalized,
    incidentFingerprint: computeIncidentFingerprint(normalized),
    updatedAt: new Date().toISOString(),
  };
}

/** Append a bounded attempt record (oldest dropped past MAX_ATTEMPTS). */
export function withAttempt(capsule: ReconciliationCapsule, attempt: ReconciliationAttempt): ReconciliationCapsule {
  const attempts = [...capsule.attempts, attempt].slice(-MAX_ATTEMPTS);
  return { ...capsule, attempts, updatedAt: new Date().toISOString() };
}

// ── Prompt projection ────────────────────────────────────────────────────────

export interface CapsuleProjection {
  /** Byte-stable per foundation: identical across incident updates (REQ-F2). */
  prefix: string;
  /** Volatile: review identity, current incident, prior attempts. */
  suffix: string;
  text: string;
}

/**
 * Project the capsule into a recovery prompt. The stable foundation is
 * serialized first (cacheable prefix); the volatile incident and attempt
 * history are appended last. Referenced artifacts are cited by path with
 * on-demand inspection commands rather than inlined.
 */
export function projectCapsulePrompt(capsule: ReconciliationCapsule): CapsuleProjection {
  const foundation = capsule.foundation;
  const prefixLines = [
    '## Task foundation (stable)',
    '',
    `Task: ${foundation.taskId} — ${foundation.taskTitle}`,
    `Slug: ${foundation.slug}`,
    `PR: #${foundation.prNumber}`,
    `Branch: ${foundation.branch}`,
    `Base branch: ${foundation.baseBranch}`,
    `Execution contract: ${foundation.executionContractPath} (stage: ${foundation.executionContractStage})`,
    foundation.taskPacketPath
      ? `Task packet: ${foundation.taskPacketPath} (sha256 ${foundation.taskPacketDigest ?? 'unknown'})`
      : 'Task packet: not recorded',
    '',
    'Original scope:',
    foundation.scopeSummary ?? '(no scope summary recorded; consult the task packet)',
    '',
    'Inspect large artifacts on demand instead of assuming their content:',
    foundation.taskPacketPath ? `  cat '${foundation.taskPacketPath}'` : '  (no task packet path recorded)',
    `  cat '${foundation.executionContractPath}'`,
    '',
  ];
  const prefix = prefixLines.join('\n');

  const suffixLines: string[] = [
    '## Current incident (volatile)',
    '',
    `Review evidence: ${capsule.review.reviewResultPath} (verdict: ${capsule.review.verdict ?? 'unknown'}, reviewed head: ${capsule.review.reviewHeadSha ?? 'unknown'})`,
  ];
  const incident = capsule.incident;
  if (incident) {
    suffixLines.push(
      `Classification: ${incident.classification}`,
      `Head SHA: ${incident.headSha}${incident.baseSha ? ` (base ${incident.baseSha})` : ''}`,
      `Failure fingerprint: ${incident.failureFingerprint}`,
      `Observed at: ${incident.observedAt}`,
      '',
      incident.detail || '(no incident detail)',
    );
    if (incident.failingChecks && incident.failingChecks.length > 0) {
      suffixLines.push('', 'Failing checks:');
      for (const check of incident.failingChecks) {
        suffixLines.push(`- ${check.name}${check.failingJob ? ` (job: ${check.failingJob})` : ''}`);
        if (check.localCommand) suffixLines.push(`  reproduce locally: ${check.localCommand}`);
        if (check.logUrl) suffixLines.push(`  logs: ${check.logUrl}`);
        if (check.logExcerpt) suffixLines.push('  excerpt:', ...check.logExcerpt.split('\n').map((line) => `    ${line}`));
      }
    }
    if (incident.conflictFiles && incident.conflictFiles.length > 0) {
      suffixLines.push('', 'Conflicted files:', ...incident.conflictFiles.map((file) => `- ${file}`));
    }
    if (incident.evidenceGaps && incident.evidenceGaps.length > 0) {
      suffixLines.push('', 'Evidence gaps (do not fabricate the missing evidence):', ...incident.evidenceGaps.map((gap) => `- ${gap}`));
    }
  } else {
    suffixLines.push('No incident is currently recorded.');
  }
  if (capsule.attempts.length > 0) {
    suffixLines.push('', `Prior reconciliation attempts (${capsule.attempts.length}):`);
    for (const attempt of capsule.attempts.slice(-10)) {
      suffixLines.push(
        `- attempt ${attempt.attemptNumber} [${attempt.classification}] at head ${attempt.headSha}: ${attempt.outcome}` +
          `${attempt.resultCommitSha ? ` (commit ${attempt.resultCommitSha})` : ''}`,
      );
    }
    if (capsule.attempts.length > 10) {
      suffixLines.push(`  (${capsule.attempts.length - 10} older attempts elided)`);
    }
  }
  suffixLines.push('');
  const suffix = suffixLines.join('\n');

  let text = `${prefix}\n${suffix}`;
  if (Buffer.byteLength(text, 'utf-8') > MAX_CAPSULE_BYTES) {
    text = `${prefix}\n${boundText(suffix, MAX_CAPSULE_BYTES - Buffer.byteLength(prefix, 'utf-8') - 64)}`;
  }
  return { prefix, suffix, text };
}
