/**
 * Artifact Diagnostics — read-only observer/doctor for normalized task artifacts (HOK-2260)
 *
 * Inspects task-contract.json, feature-state.json, and trace.jsonl against
 * existing controller state and reports coverage, freshness, and inconsistencies.
 *
 * Design rules:
 * - Read-only: never mutates any file or state
 * - Never throws: all errors become findings
 * - Missing artifacts → coverage findings, not failures
 * - Malformed artifacts → malformed findings with actionable file paths
 *
 * @module artifact-diagnostics
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { TaskContract } from './task-contract.ts';
import type { FeatureState } from './feature-state.ts';
import type { TraceEvent } from './trace-event.ts';
import { loadTraceContext } from './trace-event.ts';
import { readEvalRecords } from './eval-persistence.ts';
import { resolveEvalsDir } from './evals-paths.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type DiagnosticSeverity = 'ok' | 'coverage' | 'stale' | 'malformed' | 'mismatch';

export interface DiagnosticFinding {
  /** Stable identifier for this check, e.g. 'contract-hash-match' */
  check: string;
  severity: DiagnosticSeverity;
  /** Human-readable description */
  message: string;
  /** Actionable path when the finding refers to a specific file */
  filePath?: string;
  detail?: Record<string, unknown>;
}

export interface DiagnosticsResult {
  repoDir: string;
  featureDir: string;
  issueId?: string;
  findings: DiagnosticFinding[];
  summary: {
    ok: number;
    coverage: number;
    stale: number;
    malformed: number;
    mismatch: number;
  };
}

export interface DiagnoseArtifactsOptions {
  repoDir: string;
  /** Diagnose a single feature directory. */
  featureDir?: string;
  /** Issue ID; resolved from selected-task.json when absent. */
  issueId?: string;
}

// ────────────────────────────────────────────────────────────────
// Internal loader result types
// ────────────────────────────────────────────────────────────────

type MalformedInfo = { filePath: string; reason: string };

type LoadResult<T> =
  | { present: true; value: T }
  | { present: false; malformed?: MalformedInfo };

// ────────────────────────────────────────────────────────────────
// Tolerant artifact loaders
// ────────────────────────────────────────────────────────────────

function loadTaskContract(featureDir: string): LoadResult<TaskContract> {
  const filePath = path.join(featureDir, 'task-contract.json');
  if (!existsSync(filePath)) {
    return { present: false };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) {
      return { present: false, malformed: { filePath, reason: 'empty file' } };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed.schemaVersion || !parsed.sources || !parsed.fields) {
      return { present: false, malformed: { filePath, reason: 'missing required fields: schemaVersion, sources, fields' } };
    }
    return { present: true, value: parsed as unknown as TaskContract };
  } catch (err) {
    const reason = err instanceof SyntaxError ? `JSON parse error: ${err.message}` : String(err);
    return { present: false, malformed: { filePath, reason } };
  }
}

function loadFeatureState(featureDir: string): LoadResult<FeatureState> {
  const filePath = path.join(featureDir, 'feature-state.json');
  if (!existsSync(filePath)) {
    return { present: false };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) {
      return { present: false, malformed: { filePath, reason: 'empty file' } };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed.schemaVersion || !parsed.currentPhase || !parsed.normalizedState) {
      return { present: false, malformed: { filePath, reason: 'missing required fields: schemaVersion, currentPhase, normalizedState' } };
    }
    return { present: true, value: parsed as unknown as FeatureState };
  } catch (err) {
    const reason = err instanceof SyntaxError ? `JSON parse error: ${err.message}` : String(err);
    return { present: false, malformed: { filePath, reason } };
  }
}

interface TraceLoadResult {
  present: boolean;
  events: TraceEvent[];
  skippedLines: number;
  malformed?: MalformedInfo;
}

async function loadTraceEvents(featureDir: string): Promise<TraceLoadResult> {
  const filePath = path.join(featureDir, 'trace.jsonl');
  if (!existsSync(filePath)) {
    return { present: false, events: [], skippedLines: 0 };
  }

  try {
    const stat = statSync(filePath);
    if (stat.size === 0) {
      return { present: true, events: [], skippedLines: 0 };
    }
  } catch {
    return { present: false, events: [], skippedLines: 0, malformed: { filePath, reason: 'cannot stat file' } };
  }

  const events: TraceEvent[] = [];
  let skippedLines = 0;

  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    await new Promise<void>((resolve, reject) => {
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed) as TraceEvent;
          events.push(parsed);
        } catch {
          skippedLines++;
        }
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });

    return { present: true, events, skippedLines };
  } catch (err) {
    return { present: false, events: [], skippedLines: 0, malformed: { filePath, reason: String(err) } };
  }
}

