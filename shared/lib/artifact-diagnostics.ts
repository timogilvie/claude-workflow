/**
 * Artifact Diagnostics — read-only observer for normalized task artifacts (HOK-2260)
 *
 * Inspects task-contract.json, feature-state.json, and trace.jsonl artifacts
 * and reports coverage gaps, stale hashes, and inconsistencies against existing
 * controller state. Never mutates task state or fails active workflows.
 *
 * @module artifact-diagnostics
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { resolveEvalsDir, resolveRouteArtifactArchiveDir } from './evals-paths.ts';
import { loadFeatureOutcomeDiagnostics } from './feature-outcome-consumer.ts';
import type { TaskContract } from './task-contract.ts';
import type { FeatureState } from './feature-state.ts';
import type { TraceEvent } from './trace-event.ts';
import type { EvalRecord } from './eval-schema.ts';

// ── Public Types ──────────────────────────────────────────────────────────────

export type ArtifactFindingSeverity = 'info' | 'warn' | 'error';

export type ArtifactFindingCode =
  | 'coverage_gap'
  | 'malformed'
  | 'contract_hash_drift'
  | 'feature_outcome_state_mismatch'
  | 'coding_complete_without_evidence'
  | 'eval_without_outcome'
  | 'trace_id_missing'
  | 'trace_event_unreflected'
  | 'route_contract_mismatch'
  | 'ready_inconsistency'
  | 'eval_export_inconsistency'
  | 'fallback_verification_mismatch';

export type ArtifactSoftGateId =
  | 'artifact_malformed'
  | 'contract_source_hash_mismatch'
  | 'outcome_divergence'
  | 'completion_without_evidence'
  | 'eval_without_outcome'
  | 'trace_linkage_missing'
  | 'trace_event_unreflected'
  | 'route_contract_mismatch'
  | 'ready_inconsistency'
  | 'eval_export_inconsistency'
  | 'fallback_verification_mismatch';

export interface ArtifactDiagnosticFinding {
  code: ArtifactFindingCode;
  severity: ArtifactFindingSeverity;
  message: string;
  file?: string;
  reason?: string;
  taskId?: string;
  slug?: string;
  gateId?: ArtifactSoftGateId;
  expected?: string;
  actual?: string;
  recommendedAction?: string;
  details?: Record<string, unknown>;
}

export interface ArtifactDiagnosticsReport {
  repoDir: string;
  featureDir: string | null;
  taskId: string | null;
  slug: string | null;
  traceId: string | null;
  generatedAt: string;
  artifacts: {
    taskContract: { path: string; present: boolean; malformed: boolean };
    featureState: { path: string; present: boolean; malformed: boolean };
    trace: { path: string; present: boolean; malformedLines: number };
  };
  findings: ArtifactDiagnosticFinding[];
  summary: { info: number; warn: number; error: number };
}

export interface DiagnoseArtifactsOptions {
  repoDir: string;
  taskId?: string;
  slug?: string;
  featureDir?: string;
}

// ── Internal Read Result Types ────────────────────────────────────────────────

type JsonReadResult<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T }
  | { status: 'malformed'; reason: string };

type JsonlReadResult<T> = {
  records: T[];
  malformedLines: Array<{ line: number; reason: string }>;
  missing: boolean;
};

// ── Tolerant Readers ──────────────────────────────────────────────────────────

function readJsonTolerant<T = Record<string, unknown>>(filePath: string): JsonReadResult<T> {
  if (!existsSync(filePath)) {
    return { status: 'missing' };
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.trim()) {
      return { status: 'malformed', reason: 'file is empty' };
    }
    const parsed = JSON.parse(content) as T;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 'malformed', reason: 'top-level value is not an object' };
    }
    return { status: 'ok', value: parsed };
  } catch (err) {
    return { status: 'malformed', reason: err instanceof Error ? err.message : String(err) };
  }
}

function readJsonlTolerant<T>(filePath: string): JsonlReadResult<T> {
  if (!existsSync(filePath)) {
    return { records: [], malformedLines: [], missing: true };
  }
  const records: T[] = [];
  const malformedLines: Array<{ line: number; reason: string }> = [];

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      records: [],
      malformedLines: [{ line: 0, reason: err instanceof Error ? err.message : String(err) }],
      missing: false,
    };
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as T;
      records.push(parsed);
    } catch (err) {
      malformedLines.push({ line: i + 1, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { records, malformedLines, missing: false };
}

function readWorkflowState(repoDir: string): Record<string, unknown> | null {
  const statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  const result = readJsonTolerant(statePath);
  return result.status === 'ok' ? result.value : null;
}

function readEvalRecordsTolerant(repoDir: string): { records: EvalRecord[]; malformedLines: Array<{ line: number; reason: string }> } {
  let evalsDir: string;
  try {
    evalsDir = resolveEvalsDir(undefined, repoDir).dir;
  } catch {
    return { records: [], malformedLines: [] };
  }
  const evalsPath = join(evalsDir, 'evals.jsonl');
  const result = readJsonlTolerant<EvalRecord>(evalsPath);
  return { records: result.records, malformedLines: result.malformedLines };
}

// ── Feature Directory Resolution ──────────────────────────────────────────────

interface ResolvedIdentity {
  featureDir: string | null;
  taskId: string | null;
  slug: string | null;
  ambiguous?: boolean;
  candidates?: string[];
}

function resolveIdentity(opts: DiagnoseArtifactsOptions): ResolvedIdentity {
  const { repoDir } = opts;

  // Explicit featureDir — highest priority
  if (opts.featureDir) {
    const absDir = resolve(opts.featureDir);
    const slug = opts.slug ?? readSlugFromFeatureDir(absDir);
    const taskId = opts.taskId ?? readTaskIdFromFeatureDir(absDir);
    return { featureDir: absDir, taskId, slug };
  }

  // Explicit slug
  if (opts.slug) {
    const featureDir = join(repoDir, 'features', opts.slug);
    const taskId = opts.taskId ?? readTaskIdFromFeatureDir(featureDir);
    return { featureDir, taskId, slug: opts.slug };
  }

  // Explicit taskId — search workflow-state, then scan features/
  if (opts.taskId) {
    const workflowState = readWorkflowState(repoDir);
    if (workflowState) {
      const tasks = workflowState.tasks as Record<string, unknown> | undefined;
      if (tasks && typeof tasks === 'object') {
        for (const [id, task] of Object.entries(tasks)) {
          if (id === opts.taskId && task && typeof task === 'object') {
            const t = task as Record<string, unknown>;
            // Try worktree path first
            if (typeof t.worktree === 'string' && existsSync(t.worktree)) {
              const slug = typeof t.slug === 'string' ? t.slug : readSlugFromFeatureDir(t.worktree);
              return { featureDir: t.worktree, taskId: opts.taskId, slug };
            }
            // Try slug-based path
            if (typeof t.slug === 'string') {
              const featureDir = join(repoDir, 'features', t.slug);
              return { featureDir, taskId: opts.taskId, slug: t.slug };
            }
          }
        }
      }
    }

    // Fall back to scanning features/ directories
    const featuresDir = join(repoDir, 'features');
    if (existsSync(featuresDir)) {
      const matches: string[] = [];
      for (const entry of safeReaddirSync(featuresDir)) {
        const candidate = join(featuresDir, entry);
        const tid = readTaskIdFromFeatureDir(candidate);
        if (tid === opts.taskId) {
          matches.push(candidate);
        }
      }
      if (matches.length === 1) {
        const slug = readSlugFromFeatureDir(matches[0]);
        return { featureDir: matches[0], taskId: opts.taskId, slug };
      }
      if (matches.length > 1) {
        return { featureDir: null, taskId: opts.taskId, slug: null, ambiguous: true, candidates: matches };
      }
    }

    return { featureDir: null, taskId: opts.taskId, slug: null };
  }

  // No identity provided — check if exactly one feature dir has selected-task.json
  const featuresDir = join(repoDir, 'features');
  if (existsSync(featuresDir)) {
    const withTask: string[] = [];
    for (const entry of safeReaddirSync(featuresDir)) {
      const candidate = join(featuresDir, entry);
      if (existsSync(join(candidate, 'selected-task.json'))) {
        withTask.push(candidate);
      }
    }
    if (withTask.length === 1) {
      const featureDir = withTask[0];
      const slug = readSlugFromFeatureDir(featureDir);
      const taskId = readTaskIdFromFeatureDir(featureDir);
      return { featureDir, taskId, slug };
    }
  }

  return { featureDir: null, taskId: null, slug: null };
}

function safeReaddirSync(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readSlugFromFeatureDir(featureDir: string): string | null {
  const selectedTaskPath = join(featureDir, 'selected-task.json');
  const result = readJsonTolerant<Record<string, unknown>>(selectedTaskPath);
  if (result.status === 'ok' && typeof result.value.featureName === 'string') {
    return result.value.featureName;
  }
  return null;
}

function readTaskIdFromFeatureDir(featureDir: string): string | null {
  const selectedTaskPath = join(featureDir, 'selected-task.json');
  const result = readJsonTolerant<Record<string, unknown>>(selectedTaskPath);
  if (result.status === 'ok' && typeof result.value.taskId === 'string') {
    return result.value.taskId;
  }
  return null;
}

// ── SHA-256 helper ────────────────────────────────────────────────────────────

function sha256Hex(filePath: string): string | null {
  try {
    const bytes = readFileSync(filePath);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

// ── Finding builders ──────────────────────────────────────────────────────────

function makeFinding(
  code: ArtifactFindingCode,
  severity: ArtifactFindingSeverity,
  message: string,
  extras?: Partial<ArtifactDiagnosticFinding>,
): ArtifactDiagnosticFinding {
  return { code, severity, message, ...extras };
}

// ── Cross-source checks ───────────────────────────────────────────────────────

function checkContractHashDrift(
  featureDir: string,
  contract: TaskContract,
): ArtifactDiagnosticFinding[] {
  const findings: ArtifactDiagnosticFinding[] = [];
  const contractPath = join(featureDir, 'task-contract.json');

  for (const source of contract.sources) {
    if (!source.exists || source.sha256 === null) continue;
    const absPath = join(featureDir, source.path);
    if (!existsSync(absPath)) continue;

    const currentHash = sha256Hex(absPath);
    if (currentHash && currentHash !== source.sha256) {
      findings.push(makeFinding(
        'contract_hash_drift',
        'warn',
        `Source file hash has changed since contract was built: ${source.path}`,
        {
          file: contractPath,
          gateId: 'contract_source_hash_mismatch',
          expected: `hash ${source.sha256}`,
          actual: `hash ${currentHash}`,
          recommendedAction: `Rebuild task-contract.json after updating ${source.path}`,
          details: {
            sourcePath: source.path,
            storedSha256: source.sha256,
            currentSha256: currentHash,
          },
        },
      ));
    }
  }
  return findings;
}

function checkFeatureOutcomeStateMismatch(
  featureDir: string,
  featureState: FeatureState,
  workflowState: Record<string, unknown> | null,
  taskId: string | null,
  slug: string | null,
): ArtifactDiagnosticFinding[] {
  if (!workflowState) return [];

  const tasks = workflowState.tasks as Record<string, Record<string, unknown>> | undefined;
  if (!tasks || typeof tasks !== 'object') return [];

  // Find the matching task entry
  let taskEntry: Record<string, unknown> | null = null;
  for (const [id, task] of Object.entries(tasks)) {
    if (taskId && id === taskId) {
      taskEntry = task;
      break;
    }
    // Match by slug or worktree
    if (slug && typeof task.slug === 'string' && task.slug === slug) {
      taskEntry = task;
      break;
    }
    if (typeof task.worktree === 'string' && task.worktree === featureDir) {
      taskEntry = task;
      break;
    }
  }

  if (!taskEntry) return [];

  const workflowPhase = typeof taskEntry.phase === 'string' ? taskEntry.phase : null;
  const workflowStatus = typeof taskEntry.status === 'string' ? taskEntry.status : null;
  const featurePhase = featureState.currentPhase;
  const featureNormalized = featureState.normalizedState;

  const findings: ArtifactDiagnosticFinding[] = [];
  const statePath = join(featureDir, 'feature-state.json');

  // Phase mismatch check
  if (workflowPhase && featurePhase !== 'unknown' && workflowPhase !== featurePhase) {
    // Allow 'done' feature phase when workflow says 'ready' completed
    const compatible = (featurePhase === 'done' && workflowPhase === 'ready');
    if (!compatible) {
      findings.push(makeFinding(
        'feature_outcome_state_mismatch',
        'warn',
        `Phase mismatch: workflow-state says "${workflowPhase}", feature-state says "${featurePhase}"`,
        {
          file: statePath,
          gateId: 'outcome_divergence',
          expected: `workflow phase ${workflowPhase}`,
          actual: `feature-state phase ${featurePhase}`,
          recommendedAction: 'Rebuild feature-state.json and inspect workflow-state.json for stale phase data',
          details: {
            workflowPhase,
            featurePhase,
            workflowStatus,
            featureNormalizedState: featureNormalized,
          },
        },
      ));
    }
  }

  // Status mismatch check
  if (workflowStatus && featureNormalized !== 'unknown') {
    const isCompatible = checkStatusCompatibility(workflowStatus, featureNormalized, featurePhase);
    if (!isCompatible) {
      findings.push(makeFinding(
        'feature_outcome_state_mismatch',
        'warn',
        `State mismatch: workflow-state status is "${workflowStatus}", feature-state normalizedState is "${featureNormalized}"`,
        {
          file: statePath,
          gateId: 'outcome_divergence',
          expected: `workflow status ${workflowStatus}`,
          actual: `feature-state normalizedState ${featureNormalized}`,
          recommendedAction: 'Rebuild feature-state.json and inspect workflow-state.json for stale status data',
          details: {
            workflowStatus,
            featureNormalizedState: featureNormalized,
            featurePhase,
          },
        },
      ));
    }
  }

  return findings;
}

function checkStatusCompatibility(
  workflowStatus: string,
  featureNormalized: string,
  featurePhase: string,
): boolean {
  if (workflowStatus === featureNormalized) return true;
  // workflow complete/done/merged is compatible with feature 'completed' when phase is done
  if (
    ['complete', 'done', 'merged'].includes(workflowStatus) &&
    featureNormalized === 'completed' &&
    featurePhase === 'done'
  ) {
    return true;
  }
  // running/active is compatible with running
  if (['active', 'running'].includes(workflowStatus) && featureNormalized === 'running') {
    return true;
  }
  return false;
}

function checkCodingCompleteWithoutEvidence(
  featureDir: string,
  featureState: FeatureState,
): ArtifactDiagnosticFinding[] {
  const codingCompleteMarker = join(featureDir, '.coding-complete');
  const codingResultPath = join(featureDir, '.coding-result.json');

  const markerExists = existsSync(codingCompleteMarker);
  const codingResult = readJsonTolerant<Record<string, unknown>>(codingResultPath);
  const codingResultCompleted = codingResult.status === 'ok' && codingResult.value.status === 'completed';

  if (!markerExists && !codingResultCompleted) return [];

  // Check for positive evidence
  const passEvidence = featureState.evidence.filter(e => e.status === 'pass');
  const nonMarkerPassEvidence = passEvidence.filter(e => e.kind !== 'legacy_marker');

  const outcome = featureState.outcome;
  const hasPositiveOutcome =
    outcome.readyPassed === true ||
    outcome.reviewPassed === true ||
    outcome.ciPassed === true ||
    outcome.merged === true ||
    (outcome.evalScore !== null && outcome.evalScore >= 0.5);

  if (nonMarkerPassEvidence.length === 0 && !hasPositiveOutcome) {
    return [makeFinding(
      'coding_complete_without_evidence',
      'warn',
      'Coding is marked complete but feature-state has no passing evidence beyond legacy markers',
      {
        file: join(featureDir, 'feature-state.json'),
        gateId: 'completion_without_evidence',
        expected: 'passing verification evidence',
        actual: 'no non-marker passing evidence',
        recommendedAction: 'Verify CI/ready evidence or rerun verification before relying on completion markers',
        details: {
          markerExists,
          codingResultCompleted,
          evidenceCount: featureState.evidence.length,
          passEvidenceCount: passEvidence.length,
        },
      },
    )];
  }

  return [];
}

function checkEvalWithoutOutcome(
  featureDir: string,
  featureStateResult: JsonReadResult<FeatureState>,
  evalRecords: EvalRecord[],
  taskId: string | null,
  slug: string | null,
  traceId: string | null,
  repoDir: string,
): ArtifactDiagnosticFinding[] {
  // Find matching eval records. Match by traceId, issueId, or challengePairId
  // derived from the taskId (the `<id>_c` challenger convention) so challenge
  // pair evals are not silently missed.
  const challengePairId = taskId ? `${taskId}_c` : null;
  const matchingEvals = evalRecords.filter(r => {
    if (traceId && r.traceId === traceId) return true;
    if (taskId && r.issueId === taskId) return true;
    if (challengePairId && r.challengePairId === challengePairId) return true;
    return false;
  });

  if (matchingEvals.length === 0) return [];

  // Check if feature state is final
  const isFinal = featureStateResult.status === 'ok' &&
    (featureStateResult.value.outcome.completed === true || featureStateResult.value.currentPhase === 'done');

  // Also check archive dir for archived feature-state
  if (!isFinal && taskId) {
    let archiveDir: string | undefined;
    try {
      archiveDir = resolveRouteArtifactArchiveDir(taskId, repoDir);
    } catch {
      archiveDir = undefined;
    }
    if (archiveDir) {
      const archivedStatePath = join(archiveDir, 'feature-state.json');
      const archivedResult = readJsonTolerant<FeatureState>(archivedStatePath);
      if (archivedResult.status === 'ok' &&
        (archivedResult.value.outcome.completed === true || archivedResult.value.currentPhase === 'done')) {
        return [];
      }
    }
  }

  if (!isFinal) {
    return [makeFinding(
      'eval_without_outcome',
      'warn',
      `${matchingEvals.length} eval record(s) found but feature-state is absent or non-final`,
      {
        file: join(featureDir, 'feature-state.json'),
        gateId: 'eval_without_outcome',
        expected: 'final normalized feature outcome for eval-linked task',
        actual: 'feature-state absent or non-final',
        recommendedAction: 'Materialize a final feature-state artifact before exporting or analyzing evals',
        details: {
          evalCount: matchingEvals.length,
          featureStatePresent: featureStateResult.status !== 'missing',
          featurePhase: featureStateResult.status === 'ok' ? featureStateResult.value.currentPhase : null,
        },
      },
    )];
  }

  return [];
}

function checkTraceIdMissing(
  featureDir: string,
  traceId: string | null,
  evalRecords: EvalRecord[],
  taskId: string | null,
): ArtifactDiagnosticFinding[] {
  if (!traceId) return [];

  const findings: ArtifactDiagnosticFinding[] = [];
  const routePaths = ['.initial-route.json', '.post-expansion-route.json'];

  for (const routePath of routePaths) {
    const absPath = join(featureDir, routePath);
    if (!existsSync(absPath)) continue;
    const result = readJsonTolerant<Record<string, unknown>>(absPath);
    if (result.status === 'ok' && !result.value.traceId) {
      findings.push(makeFinding(
        'trace_id_missing',
        'info',
        `Route artifact does not include traceId: ${routePath}`,
        {
          file: absPath,
          gateId: 'trace_linkage_missing',
          expected: `traceId ${traceId}`,
          actual: 'traceId missing from route artifact',
          recommendedAction: 'Rewrite the route artifact with the active traceId',
          details: { traceId, artifactClass: 'route' },
        },
      ));
    } else if (result.status === 'ok' && result.value.traceId !== traceId) {
      findings.push(makeFinding(
        'trace_id_missing',
        'info',
        `Route artifact traceId does not match trace context: ${routePath}`,
        {
          file: absPath,
          gateId: 'trace_linkage_missing',
          expected: `traceId ${traceId}`,
          actual: `traceId ${String(result.value.traceId)}`,
          recommendedAction: 'Rewrite the route artifact with the active traceId',
          details: { traceId, artifactClass: 'route', observedTraceId: result.value.traceId },
        },
      ));
    }
  }

  const stageResultPaths = ['.planning-result.json', '.coding-result.json', '.review-result.json', '.ready-result.json'];
  let stagesMissingTraceId = 0;
  const stagesPresent: string[] = [];
  for (const stagePath of stageResultPaths) {
    const absPath = join(featureDir, stagePath);
    if (!existsSync(absPath)) continue;
    const result = readJsonTolerant<Record<string, unknown>>(absPath);
    if (result.status === 'ok' && !result.value.traceId) {
      stagesMissingTraceId++;
      stagesPresent.push(stagePath);
    }
  }
  if (stagesMissingTraceId > 0) {
    findings.push(makeFinding(
      'trace_id_missing',
      'info',
      `${stagesMissingTraceId} stage result(s) do not include traceId`,
      {
        file: featureDir,
        gateId: 'trace_linkage_missing',
        expected: `traceId ${traceId}`,
        actual: `traceId missing from ${stagesMissingTraceId} stage result(s)`,
        recommendedAction: 'Rewrite stage result files with the active traceId',
        details: { traceId, artifactClass: 'stage', stages: stagesPresent },
      },
    ));
  }

  const matchingEvals = evalRecords.filter((record) => {
    if (taskId && record.issueId === taskId) return true;
    return false;
  });
  const missingEvalTrace = matchingEvals.filter((record) => !record.traceId);
  const mismatchedEvalTrace = matchingEvals.filter((record) => record.traceId && record.traceId !== traceId);

  if (missingEvalTrace.length > 0) {
    findings.push(makeFinding(
      'trace_id_missing',
      'info',
      `${missingEvalTrace.length} eval record(s) do not include traceId`,
      {
        file: join(featureDir, 'trace.jsonl'),
        gateId: 'trace_linkage_missing',
        expected: `traceId ${traceId}`,
        actual: 'traceId missing from eval record(s)',
        recommendedAction: 'Persist eval records with the active traceId',
        details: { traceId, artifactClass: 'eval', evalIds: missingEvalTrace.map((record) => record.id) },
      },
    ));
  }

  if (mismatchedEvalTrace.length > 0) {
    findings.push(makeFinding(
      'trace_id_missing',
      'info',
      `${mismatchedEvalTrace.length} eval record(s) carry a different traceId`,
      {
        file: join(featureDir, 'trace.jsonl'),
        gateId: 'trace_linkage_missing',
        expected: `traceId ${traceId}`,
        actual: `mismatched eval traceIds: ${mismatchedEvalTrace.map((record) => record.traceId).join(',')}`,
        recommendedAction: 'Persist eval records with the active traceId',
        details: { traceId, artifactClass: 'eval', evalIds: mismatchedEvalTrace.map((record) => record.id) },
      },
    ));
  }

  return findings;
}

function checkTraceEventUnreflected(
  featureDir: string,
  traceEvents: TraceEvent[],
  featureState: FeatureState | null,
): ArtifactDiagnosticFinding[] {
  if (traceEvents.length === 0 || !featureState) return [];

  const findings: ArtifactDiagnosticFinding[] = [];

  const routeEvents = traceEvents.filter(e =>
    e.event === 'route_assigned' || e.event === 'route_promoted',
  );
  const fallbackEvents = traceEvents.filter(e => e.event === 'fallback_used');
  const checkFailedEvents = traceEvents.filter(e => e.event === 'check_failed');

  // Route events should be reflected in feature-state route provenance
  if (routeEvents.length > 0 && !featureState.route) {
    findings.push(makeFinding(
      'trace_event_unreflected',
      'info',
      `${routeEvents.length} route event(s) in trace but feature-state has no route provenance`,
      {
        file: join(featureDir, 'trace.jsonl'),
        gateId: 'trace_event_unreflected',
        expected: 'route provenance in feature-state',
        actual: 'trace route events without feature-state route provenance',
        recommendedAction: 'Rebuild feature-state.json after route artifacts are written',
        details: {
          routeEventCount: routeEvents.length,
          eventNames: [...new Set(routeEvents.map(e => e.event))],
        },
      },
    ));
  }

  // Fallback events should be reflected in blockers or failure reason
  if (fallbackEvents.length > 0) {
    const hasBlockerOrFailure = featureState.blockers.length > 0 || featureState.failureReason !== null;
    const hasFallbackEvidence = featureState.evidence.some(
      e => e.status === 'fail' || e.kind === 'blocked_completion',
    );
    if (!hasBlockerOrFailure && !hasFallbackEvidence) {
      findings.push(makeFinding(
        'trace_event_unreflected',
        'info',
        `${fallbackEvents.length} fallback event(s) in trace not reflected in feature-state blockers or failure signals`,
        {
          file: join(featureDir, 'trace.jsonl'),
          gateId: 'trace_event_unreflected',
          expected: 'fallback safeguards or blocker evidence',
          actual: 'fallback trace events without blockers or failure signals',
          recommendedAction: 'Record fallback remediation or verification safeguards in normalized outcome artifacts',
          details: { fallbackEventCount: fallbackEvents.length },
        },
      ));
    }
  }

  // Check-failure events should be reflected in blockers or failing evidence
  if (checkFailedEvents.length > 0) {
    const hasFailEvidence = featureState.evidence.some(e => e.status === 'fail');
    const hasBlockers = featureState.blockers.length > 0;
    if (!hasFailEvidence && !hasBlockers) {
      findings.push(makeFinding(
        'trace_event_unreflected',
        'info',
        `${checkFailedEvents.length} check_failed event(s) in trace not reflected in feature-state blockers or evidence`,
        {
          file: join(featureDir, 'trace.jsonl'),
          gateId: 'trace_event_unreflected',
          expected: 'failed-check evidence or blockers',
          actual: 'check_failed trace events without blockers or failing evidence',
          recommendedAction: 'Record failed checks in stage results or normalized outcome evidence',
          details: { checkFailedEventCount: checkFailedEvents.length },
        },
      ));
    }
  }

  return findings;
}

function normalizeArtifactPathForLookup(featureDir: string, candidate: string): string[] {
  const raw = candidate.trim();
  if (!raw) return [];
  const normalizedCandidates = new Set<string>();
  normalizedCandidates.add(normalize(raw).replace(/\\/g, '/'));
  if (isAbsolute(raw)) {
    const rel = relative(featureDir, raw).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..')) {
      normalizedCandidates.add(normalize(rel).replace(/\\/g, '/'));
    }
  }
  normalizedCandidates.add(basename(raw));
  return [...normalizedCandidates].filter(Boolean);
}

function findContractSourceHash(
  featureDir: string,
  contract: TaskContract,
  inputPath: string,
): { sourcePath: string; sha256: string } | null {
  const candidates = normalizeArtifactPathForLookup(featureDir, inputPath);
  for (const candidate of candidates) {
    const exact = contract.sources.find((source) => source.path === candidate && typeof source.sha256 === 'string');
    if (exact?.sha256) {
      return { sourcePath: exact.path, sha256: exact.sha256 };
    }
  }
  for (const candidate of candidates) {
    const byBaseName = contract.sources.find(
      (source) => basename(source.path) === basename(candidate) && typeof source.sha256 === 'string',
    );
    if (byBaseName?.sha256) {
      return { sourcePath: byBaseName.path, sha256: byBaseName.sha256 };
    }
  }
  return null;
}

function checkRouteContractMismatch(
  featureDir: string,
  contract: TaskContract,
): ArtifactDiagnosticFinding[] {
  const findings: ArtifactDiagnosticFinding[] = [];
  const routeArtifacts = [
    '.initial-route.json',
    '.post-expansion-route.json',
    '.routing-complete',
  ];

  for (const routeArtifact of routeArtifacts) {
    const routePath = join(featureDir, routeArtifact);
    const result = readJsonTolerant<Record<string, unknown>>(routePath);
    if (result.status !== 'ok') continue;
    const provenance = result.value.provenance as Record<string, unknown> | undefined;
    const inputPath = typeof provenance?.inputPath === 'string' ? provenance.inputPath : '';
    const inputHash = typeof provenance?.inputHash === 'string' ? provenance.inputHash : '';
    if (!inputPath || !inputHash) continue;

    const contractSource = findContractSourceHash(featureDir, contract, inputPath);
    if (!contractSource) continue;

    if (contractSource.sha256 !== inputHash) {
      findings.push(makeFinding(
        'route_contract_mismatch',
        'warn',
        `Route artifact input hash does not match the active contract source: ${routeArtifact}`,
        {
          file: routePath,
          gateId: 'route_contract_mismatch',
          expected: `contract source ${contractSource.sourcePath} hash ${contractSource.sha256}`,
          actual: `route provenance ${inputPath} hash ${inputHash}`,
          recommendedAction: 'Regenerate route artifacts from the current task packet or plan and refresh feature-state.json',
          details: {
            routeArtifact,
            routeInputPath: inputPath,
            routeInputHash: inputHash,
            contractSourcePath: contractSource.sourcePath,
            contractSourceHash: contractSource.sha256,
          },
        },
      ));
    }
  }

  return findings;
}

function checkReadyInconsistency(
  featureDir: string,
  featureState: FeatureState,
): ArtifactDiagnosticFinding[] {
  const readyResultPath = join(featureDir, '.ready-result.json');
  const readyResult = readJsonTolerant<Record<string, unknown>>(readyResultPath);
  if (readyResult.status !== 'ok') return [];

  const artifacts = readyResult.value.artifacts as Record<string, unknown> | undefined;
  const verdict = typeof artifacts?.verdict === 'string'
    ? artifacts.verdict
    : typeof readyResult.value.verdict === 'string'
      ? readyResult.value.verdict
      : '';
  if (verdict !== 'pass') return [];

  const passEvidence = featureState.evidence.some(
    (e) => e.kind === 'ready_check' && e.label === 'ready_verdict' && e.status === 'pass',
  );
  const failReadyEvidence = featureState.evidence.some(
    (e) => e.kind === 'ready_check' && e.status === 'fail',
  );

  if (featureState.outcome.readyPassed !== true || !passEvidence || failReadyEvidence) {
    const actualParts: string[] = [];
    if (featureState.outcome.readyPassed !== true) {
      actualParts.push(`readyPassed=${String(featureState.outcome.readyPassed)}`);
    }
    if (!passEvidence) {
      actualParts.push('missing ready_verdict pass evidence');
    }
    if (failReadyEvidence) {
      actualParts.push('ready evidence includes failure');
    }
    return [makeFinding(
      'ready_inconsistency',
      'warn',
      'Ready result passed but normalized outcome evidence disagrees',
      {
        file: join(featureDir, 'feature-state.json'),
        gateId: 'ready_inconsistency',
        expected: 'ready pass reflected in feature-state outcome and evidence',
        actual: actualParts.join('; '),
        recommendedAction: 'Rebuild feature-state.json from the latest ready result and verify ready evidence fields',
        details: {
          readyVerdict: verdict,
          readyPassed: featureState.outcome.readyPassed,
          passEvidence,
          failReadyEvidence,
        },
      },
    )];
  }

  return [];
}

function checkEvalExportInconsistency(
  featureDir: string,
  evalRecords: EvalRecord[],
  taskId: string | null,
  traceId: string | null,
  repoDir: string,
): ArtifactDiagnosticFinding[] {
  const matchingEvals = evalRecords.filter((record) => {
    if (record.trainingEligible !== true) return false;
    if (traceId && record.traceId === traceId) return true;
    if (taskId && record.issueId === taskId) return true;
    return false;
  });
  if (matchingEvals.length === 0) return [];

  let archiveDir: string | undefined;
  try {
    archiveDir = taskId ? resolveRouteArtifactArchiveDir(taskId, repoDir) : undefined;
  } catch {
    archiveDir = undefined;
  }
  const diagnostics = loadFeatureOutcomeDiagnostics({ featureDir, archiveDir });
  const missingFields = diagnostics.missingFields ?? [];
  if (!diagnostics.present || (diagnostics.used !== false && missingFields.length === 0)) {
    return [];
  }

  return [makeFinding(
    'eval_export_inconsistency',
    'warn',
    'Training-eligible eval record exists but normalized outcome is missing required export fields',
    {
      file: join(featureDir, diagnostics.sourceFile ?? 'feature-state.json'),
      gateId: 'eval_export_inconsistency',
      expected: 'training-eligible evals backed by complete normalized outcome fields',
      actual: diagnostics.present
        ? `feature outcome ${diagnostics.reason ?? 'incomplete'} with missing fields ${missingFields.join(',') || 'unknown'}`
        : 'feature outcome artifact absent',
      recommendedAction: 'Materialize a complete feature-state.json before using the eval record for export or training diagnostics',
      details: {
        evalIds: matchingEvals.map((record) => record.id),
        reason: diagnostics.reason,
        missingFields,
        used: diagnostics.used,
      },
    },
  )];
}

function checkFallbackVerificationMismatch(
  featureDir: string,
  traceEvents: TraceEvent[],
  featureState: FeatureState | null,
): ArtifactDiagnosticFinding[] {
  const fallbackEvents = traceEvents.filter((event) => event.event === 'fallback_used');
  if (fallbackEvents.length === 0) return [];

  const hasRemediation = traceEvents.some((event) => event.event === 'remediation_started');
  const reviewResult = readJsonTolerant<Record<string, unknown>>(join(featureDir, '.review-result.json'));
  const reviewStatus = reviewResult.status === 'ok' && typeof reviewResult.value.status === 'string'
    ? reviewResult.value.status
    : null;
  const reviewArtifacts = reviewResult.status === 'ok'
    ? reviewResult.value.artifacts as Record<string, unknown> | undefined
    : undefined;
  const hasStrongerReviewSignal = Boolean(
    hasRemediation
      || (typeof reviewArtifacts?.blockingIssues === 'number' && reviewArtifacts.blockingIssues > 0)
      || reviewStatus === 'awaiting_user'
      || reviewStatus === 'failed'
      || featureState?.blockers.some((blocker) => blocker.code === 'review_blocking_issue')
      || featureState?.failureReason === 'review_rejected'
      || featureState?.evidence.some((evidence) => evidence.kind === 'review_verdict' && evidence.status === 'fail'),
  );

  if (hasStrongerReviewSignal) {
    return [];
  }

  return [makeFinding(
    'fallback_verification_mismatch',
    'warn',
    'Trace shows weaker-model fallback without recorded verification safeguards',
    {
      file: join(featureDir, 'trace.jsonl'),
      gateId: 'fallback_verification_mismatch',
      expected: 'fallback escalation reflected in remediation or review safeguards',
      actual: 'fallback_used events present without remediation_started or stronger review signals',
      recommendedAction: 'Record remediation or stronger-review safeguards when fallback to a weaker model occurs',
      details: {
        fallbackEventCount: fallbackEvents.length,
        reviewStatus,
        hasRemediation,
      },
    },
  )];
}

// ── Main Diagnostic Function ──────────────────────────────────────────────────

/**
 * Diagnose normalized task artifacts for a given feature.
 *
 * Read-only. Never throws. Reports coverage gaps, hash drift, state
 * mismatches, and trace inconsistencies as structured findings.
 */
