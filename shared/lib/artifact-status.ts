/**
 * Artifact Status Summarizer — compact read-only status for normalized task artifacts (HOK-2261)
 *
 * Reads task-contract.json, feature-state.json, trace.jsonl, and .trace-context.json
 * from a feature directory and produces a compact summary suitable for dashboard display.
 *
 * Design rules:
 * - Never throws from public API. Missing/malformed artifacts degrade gracefully.
 * - Uses diagnoseArtifacts for contract drift detection (single source of truth).
 * - Returns empty formatted string for legacy tasks with no normalized artifacts.
 * - All output is one line, ASCII-safe, and bounded by maxWidth.
 *
 * @module artifact-status
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagnoseArtifacts, type DiagnoseArtifactsOptions } from './artifact-diagnostics.ts';
import type { FeatureState } from './feature-state.ts';
import type { TraceEvent } from './trace-event.ts';
import { loadTraceContext } from './trace-event.ts';

// ── Public Types ──────────────────────────────────────────────────────────────

export type ContractArtifactStatus = 'present' | 'missing' | 'stale';

export interface ArtifactStatusSummary {
  contract: ContractArtifactStatus;
  outcome: {
    state: string | null;
    failureReason: string | null;
  };
  evidenceCount: number | null;
  trace: {
    traceId: string | null;
    latestPhase: string | null;
    latestStatus: string | null;
  };
  routeLinkage: {
    known: boolean;
    mismatch: boolean;
    detail: string | null;
  };
  artifactsPresent: boolean;
  malformed: boolean;
}

export interface SummarizeArtifactStatusOptions {
  featureDir: string;
  repoDir?: string;
  issueId?: string;
  slug?: string;
}

export interface FormatArtifactStatusOptions {
  maxWidth?: number;
}

// ── Internal Reader Types ─────────────────────────────────────────────────────

type JsonReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'missing' | 'malformed' };

// ── Tolerant Readers ──────────────────────────────────────────────────────────

function readJsonFile<T>(filePath: string): JsonReadResult<T> {
  if (!existsSync(filePath)) {
    return { ok: false, reason: 'missing' };
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.trim()) {
      return { ok: false, reason: 'malformed' };
    }
    const parsed = JSON.parse(content) as T;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'malformed' };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

interface TraceReadResult {
  records: TraceEvent[];
  malformedLines: number;
  missing: boolean;
}

function readTraceEvents(featureDir: string): TraceReadResult {
  const tracePath = join(featureDir, 'trace.jsonl');
  if (!existsSync(tracePath)) {
    return { records: [], malformedLines: 0, missing: true };
  }

  let content: string;
  try {
    content = readFileSync(tracePath, 'utf-8');
  } catch {
    return { records: [], malformedLines: 1, missing: false };
  }

  const records: TraceEvent[] = [];
  let malformedLines = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TraceEvent;
      records.push(parsed);
    } catch {
      malformedLines++;
    }
  }

  return { records, malformedLines, missing: false };
}

// ── Neutral Summary ────────────────────────────────────────────────────────────

function neutralSummary(): ArtifactStatusSummary {
  return {
    contract: 'missing',
    outcome: { state: null, failureReason: null },
    evidenceCount: null,
    trace: { traceId: null, latestPhase: null, latestStatus: null },
    routeLinkage: { known: false, mismatch: false, detail: null },
    artifactsPresent: false,
    malformed: false,
  };
}

// ── Main Summarizer ────────────────────────────────────────────────────────────

/**
 * Summarize normalized artifact health for a feature directory.
 *
 * Never throws. Returns a neutral summary for missing or malformed artifacts.
 * Returns artifactsPresent=false when none of the four artifact files exist,
 * which causes formatArtifactStatus to return '' (preserving legacy task rows).
 */
export function summarizeArtifactStatus(options: SummarizeArtifactStatusOptions): ArtifactStatusSummary {
  try {
    return _summarizeArtifactStatus(options);
  } catch {
    return neutralSummary();
  }
}