interface WorkflowTask {
  phase?: string;
  status?: string;
  [key: string]: unknown;
}

interface WorkflowState {
  tasks?: Record<string, WorkflowTask>;
}

function loadWorkflowState(repoDir: string): WorkflowState | null {
  const filePath = path.join(repoDir, '.wavemill', 'workflow-state.json');
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as WorkflowState;
  } catch {
    return null;
  }
}

function resolveIssueId(featureDir: string): string | undefined {
  const selectedTask = path.join(featureDir, 'selected-task.json');
  if (!existsSync(selectedTask)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(selectedTask, 'utf-8')) as Record<string, unknown>;
    return typeof parsed.taskId === 'string' && parsed.taskId ? parsed.taskId : undefined;
  } catch {
    return undefined;
  }
}

// ────────────────────────────────────────────────────────────────
// SHA-256 helper
// ────────────────────────────────────────────────────────────────

function sha256Hex(filePath: string): string | null {
  try {
    const bytes = readFileSync(filePath);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Check 1: contract-hash-match
// ────────────────────────────────────────────────────────────────

function checkContractHashMatch(
  featureDir: string,
  contractResult: LoadResult<TaskContract>,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  const contractPath = path.join(featureDir, 'task-contract.json');

  if (!contractResult.present) {
    if (contractResult.malformed) {
      findings.push({
        check: 'contract-hash-match',
        severity: 'malformed',
        message: `task-contract.json is malformed: ${contractResult.malformed.reason}`,
        filePath: contractResult.malformed.filePath,
      });
    } else {
      findings.push({
        check: 'contract-hash-match',
        severity: 'coverage',
        message: 'task-contract.json not found; contract hash verification skipped',
        filePath: contractPath,
      });
    }
    return findings;
  }

  const contract = contractResult.value;
  const sources = Array.isArray(contract.sources) ? contract.sources : [];

  // Check each source that the contract claims exists
  let allMatch = true;
  for (const src of sources) {
    if (!src.exists || !src.sha256) continue;
    const absPath = path.join(featureDir, src.path);
    if (!existsSync(absPath)) {
      findings.push({
        check: 'contract-hash-match',
        severity: 'stale',
        message: `Contract source '${src.path}' was recorded as existing but is now missing`,
        filePath: contractPath,
        detail: { sourcePath: src.path, recordedHash: src.sha256 },
      });
      allMatch = false;
      continue;
    }
    const currentHash = sha256Hex(absPath);
    if (currentHash !== null && currentHash !== src.sha256) {
      findings.push({
        check: 'contract-hash-match',
        severity: 'mismatch',
        message: `Contract source '${src.path}' hash has changed since contract was built`,
        filePath: contractPath,
        detail: { sourcePath: src.path, recordedHash: src.sha256, currentHash },
      });
      allMatch = false;
    }
  }

  if (allMatch && findings.length === 0) {
    findings.push({
      check: 'contract-hash-match',
      severity: 'ok',
      message: 'All contract source hashes match current files',
    });
  }

  return findings;
}

// ────────────────────────────────────────────────────────────────
// Check 2: outcome-vs-workflow-state
// ────────────────────────────────────────────────────────────────

function checkOutcomeVsWorkflowState(
  repoDir: string,
  featureDir: string,
  issueId: string | undefined,
  featureStateResult: LoadResult<FeatureState>,
): DiagnosticFinding[] {
  const featureStatePath = path.join(featureDir, 'feature-state.json');
  const workflowStatePath = path.join(repoDir, '.wavemill', 'workflow-state.json');

  if (!featureStateResult.present) {
    if (featureStateResult.malformed) {
      return [{
        check: 'outcome-vs-workflow-state',
        severity: 'malformed',
        message: `feature-state.json is malformed: ${featureStateResult.malformed.reason}`,
        filePath: featureStateResult.malformed.filePath,
      }];
    }
    return [{
      check: 'outcome-vs-workflow-state',
      severity: 'coverage',
      message: 'feature-state.json not found; workflow-state comparison skipped',
      filePath: featureStatePath,
    }];
  }

  const workflowState = loadWorkflowState(repoDir);
  if (!workflowState) {
    return [{
      check: 'outcome-vs-workflow-state',
      severity: 'coverage',
      message: 'workflow-state.json not found; comparison skipped',
      filePath: workflowStatePath,
    }];
  }

  if (!issueId) {
    return [{
      check: 'outcome-vs-workflow-state',
      severity: 'coverage',
      message: 'No issueId available; cannot match task in workflow-state.json',
    }];
  }

  const tasks = workflowState.tasks ?? {};
  const workflowTask = tasks[issueId];
  if (!workflowTask) {
    return [{
      check: 'outcome-vs-workflow-state',
      severity: 'coverage',
      message: `Issue '${issueId}' not found in workflow-state.json tasks`,
      filePath: workflowStatePath,
      detail: { issueId },
    }];
  }

  const featureState = featureStateResult.value;
  const findings: DiagnosticFinding[] = [];

  // Compare phase
  const statePhase = workflowTask.phase;
  const outcomePhase = featureState.currentPhase;
  if (statePhase && outcomePhase !== 'unknown' && statePhase !== outcomePhase) {
    findings.push({
      check: 'outcome-vs-workflow-state',
      severity: 'mismatch',
      message: `Phase disagrees: feature-state has '${outcomePhase}', workflow-state has '${statePhase}'`,
      filePath: featureStatePath,
      detail: { outcomePhase, workflowPhase: statePhase },
    });
  }

  if (findings.length === 0) {
    findings.push({
      check: 'outcome-vs-workflow-state',
      severity: 'ok',
      message: 'Feature-state phase is consistent with workflow-state',
    });
  }

  return findings;
}

// ────────────────────────────────────────────────────────────────
// Check 3: coding-complete-evidence
// ────────────────────────────────────────────────────────────────

function checkCodingCompleteEvidence(
  featureDir: string,
  featureStateResult: LoadResult<FeatureState>,
): DiagnosticFinding[] {
  const codingMarker = path.join(featureDir, '.coding-complete');
  const codingComplete = existsSync(codingMarker);

  if (!codingComplete) {
    // No coding complete marker — check not applicable
    return [{
      check: 'coding-complete-evidence',
      severity: 'ok',
      message: 'Coding is not marked complete; evidence check skipped',
    }];
  }

  const featureStatePath = path.join(featureDir, 'feature-state.json');

  if (!featureStateResult.present) {
    if (featureStateResult.malformed) {
      return [{
        check: 'coding-complete-evidence',
        severity: 'malformed',
        message: `feature-state.json is malformed: ${featureStateResult.malformed.reason}`,
        filePath: featureStateResult.malformed.filePath,
      }];
    }
    return [{
      check: 'coding-complete-evidence',
      severity: 'coverage',
      message: '.coding-complete marker exists but feature-state.json not found',
      filePath: featureStatePath,
    }];
  }

  const featureState = featureStateResult.value;
  const evidence = Array.isArray(featureState.evidence) ? featureState.evidence : [];
  const hasPassingCodingEvidence = evidence.some(
    (e) => e.status === 'pass' && (
      e.kind === 'stage_completion' && e.label === 'coding_stage' ||
      e.kind === 'legacy_marker' && e.label === '.coding-complete'
    ),
  );

  if (!hasPassingCodingEvidence) {
    return [{
      check: 'coding-complete-evidence',
      severity: 'mismatch',
      message: '.coding-complete marker exists but feature-state.json has no passing coding evidence',
      filePath: featureStatePath,
      detail: { evidenceCount: evidence.length },
    }];
  }

  return [{
    check: 'coding-complete-evidence',
    severity: 'ok',
    message: 'Coding complete marker is reflected in feature-state evidence',
  }];
}

// ────────────────────────────────────────────────────────────────
// Check 4: eval-without-outcome
// ────────────────────────────────────────────────────────────────

function checkEvalWithoutOutcome(
  repoDir: string,
  featureDir: string,
  issueId: string | undefined,
  featureStateResult: LoadResult<FeatureState>,
): DiagnosticFinding[] {
  if (!issueId) {
    return [];
  }

  const evalsDir = resolveEvalsDir(undefined, repoDir).dir;
  let evalRecords: Array<{ issueId?: string }> = [];
  try {
    evalRecords = readEvalRecords({ dir: evalsDir });
  } catch {
    evalRecords = [];
  }

  const matchingEvals = evalRecords.filter((r) => r.issueId === issueId);
  const hasEval = matchingEvals.length > 0;

  const featureStatePath = path.join(featureDir, 'feature-state.json');

  if (hasEval && !featureStateResult.present) {
    return [{
      check: 'eval-without-outcome',
      severity: 'mismatch',
      message: `Eval record exists for '${issueId}' but feature-state.json is missing`,
      filePath: featureStatePath,
      detail: { evalCount: matchingEvals.length, issueId },
    }];
  }

  return [{
    check: 'eval-without-outcome',
    severity: 'ok',
    message: hasEval
      ? 'Eval record and feature-state.json are both present'
      : 'No eval record found; eval-without-outcome check not applicable',
  }];
}

// ────────────────────────────────────────────────────────────────
// Check 5: traceid-propagation
// ────────────────────────────────────────────────────────────────

function checkTraceIdPropagation(
  repoDir: string,
  featureDir: string,
  issueId: string | undefined,
): DiagnosticFinding[] {
  const traceContext = loadTraceContext(featureDir);

  if (!traceContext) {
    return [{
      check: 'traceid-propagation',
      severity: 'coverage',
      message: 'No trace context found; traceId propagation check skipped',
      filePath: path.join(featureDir, '.trace-context.json'),
    }];
  }

  if (!issueId) {
    return [{
      check: 'traceid-propagation',
      severity: 'coverage',
      message: 'No issueId available; cannot check traceId in eval records',
    }];
  }

  const evalsDir = resolveEvalsDir(undefined, repoDir).dir;
  let evalRecords: Array<{ issueId?: string; traceId?: string }> = [];
  try {
    evalRecords = readEvalRecords({ dir: evalsDir });
  } catch {
    evalRecords = [];
  }

  const matchingEvals = evalRecords.filter((r) => r.issueId === issueId);
  if (matchingEvals.length === 0) {
    // No evals yet — not an error
    return [{
      check: 'traceid-propagation',
      severity: 'ok',
      message: 'Trace context exists; no eval records yet to verify propagation',
    }];
  }

  const evalsWithTrace = matchingEvals.filter((r) => r.traceId === traceContext.traceId);
  if (evalsWithTrace.length === 0) {
    return [{
      check: 'traceid-propagation',
      severity: 'mismatch',
      message: `Eval records for '${issueId}' do not carry traceId '${traceContext.traceId}'`,
      detail: {
        traceId: traceContext.traceId,
        evalCount: matchingEvals.length,
        tracedEvalCount: 0,
      },
    }];
  }

  return [{
    check: 'traceid-propagation',
    severity: 'ok',
    message: `TraceId '${traceContext.traceId}' is present in ${evalsWithTrace.length}/${matchingEvals.length} eval records`,
  }];
}

// ────────────────────────────────────────────────────────────────
// Check 6: trace-events-unreflected
// ────────────────────────────────────────────────────────────────

function checkTraceEventsUnreflected(
  featureDir: string,
  traceResult: TraceLoadResult,
  featureStateResult: LoadResult<FeatureState>,
): DiagnosticFinding[] {
  if (!traceResult.present) {
    return [{
      check: 'trace-events-unreflected',
      severity: 'coverage',
      message: 'trace.jsonl not found; trace event reflection check skipped',
      filePath: path.join(featureDir, 'trace.jsonl'),
    }];
  }

  const significantEvents = traceResult.events.filter(
    (e) => e.event === 'check_failed' || e.event === 'fallback_used',
  );

  if (significantEvents.length === 0) {
    return [{
      check: 'trace-events-unreflected',
      severity: 'ok',
      message: 'No check_failed or fallback_used events in trace; nothing to reflect',
    }];
  }

  const featureStatePath = path.join(featureDir, 'feature-state.json');

  if (!featureStateResult.present) {
    if (featureStateResult.malformed) {
      return [{
        check: 'trace-events-unreflected',
        severity: 'malformed',
        message: `feature-state.json is malformed: ${featureStateResult.malformed.reason}`,
        filePath: featureStateResult.malformed.filePath,
      }];
    }
    return [{
      check: 'trace-events-unreflected',
      severity: 'mismatch',
      message: `${significantEvents.length} significant trace event(s) found but feature-state.json is missing`,
      filePath: featureStatePath,
      detail: {
        checkFailedCount: significantEvents.filter((e) => e.event === 'check_failed').length,
        fallbackUsedCount: significantEvents.filter((e) => e.event === 'fallback_used').length,
      },
    }];
  }

  const featureState = featureStateResult.value;
  const blockers = Array.isArray(featureState.blockers) ? featureState.blockers : [];
  const evidence = Array.isArray(featureState.evidence) ? featureState.evidence : [];

  const checkFailedEvents = significantEvents.filter((e) => e.event === 'check_failed');
  const fallbackEvents = significantEvents.filter((e) => e.event === 'fallback_used');

  const findings: DiagnosticFinding[] = [];

  // check_failed events should correlate with blockers or failing evidence
  if (checkFailedEvents.length > 0) {
    const hasBlockersOrFailures =
      blockers.length > 0 ||
      evidence.some((e) => e.status === 'fail');

    if (!hasBlockersOrFailures) {
      findings.push({
        check: 'trace-events-unreflected',
        severity: 'mismatch',
        message: `${checkFailedEvents.length} check_failed trace event(s) but feature-state has no blockers or failing evidence`,
        filePath: featureStatePath,
        detail: { checkFailedCount: checkFailedEvents.length },
      });
    }
  }

  // fallback_used events should be visible somewhere in evidence or model fields
  if (fallbackEvents.length > 0) {
    const hasAnyModelEvidence = evidence.some(
      (e) => e.detail?.includes('model') || e.detail?.includes('fallback'),
    );
    if (!hasAnyModelEvidence) {
      findings.push({
        check: 'trace-events-unreflected',
        severity: 'mismatch',
        message: `${fallbackEvents.length} fallback_used trace event(s) but feature-state has no evidence of model/route change`,
        filePath: featureStatePath,
        detail: { fallbackUsedCount: fallbackEvents.length },
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      check: 'trace-events-unreflected',
      severity: 'ok',
      message: 'Significant trace events are reflected in feature-state',
    });
  }

  return findings;
}

// ────────────────────────────────────────────────────────────────
// Summary helper
// ────────────────────────────────────────────────────────────────

function computeSummary(
  findings: DiagnosticFinding[],
): DiagnosticsResult['summary'] {
  const summary = { ok: 0, coverage: 0, stale: 0, malformed: 0, mismatch: 0 };
  for (const f of findings) {
    summary[f.severity]++;
  }
  return summary;
}

// ────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────

/**
 * Run all artifact diagnostics for a single feature directory.
 *
 * Never throws. Returns a DiagnosticsResult with findings and a summary.
 */
export async function diagnoseArtifacts(options: DiagnoseArtifactsOptions): Promise<DiagnosticsResult> {
  const { repoDir } = options;
  let featureDir = options.featureDir ?? '';

  // Validate repoDir
  if (!existsSync(repoDir)) {
    return {
      repoDir,
      featureDir,
      issueId: options.issueId,
      findings: [{
        check: 'repo-dir-exists',
        severity: 'coverage',
        message: `Repository directory not found: ${repoDir}`,
        filePath: repoDir,
      }],
      summary: { ok: 0, coverage: 1, stale: 0, malformed: 0, mismatch: 0 },
    };
  }

  // Resolve featureDir if not provided
  if (!featureDir) {
    const featuresRoot = path.join(repoDir, 'features');
    if (!existsSync(featuresRoot)) {
      return {
        repoDir,
        featureDir,
        issueId: options.issueId,
        findings: [{
          check: 'feature-dirs-found',
          severity: 'coverage',
          message: 'No features/ directory found; no artifacts to diagnose',
          filePath: featuresRoot,
        }],
        summary: { ok: 0, coverage: 1, stale: 0, malformed: 0, mismatch: 0 },
      };
    }
    featureDir = featuresRoot;
  }

  // Resolve issueId
  const issueId = options.issueId ?? resolveIssueId(featureDir);

  // Load all artifacts
  const contractResult = loadTaskContract(featureDir);
  const featureStateResult = loadFeatureState(featureDir);
  const traceResult = await loadTraceEvents(featureDir);

  // Emit malformed findings for loaders that encountered parse errors
  const loaderFindings: DiagnosticFinding[] = [];
  if (traceResult.malformed) {
    loaderFindings.push({
      check: 'trace-load',
      severity: 'malformed',
      message: `trace.jsonl could not be read: ${traceResult.malformed.reason}`,
      filePath: traceResult.malformed.filePath,
    });
  }
  if (traceResult.skippedLines > 0) {
    loaderFindings.push({
      check: 'trace-load',
      severity: 'malformed',
      message: `trace.jsonl has ${traceResult.skippedLines} malformed line(s) that were skipped`,
      filePath: path.join(featureDir, 'trace.jsonl'),
      detail: { skippedLines: traceResult.skippedLines },
    });
  }

  // Run all six checks
  const findings: DiagnosticFinding[] = [
    ...loaderFindings,
    ...checkContractHashMatch(featureDir, contractResult),
    ...checkOutcomeVsWorkflowState(repoDir, featureDir, issueId, featureStateResult),
    ...checkCodingCompleteEvidence(featureDir, featureStateResult),
    ...checkEvalWithoutOutcome(repoDir, featureDir, issueId, featureStateResult),
    ...checkTraceIdPropagation(repoDir, featureDir, issueId),
    ...checkTraceEventsUnreflected(featureDir, traceResult, featureStateResult),
  ];

  return {
    repoDir,
    featureDir,
    issueId,
    findings,
    summary: computeSummary(findings),
  };
}