export function diagnoseArtifacts(options: DiagnoseArtifactsOptions): ArtifactDiagnosticsReport {
  const repoDir = resolve(options.repoDir);
  const identity = resolveIdentity({ ...options, repoDir });
  const { featureDir, taskId, slug } = identity;
  const findings: ArtifactDiagnosticFinding[] = [];

  const generatedAt = new Date().toISOString();

  // Artifact path defaults (even when featureDir is null, for the report shape)
  const contractPath = featureDir ? join(featureDir, 'task-contract.json') : '';
  const statePath = featureDir ? join(featureDir, 'feature-state.json') : '';
  const tracePath = featureDir ? join(featureDir, 'trace.jsonl') : '';

  let contractMeta = { path: contractPath, present: false, malformed: false };
  let stateMeta = { path: statePath, present: false, malformed: false };
  let traceMeta = { path: tracePath, present: false, malformedLines: 0 };

  // Ambiguous feature dir warning — emit candidates and return early
  if (identity.ambiguous) {
    findings.push(makeFinding(
      'coverage_gap',
      'warn',
      `Multiple feature directories match taskId "${taskId ?? ''}" — cannot determine which to inspect`,
      {
        taskId: taskId ?? undefined,
        details: { candidates: identity.candidates ?? [] },
      },
    ));
    return buildReport(repoDir, null, taskId, slug, null, generatedAt, contractMeta, stateMeta, traceMeta, findings);
  }

  // Coverage gap for repo-level: no feature dir resolved
  if (!featureDir) {
    findings.push(makeFinding(
      'coverage_gap',
      'info',
      'No feature directory could be resolved — reporting repo-level coverage only',
    ));
    return buildReport(repoDir, null, taskId, slug, null, generatedAt, contractMeta, stateMeta, traceMeta, findings);
  }

  // ── Load artifacts ────────────────────────────────────────────────────────

  const contractResult = readJsonTolerant<TaskContract>(contractPath);
  const stateResult = readJsonTolerant<FeatureState>(statePath);
  const traceResult = readJsonlTolerant<TraceEvent>(tracePath);

  // Update artifact metadata
  contractMeta = {
    path: contractPath,
    present: contractResult.status !== 'missing',
    malformed: contractResult.status === 'malformed',
  };
  stateMeta = {
    path: statePath,
    present: stateResult.status !== 'missing',
    malformed: stateResult.status === 'malformed',
  };
  traceMeta = {
    path: tracePath,
    present: !traceResult.missing,
    malformedLines: traceResult.malformedLines.length,
  };

  // Coverage gap findings
  if (contractResult.status === 'missing') {
    findings.push(makeFinding('coverage_gap', 'info', 'task-contract.json is absent', { file: contractPath }));
  }
  if (stateResult.status === 'missing') {
    findings.push(makeFinding('coverage_gap', 'info', 'feature-state.json is absent', { file: statePath }));
  }
  if (traceResult.missing) {
    findings.push(makeFinding('coverage_gap', 'info', 'trace.jsonl is absent', { file: tracePath }));
  }

  // Malformed artifact findings
  if (contractResult.status === 'malformed') {
    findings.push(makeFinding('malformed', 'error', `task-contract.json is malformed: ${contractResult.reason}`, {
      file: contractPath,
      reason: contractResult.reason,
      gateId: 'artifact_malformed',
      expected: 'parseable JSON object',
      actual: contractResult.reason,
      recommendedAction: 'Rewrite task-contract.json with valid JSON',
    }));
  }
  if (stateResult.status === 'malformed') {
    findings.push(makeFinding('malformed', 'error', `feature-state.json is malformed: ${stateResult.reason}`, {
      file: statePath,
      reason: stateResult.reason,
      gateId: 'artifact_malformed',
      expected: 'parseable JSON object',
      actual: stateResult.reason,
      recommendedAction: 'Rewrite feature-state.json with valid JSON',
    }));
  }
  for (const { line, reason } of traceResult.malformedLines) {
    findings.push(makeFinding('malformed', 'error', `trace.jsonl line ${line} is malformed: ${reason}`, {
      file: tracePath,
      reason,
      gateId: 'artifact_malformed',
      expected: 'valid JSONL trace event',
      actual: reason,
      recommendedAction: 'Rewrite malformed trace.jsonl lines or regenerate trace artifacts',
      details: { line },
    }));
  }

  // ── Cross-source checks ───────────────────────────────────────────────────

  const workflowState = readWorkflowState(repoDir);
  const { records: evalRecords } = readEvalRecordsTolerant(repoDir);

  // Determine traceId from context or trace events
  const traceContextPath = join(featureDir, '.trace-context.json');
  const traceContextResult = readJsonTolerant<Record<string, unknown>>(traceContextPath);
  let traceId: string | null = null;
  if (traceContextResult.status === 'ok' && typeof traceContextResult.value.traceId === 'string') {
    traceId = traceContextResult.value.traceId;
  } else if (traceResult.records.length > 0 && traceResult.records[0].traceId) {
    traceId = traceResult.records[0].traceId;
  }

  // 1. Contract hash drift
  if (contractResult.status === 'ok') {
    findings.push(...checkContractHashDrift(featureDir, contractResult.value));
    findings.push(...checkRouteContractMismatch(featureDir, contractResult.value));
  }

  // 2. Feature outcome state mismatch
  if (stateResult.status === 'ok') {
    findings.push(...checkFeatureOutcomeStateMismatch(
      featureDir,
      stateResult.value,
      workflowState,
      taskId,
      slug,
    ));
  }

  // 3. Coding complete without evidence
  if (stateResult.status === 'ok') {
    findings.push(...checkCodingCompleteWithoutEvidence(featureDir, stateResult.value));
    findings.push(...checkReadyInconsistency(featureDir, stateResult.value));
  }

  // 4. Eval without final outcome
  findings.push(...checkEvalWithoutOutcome(
    featureDir,
    stateResult,
    evalRecords,
    taskId,
    slug,
    traceId,
    repoDir,
  ));

  // 5. Trace ID missing from route/stage artifacts
  findings.push(...checkTraceIdMissing(featureDir, traceId, evalRecords, taskId));

  // 6. Trace events not reflected in outcome
  const featureStateValue = stateResult.status === 'ok' ? stateResult.value : null;
  findings.push(...checkTraceEventUnreflected(featureDir, traceResult.records, featureStateValue));
  findings.push(...checkFallbackVerificationMismatch(featureDir, traceResult.records, featureStateValue));
  findings.push(...checkEvalExportInconsistency(featureDir, evalRecords, taskId, traceId, repoDir));

  return buildReport(repoDir, featureDir, taskId, slug, traceId, generatedAt, contractMeta, stateMeta, traceMeta, findings);
}

function buildReport(
  repoDir: string,
  featureDir: string | null,
  taskId: string | null,
  slug: string | null,
  traceId: string | null,
  generatedAt: string,
  contractMeta: { path: string; present: boolean; malformed: boolean },
  stateMeta: { path: string; present: boolean; malformed: boolean },
  traceMeta: { path: string; present: boolean; malformedLines: number },
  findings: ArtifactDiagnosticFinding[],
): ArtifactDiagnosticsReport {
  const summary = { info: 0, warn: 0, error: 0 };
  for (const f of findings) {
    summary[f.severity]++;
  }
  return {
    repoDir,
    featureDir,
    taskId,
    slug,
    traceId,
    generatedAt,
    artifacts: {
      taskContract: contractMeta,
      featureState: stateMeta,
      trace: traceMeta,
    },
    findings,
    summary,
  };
}