function _summarizeArtifactStatus(options: SummarizeArtifactStatusOptions): ArtifactStatusSummary {
  const { featureDir, repoDir, issueId, slug } = options;

  const contractPath = join(featureDir, 'task-contract.json');
  const statePath = join(featureDir, 'feature-state.json');
  const tracePath = join(featureDir, 'trace.jsonl');
  const traceContextPath = join(featureDir, '.trace-context.json');

  const anyArtifactPresent =
    existsSync(contractPath) ||
    existsSync(statePath) ||
    existsSync(tracePath) ||
    existsSync(traceContextPath);

  if (!anyArtifactPresent) {
    return neutralSummary();
  }

  // ── Run diagnostics for drift/malformed detection ─────────────────────────
  let hasDrift = false;
  let contractMalformed = false;
  let stateMalformed = false;

  try {
    const diagOpts: DiagnoseArtifactsOptions = {
      repoDir: repoDir ?? featureDir,
      featureDir,
      taskId: issueId,
      slug,
    };
    const report = diagnoseArtifacts(diagOpts);
    hasDrift = report.findings.some(f => f.code === 'contract_hash_drift');
    contractMalformed = report.artifacts.taskContract.malformed;
    stateMalformed = report.artifacts.featureState.malformed;
  } catch {
    // Diagnostics is best-effort
  }

  // ── Contract status ────────────────────────────────────────────────────────
  const contractPresent = existsSync(contractPath);
  let contract: ContractArtifactStatus;
  if (!contractPresent || contractMalformed) {
    contract = 'missing';
  } else if (hasDrift) {
    contract = 'stale';
  } else {
    contract = 'present';
  }

  // ── Feature state ──────────────────────────────────────────────────────────
  const stateResult = readJsonFile<FeatureState>(statePath);
  let outcomeState: string | null = null;
  let outcomeFailureReason: string | null = null;
  let evidenceCount: number | null = null;

  if (stateResult.ok) {
    outcomeState = stateResult.value.normalizedState ?? null;
    outcomeFailureReason = stateResult.value.failureReason ?? null;
    evidenceCount = Array.isArray(stateResult.value.evidence)
      ? stateResult.value.evidence.length
      : null;
  }

  // ── Trace ──────────────────────────────────────────────────────────────────
  let traceId: string | null = null;

  const ctx = loadTraceContext(featureDir);
  if (ctx) {
    traceId = ctx.traceId;
  }

  const traceResult = readTraceEvents(featureDir);
  let latestPhase: string | null = null;
  let latestStatus: string | null = null;

  if (traceResult.records.length > 0) {
    if (!traceId) {
      traceId = traceResult.records[0].traceId ?? null;
    }
    const latest = traceResult.records[traceResult.records.length - 1];
    latestPhase = latest.phase ?? null;
    latestStatus = latest.status ?? null;
  }

  // ── Route linkage ──────────────────────────────────────────────────────────
  // contract_hash_drift is the available signal for stale/mismatch state.
  // Route hash comparison is not directly possible from current artifact fields,
  // so we map drift to mismatch=true as the closest available signal.
  const routeLinkage = {
    known: hasDrift,
    mismatch: hasDrift,
    detail: hasDrift ? 'contract_hash_drift' : null,
  };

  const malformed = contractMalformed || stateMalformed;

  return {
    contract,
    outcome: { state: outcomeState, failureReason: outcomeFailureReason },
    evidenceCount,
    trace: { traceId, latestPhase, latestStatus },
    routeLinkage,
    artifactsPresent: true,
    malformed,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function shortContractStatus(status: ContractArtifactStatus): string {
  switch (status) {
    case 'present': return 'ok';
    case 'missing': return '-';
    case 'stale': return 'stale!';
  }
}

function shortOutcome(outcome: ArtifactStatusSummary['outcome']): string {
  const value = outcome.failureReason ?? outcome.state;
  if (!value) return '-';
  return truncateStatusValue(value, 16);
}

function shortTrace(trace: ArtifactStatusSummary['trace']): string {
  if (trace.latestPhase === null) return '-';
  const status = trace.latestStatus ?? '-';
  return `${trace.latestPhase}/${status}`;
}

function truncateStatusValue(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 2)}..`;
}

/**
 * Format an artifact status summary as a compact one-line string.
 *
 * Returns '' for legacy tasks with no artifacts (artifactsPresent=false).
 * Drops lower-priority segments to fit within maxWidth:
 *   1. route mismatch marker
 *   2. trace segment
 *   3. evidence segment
 *   4. outcome value truncation
 *   5. contract segment (kept as long as possible)
 */
export function formatArtifactStatus(
  summary: ArtifactStatusSummary,
  options: FormatArtifactStatusOptions = {},
): string {
  if (!summary.artifactsPresent) {
    return '';
  }

  const maxWidth = options.maxWidth ?? 44;

  const ctr = shortContractStatus(summary.contract);
  const out = shortOutcome(summary.outcome);
  const ev = summary.evidenceCount !== null ? `ev=${summary.evidenceCount}` : 'ev=-';
  const tr = `tr=${shortTrace(summary.trace)}`;
  const routeMarker = summary.routeLinkage.mismatch ? ' route!' : '';

  // Try candidates in decreasing priority order
  const candidates: string[] = [
    `art:ctr=${ctr} out=${out} ${ev} ${tr}${routeMarker}`,
    `art:ctr=${ctr} out=${out} ${ev} ${tr}`,
    `art:ctr=${ctr} out=${out} ${ev}`,
    `art:ctr=${ctr} out=${out}`,
    `art:ctr=${ctr}`,
  ];

  for (const candidate of candidates) {
    if (candidate.length <= maxWidth) {
      return candidate;
    }
  }

  // Hard truncation of minimal form
  return candidates[candidates.length - 1].slice(0, maxWidth);
}
