import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  readHookStatus,
  readJobState,
  type JobStateDiagnostic,
  readPlanningResult,
  redactIncidentData,
} from './artifact-diagnostics.ts';
import {
  canonicalizeRootCauseClass,
  createIncidentDraft,
  isRemoteRootCauseClass,
  type IncidentCategory,
  type IncidentRecord,
  type IncidentRootCauseClass,
} from './wavemill-incident-model.ts';

const PLANNING_TERMINAL_REASONS = new Set([
  'turn_limit',
  'tool_call_limit',
  'wall_clock_limit',
  'tool_stagnation',
  'invalid_plan',
  'empty_final_plan',
  'provider_error',
  'aborted',
]);

export interface DetectorContext {
  repoDir: string;
  session?: string;
  now?: Date;
}

export class PlanningFailureDetector {
  detect(taskPath: string, taskId: string, context: DetectorContext): IncidentRecord[] {
    const resultPath = join(taskPath, '.planning-result.json');
    const result = readPlanningResult(resultPath);
    if (!result || result.error || result.status !== 'failed' || !result.failureReason) return [];
    const normalizedReason = normalizePlanningReason(result.failureReason);
    if (!PLANNING_TERMINAL_REASONS.has(normalizedReason)) return [];

    const timestamp = result.finishedAt ?? context.now?.toISOString() ?? new Date().toISOString();
    const planState = result.planFile
      ? (existsSync(resolveTaskPath(taskPath, result.planFile)) ? 'present' : 'missing')
      : 'not_referenced';
    const model = result.model ?? 'unknown_model';
    const agent = result.agent ?? 'unknown_planner';
    return [createIncidentDraft({
      taskId,
      session: context.session ?? null,
      category: 'model_task_harness_outcome',
      severity: 'high',
      confidence: 'definite',
      lifecycle: 'observed',
      rootCauseClass: normalizedReason,
      summary: `Planning failed with ${normalizedReason} for ${taskId}.`,
      operatorAction: 'Review task scope and native planning limits; simplify the task or adjust planning budgets before retrying.',
      evidence: [{
        type: 'planning_result',
        source: resultPath,
        timestamp,
        redactedData: redactIncidentData(`status=failed failureReason=${normalizedReason} planner=${agent} model=${model} planArtifact=${planState}`),
        key: normalizedReason,
      }, {
        type: 'log_excerpt',
        source: result.transcriptFile ? basename(result.transcriptFile) : '(no transcript)',
        timestamp,
        redactedData: redactIncidentData(`transcript_ref=${result.transcriptFile ? basename(result.transcriptFile) : 'none'} terminalReason=${normalizedReason}`),
        key: 'planning_transcript_ref',
      }],
      metadata: { planArtifactState: planState, planner: agent, model },
    })];
  }
}

export class WorkflowStateDetector {
  detect(taskPath: string, taskId: string, context: DetectorContext): IncidentRecord[] {
    const incidents: IncidentRecord[] = [];
    const workflowStatePath = join(context.repoDir, '.wavemill', 'workflow-state.json');
    const workflowState = readObjectFile(workflowStatePath);
    const taskState = workflowState ? taskEntry(workflowState, taskId) : null;
    const timestamp = context.now?.toISOString() ?? new Date().toISOString();

    for (const stage of ['coding', 'review', 'ready'] as const) {
      const markerPath = join(taskPath, `.${stage}-complete`);
      const resultPath = join(taskPath, `.${stage}-result.json`);
      const phase = stringField(taskState?.phase);
      if (existsSync(markerPath) && !existsSync(resultPath)) {
        // Marker mtime, not poll time: the same orphaned marker re-observed on
        // every cycle must keep a stable event identity.
        const markerTimestamp = safeMtimeIso(markerPath) ?? timestamp;
        incidents.push(createIncidentDraft({
          taskId,
          session: context.session ?? null,
          category: 'stale_orphaned_state',
          severity: 'medium',
          confidence: 'high',
          lifecycle: 'observed',
          rootCauseClass: 'orphaned_completion_marker',
          summary: `${taskId} has a ${stage} completion marker without a result artifact.`,
          operatorAction: 'Verify workflow state and recover the missing stage result or clear the stale marker through the normal controller path.',
          evidence: [{
            type: 'workflow_state',
            source: workflowStatePath,
            timestamp: markerTimestamp,
            redactedData: redactIncidentData(`stage=${stage} phase=${phase ?? 'unknown'} marker=${basename(markerPath)} resultMissing=true`),
            key: `orphaned_${stage}_marker`,
          }],
          metadata: { stage, markerPath, resultPath },
        }));
      }
    }

    return incidents;
  }
}

export class JobFailureDetector {
  detect(repoDir: string, taskId: string | null, context: DetectorContext): IncidentRecord[] {
    const incidents: IncidentRecord[] = [];
    const seen = new Set<string>();
    const timestamp = context.now?.toISOString() ?? new Date().toISOString();

    for (const job of readJobs(repoDir)) {
      const key = job.id ?? `${job.kind}:${job.issueId}:${job.startedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (job.status !== 'failed' && job.status !== 'timeout') continue;
      const subjectTaskId = jobSubjectTaskId(job);
      if (taskId && subjectTaskId !== taskId) continue;

      const missingResult = job.resultPath ? !existsSync(job.resultPath) : /no_result|missing/i.test(job.reason ?? '');
      const missingEvalEvidence = job.kind === 'comparison' && /eval|record|no_result|missing/i.test(`${job.reason ?? ''} ${job.error ?? ''}`);
      const rootCauseClass = missingEvalEvidence ? 'missing_eval_records_for_comparison' : missingResult ? 'failed_job_no_result' : 'failed_background_job';
      incidents.push(createIncidentDraft({
        taskId: subjectTaskId,
        session: context.session ?? null,
        category: rootCauseClass === 'failed_background_job' ? 'product_defect' : 'stale_orphaned_state',
        severity: 'medium',
        confidence: 'definite',
        lifecycle: 'observed',
        rootCauseClass,
        summary: `${job.kind ?? 'background'} job ${job.id ?? '(unknown)'} ended ${job.status}.`,
        operatorAction: missingEvalEvidence
          ? 'Inspect eval-record production for the compared pair and retry comparison only after records exist.'
          : 'Review the managed job result/log evidence and retry or settle the orphaned job through the controller.',
        evidence: [{
          type: 'job_state',
          source: job.source,
          // Terminal event time, not poll time: an un-reaped historical failure
          // must not register a fresh occurrence every observer cycle.
          timestamp: job.finishedAt ?? job.startedAt ?? timestamp,
          redactedData: redactIncidentData(`id=${job.id ?? 'unknown'} kind=${job.kind ?? 'unknown'} status=${job.status} reason=${job.reason ?? 'unknown'} resultMissing=${missingResult}`),
          key: rootCauseClass,
        }],
        metadata: { jobId: job.id, jobKind: job.kind, resultPath: job.resultPath, logPath: job.logPath },
      }));
    }

    return incidents;
  }
}

export interface DependencyHealthDetectorOptions {
  thresholdConsecutiveFailures?: number;
}

export class DependencyHealthDetector {
  private readonly options: DependencyHealthDetectorOptions;

  constructor(options: DependencyHealthDetectorOptions = {}) {
    this.options = options;
  }

  detect(repoDir: string, taskId: string, context: DetectorContext): IncidentRecord[] {
    return [
      ...this.detectTask(repoDir, taskId, context),
      ...this.detectRepo(repoDir, context),
    ];
  }

  detectTask(repoDir: string, taskId: string, context: DetectorContext): IncidentRecord[] {
    const incidents: IncidentRecord[] = [];
    const timestamp = context.now?.toISOString() ?? new Date().toISOString();
    const threshold = this.options.thresholdConsecutiveFailures ?? 3;

    for (const hookFile of safeReaddir('/tmp').filter((name) => name.startsWith('wavemill-') && name.endsWith('.hook') && name.includes(taskId))) {
      const hookPath = join('/tmp', hookFile);
      const hook = readHookStatus(hookPath);
      const detail = `${hook?.detail ?? ''} ${hook?.error ?? ''}`;
      if (!hook || !/\b(remote|ssh|git|github|ls-remote|network)\b/i.test(detail)) continue;
      const rootCauseClass = canonicalizeRootCauseClass(detail);
      const remote = isRemoteRootCauseClass(rootCauseClass);
      incidents.push(createIncidentDraft({
        taskId,
        session: context.session ?? null,
        category: dependencyCategoryFor(rootCauseClass),
        severity: 'low',
        confidence: 'low',
        lifecycle: 'observed',
        rootCauseClass,
        summary: remote
          ? `${taskId} observed a remote dependency probe failure.`
          : `${taskId} observed a local harness failure (${rootCauseClass}).`,
        operatorAction: `Watch for repetition; escalate only when this reaches ${threshold} consecutive observations or blocks workflow progress.`,
        evidence: [{
          type: 'hook_status',
          source: hookPath,
          timestamp: hook.timestamp ? new Date(hook.timestamp).toISOString() : timestamp,
          redactedData: redactIncidentData(`state=${hook.state ?? 'unknown'} event=${hook.event ?? 'unknown'} detail=${detail}`),
          key: remote ? 'remote_probe_failure' : rootCauseClass,
        }],
        metadata: { threshold },
      }));
    }

    return incidents;
  }

  detectRepo(repoDir: string, context: DetectorContext): IncidentRecord[] {
    const incidents: IncidentRecord[] = [];
    const timestamp = context.now?.toISOString() ?? new Date().toISOString();
    const threshold = this.options.thresholdConsecutiveFailures ?? 3;

    const queueHealthPath = join(repoDir, '.wavemill', 'queue-health.json');
    const queueHealth = readObjectFile(queueHealthPath);
    if (queueHealth?.status === 'degraded') {
      const reason = stringField(queueHealth.degradationReason) ?? 'dependency_planning_failed';
      const diagnostic = diagnosticReason(queueHealth) ?? reason;
      const failureCount = numberField(queueHealth.failureCount) ?? 1;
      const classified = canonicalizeRootCauseClass(diagnostic);
      // An unclassifiable degradation diagnostic is still a known local
      // condition of the queue planner, not free text.
      const rootCauseClass = classified === 'unclassified_local_failure' ? 'queue_planner_degraded' : classified;
      incidents.push(createIncidentDraft({
        taskId: null,
        session: context.session ?? null,
        category: dependencyCategoryFor(rootCauseClass),
        severity: failureCount >= threshold ? 'medium' : 'low',
        confidence: failureCount >= threshold ? 'high' : 'medium',
        lifecycle: 'observed',
        rootCauseClass,
        summary: `Queue planner fallback is active: ${reason}.`,
        operatorAction: 'Inspect queue-health diagnostics and dependency planner inputs; fallback is acceptable briefly but should not persist.',
        evidence: [{
          type: 'backstage_health',
          source: queueHealthPath,
          timestamp: stringField(queueHealth.lastAttemptAt) ?? stringField(queueHealth.updatedAt) ?? timestamp,
          redactedData: redactIncidentData(`reason=${reason} diagnostic=${diagnostic} failureCount=${failureCount}`),
          key: 'queue_planner_fallback',
        }],
        metadata: { threshold, failureCount, diagnosticReason: diagnostic },
      }));
    }

    const backstageHealthPath = join(repoDir, '.wavemill', 'backstage-health.json');
    const backstageHealth = readObjectFile(backstageHealthPath);
    const services = objectField(backstageHealth?.services);
    if (services) {
      for (const [serviceName, service] of Object.entries(services)) {
        const detail = `${stringField(service.detail) ?? ''} ${stringField(service.lastError) ?? ''}`;
        const failureCount = numberField(service.failureCount) ?? numberField(service.restartAttemptCount) ?? 0;
        if (failureCount < threshold || !/\b(remote|ssh|github|dependency|probe)\b/i.test(detail)) continue;
        const serviceRootCause = canonicalizeRootCauseClass(detail);
        const serviceRemote = isRemoteRootCauseClass(serviceRootCause);
        incidents.push(createIncidentDraft({
          taskId: null,
          session: context.session ?? null,
          category: dependencyCategoryFor(serviceRootCause),
          severity: 'medium',
          confidence: 'high',
          lifecycle: 'observed',
          rootCauseClass: serviceRootCause,
          summary: serviceRemote
            ? `${serviceName} dependency health is degraded by repeated probe failures.`
            : `${serviceName} health is degraded by repeated local failures (${serviceRootCause}).`,
          operatorAction: 'Check the external dependency and credentials before treating this as a Wavemill product defect.',
          evidence: [{
            type: 'backstage_health',
            source: backstageHealthPath,
            timestamp: stringField(service.updatedAt) ?? timestamp,
            redactedData: redactIncidentData(`service=${serviceName} failureCount=${failureCount} detail=${detail}`),
            key: 'degraded_dependency_health',
          }],
          metadata: { threshold, failureCount, serviceName },
        }));
      }
    }

    return incidents;
  }
}

export function detectIncidentsForTask(taskPath: string, taskId: string, context: DetectorContext, dependencyThreshold = 3): IncidentRecord[] {
  return [
    ...new PlanningFailureDetector().detect(taskPath, taskId, context),
    ...new WorkflowStateDetector().detect(taskPath, taskId, context),
    ...new DependencyHealthDetector({ thresholdConsecutiveFailures: dependencyThreshold }).detectTask(context.repoDir, taskId, context),
  ];
}

export function detectIncidentsForRepo(repoDir: string, context: DetectorContext, dependencyThreshold = 3): IncidentRecord[] {
  return [
    ...new JobFailureDetector().detect(repoDir, null, context),
    ...new DependencyHealthDetector({ thresholdConsecutiveFailures: dependencyThreshold }).detectRepo(repoDir, context),
  ];
}

function normalizePlanningReason(reason: string): string {
  if (reason === 'invalid_or_empty_final_plan') return 'invalid_plan';
  if (reason === 'empty_plan') return 'empty_final_plan';
  return reason.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
}

/**
 * Category routing for classified dependency signals. Only affirmatively
 * remote failures stay external; auth/credential probes are operator-owned
 * configuration, and everything else is a local harness/config condition.
 */
function dependencyCategoryFor(rootCauseClass: IncidentRootCauseClass): IncidentCategory {
  if (rootCauseClass === 'remote_auth_failure'
    || rootCauseClass === 'local_parse_failure'
    || rootCauseClass === 'local_config_failure'
    || rootCauseClass === 'queue_planner_degraded') {
    return 'configuration_operator_condition';
  }
  if (isRemoteRootCauseClass(rootCauseClass)) return 'external_transient_dependency';
  return 'model_task_harness_outcome';
}

function safeMtimeIso(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function resolveTaskPath(taskPath: string, candidate: string): string {
  return candidate.startsWith('/') ? candidate : join(taskPath, candidate);
}

function readObjectFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return objectField(parsed);
  } catch {
    return null;
  }
}

function taskEntry(workflowState: Record<string, unknown>, taskId: string): Record<string, unknown> | null {
  const tasks = objectField(workflowState.tasks);
  return objectField(tasks?.[taskId]);
}

type JobStateWithSource = JobStateDiagnostic & { source: string };

function jobSubjectTaskId(job: JobStateWithSource): string | null {
  const candidates = job.kind === 'comparison'
    ? [job.pairId, job.id, job.issueId, job.resultPath, job.logPath, job.source]
    : [job.issueId, job.id, job.pairId, job.resultPath, job.logPath, job.source];
  for (const candidate of candidates) {
    const issueId = extractIssueId(candidate);
    if (issueId) return issueId;
  }
  return null;
}

function extractIssueId(value: string | undefined): string | null {
  const match = value?.match(/\b[A-Z]+-\d+(?:_c)?\b/);
  return match?.[0] ?? null;
}

function readJobs(repoDir: string): JobStateWithSource[] {
  const jobs: JobStateWithSource[] = [];
  const jobsDir = join(repoDir, '.wavemill', 'jobs');
  for (const fileName of safeReaddir(jobsDir).filter((name) => name.endsWith('.json'))) {
    const source = join(jobsDir, fileName);
    const job = readJobState(source);
    if (job) jobs.push({ ...job, source });
  }

  const workflowStatePath = join(repoDir, '.wavemill', 'workflow-state.json');
  const workflowState = readObjectFile(workflowStatePath);
  const rawJobs = workflowState?.jobs;
  const entries = Array.isArray(rawJobs) ? rawJobs : Object.values(objectField(rawJobs) ?? {});
  for (const entry of entries) {
    const job = objectField(entry);
    if (!job) continue;
    jobs.push({
      id: stringField(job.id),
      kind: stringEnum(job.kind, ['eval', 'comparison']),
      status: stringEnum(job.status, ['running', 'succeeded', 'failed', 'timeout']),
      issueId: stringField(job.issueId),
      startedAt: stringField(job.startedAt),
      finishedAt: stringField(job.finishedAt),
      exitCode: numberField(job.exitCode),
      reason: stringField(job.reason),
      error: stringField(job.error) ?? stringField(job.excerpt),
      resultPath: stringField(job.resultPath),
      logPath: stringField(job.logPath),
      pairId: stringField(job.pairId),
      source: workflowStatePath,
    });
  }
  return jobs;
}

function diagnosticReason(queueHealth: Record<string, unknown>): string | null {
  const diagnostics = objectField(queueHealth.diagnostics);
  return stringField(diagnostics?.structuredReason)
    ?? stringField(diagnostics?.reason)
    ?? stringField(diagnostics?.stderrExcerpt)
    ?? stringField(queueHealth.underlyingReason);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function objectField(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : undefined;
}
