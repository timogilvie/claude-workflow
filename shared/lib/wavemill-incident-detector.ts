import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diagnoseArtifacts } from './artifact-diagnostics.ts';
import { normalizeJobs, type MillJob, type WorkflowStateLike } from './job-tracker.ts';
import { readStageResult } from './stage-result.ts';
import {
  classifyDependencyFailure,
  classifyPlanningFailure,
  classifyStaleOrphaned,
  redactIncidentText,
} from './wavemill-incident-classifier.ts';
import type { IncidentEvidence, WavemillIncident } from './wavemill-incident-model.ts';

export interface DetectorOptions {
  repoDir?: string;
  session?: string;
  featureDirs?: string[];
  skipDependencyProbes?: boolean;
  timeWindowMinutes?: number;
  now?: Date;
}

interface FeatureIdentity {
  featureDir: string;
  issue?: string;
  slug?: string;
  worktree?: string;
}

type JsonReadResult<T> =
  | { status: 'missing' }
  | { status: 'malformed'; reason: string }
  | { status: 'ok'; value: T };

function readJsonTolerant<T>(path: string): JsonReadResult<T> {
  if (!existsSync(path)) return { status: 'missing' };
  try {
    return { status: 'ok', value: JSON.parse(readFileSync(path, 'utf-8')) as T };
  } catch (error) {
    return { status: 'malformed', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function detectIncidents(opts: DetectorOptions = {}): Promise<WavemillIncident[]> {
  const repoDir = resolve(opts.repoDir ?? process.cwd());
  const observedAt = (opts.now ?? new Date()).toISOString();
  const incidents: WavemillIncident[] = [];
  const workflowState = readWorkflowState(repoDir);
  const features = enumerateFeatureDirs(repoDir, workflowState.status === 'ok' ? workflowState.value : undefined, opts.featureDirs);

  for (const feature of features) {
    incidents.push(...await detectPlanningFailures(feature, repoDir, opts.session, observedAt));
    incidents.push(...detectArtifactCoverage(feature, repoDir, opts.session, observedAt));
  }

  if (workflowState.status === 'ok') {
    incidents.push(...detectJobFailures(repoDir, workflowState.value, opts.session, observedAt));
  } else if (workflowState.status === 'malformed') {
    incidents.push(...coverageIncident(repoDir, '.wavemill/workflow-state.json', workflowState.reason, opts.session, observedAt));
  }

  if (!opts.skipDependencyProbes) {
    incidents.push(...detectDependencyFailures(repoDir, opts.session, opts.timeWindowMinutes ?? 60, observedAt));
  }

  return dedupeIncidents(incidents);
}

export async function detectPlanningFailures(feature: FeatureIdentity, repoDir: string, session?: string, observedAt = new Date().toISOString()): Promise<WavemillIncident[]> {
  const result = await readStageResult(feature.featureDir, 'planning');
  const incident = result ? classifyPlanningFailure(result, feature.featureDir, {
    observedAt,
    issue: feature.issue,
    session,
    repoDir,
  }) : null;
  return incident ? [incident] : [];
}

export function detectJobFailures(repoDir: string, workflowState: WorkflowStateLike, session?: string, observedAt = new Date().toISOString()): WavemillIncident[] {
  const incidents: WavemillIncident[] = [];
  const jobs = normalizeJobs(workflowState);
  for (const job of Object.values(jobs)) {
    if (job.status === 'running') {
      incidents.push(...detectStaleRunningJob(job, repoDir, session, observedAt));
      continue;
    }
    if (job.kind !== 'comparison' || !['failed', 'timeout'].includes(job.status)) continue;
    const structuredReason = `${job.reason ?? ''} ${job.excerpt ?? ''}`.toLowerCase();
    if (!/missing[_ -]?eval|eval record|no_result_file|invalid_result_file/.test(structuredReason)) continue;
    const evidence: IncidentEvidence[] = [{
      evidenceType: 'job_state',
      timestamp: observedAt,
      path: join(repoDir, '.wavemill', 'workflow-state.json'),
      description: 'Comparison job failed with missing eval-record evidence',
      value: {
        id: job.id,
        kind: job.kind,
        status: job.status,
        reason: redactIncidentText(job.reason ?? 'unknown', 120),
        pairId: job.pairId,
        prNumbers: job.prNumbers,
      },
    }];
    if (job.resultPath) {
      evidence.push({
        evidenceType: 'job_result',
        timestamp: observedAt,
        path: job.resultPath,
        description: 'Comparison job result artifact',
        value: readBoundedJobResult(job.resultPath),
      });
    }
    incidents.push(...maybeIncident(classifyStaleOrphaned('missing_eval_records', evidence, {
      observedAt,
      issue: job.issueId,
      session,
      repoDir,
    })));
  }
  return incidents;
}

function detectStaleRunningJob(job: MillJob, repoDir: string, session: string | undefined, observedAt: string): WavemillIncident[] {
  const startedAt = Date.parse(job.startedAt);
  if (!Number.isFinite(startedAt) || Date.parse(observedAt) - startedAt < 24 * 60 * 60 * 1000) return [];
  return maybeIncident(classifyStaleOrphaned('orphaned_job', [{
    evidenceType: 'job_state',
    timestamp: observedAt,
    path: join(repoDir, '.wavemill', 'workflow-state.json'),
    description: 'Running job is older than 24h and has no terminal state',
    value: {
      id: job.id,
      kind: job.kind,
      startedAt: job.startedAt,
      status: job.status,
      resultPath: job.resultPath,
    },
  }], { observedAt, issue: job.issueId, session, repoDir }));
}

export function detectDependencyFailures(repoDir: string, session?: string, timeWindowMinutes = 60, observedAt = new Date().toISOString()): WavemillIncident[] {
  const queueHealthPath = join(repoDir, '.wavemill', 'queue-health.json');
  const read = readJsonTolerant<Record<string, any>>(queueHealthPath);
  if (read.status === 'malformed') {
    return coverageIncident(repoDir, '.wavemill/queue-health.json', read.reason, session, observedAt);
  }
  if (read.status !== 'ok') return [];
  const health = read.value;
  if (health.status !== 'degraded' && !health.degradationReason && !health.diagnostics) return [];
  const diagnostics = health.diagnostics ?? {};
  const structuredReason = stringValue(diagnostics.structuredReason)
    ?? stringValue(diagnostics.reason)
    ?? stringValue(health.underlyingDiagnosticReason)
    ?? stringValue(health.degradationReason)
    ?? 'dependency_planning_failed';
  const failureKind = dependencyKind(structuredReason, stringValue(diagnostics.stderrExcerpt));
  return maybeIncident(classifyDependencyFailure({
    observedAt,
    session,
    repoDir,
    failureKind,
    structuredReason,
    failureCount: numericValue(health.failureCount) ?? 1,
    timeWindowMinutes,
    evidencePath: queueHealthPath,
    errorSummary: stringValue(diagnostics.stderrExcerpt) ?? stringValue(health.degradationReason) ?? structuredReason,
  }));
}

function detectArtifactCoverage(feature: FeatureIdentity, repoDir: string, session: string | undefined, observedAt: string): WavemillIncident[] {
  const report = diagnoseArtifacts({ repoDir, featureDir: feature.featureDir, taskId: feature.issue, slug: feature.slug });
  const malformed = report.findings.filter((finding) => finding.code === 'malformed' || finding.code === 'coverage_gap');
  return malformed.flatMap((finding) => coverageIncident(
    repoDir,
    finding.file ?? feature.featureDir,
    finding.reason ?? finding.message,
    session,
    observedAt,
    feature.issue,
  ));
}

function coverageIncident(repoDir: string, path: string, reason: string, session: string | undefined, observedAt: string, issue?: string): WavemillIncident[] {
  return maybeIncident(classifyStaleOrphaned('artifact_coverage_gap', [{
    evidenceType: 'coverage_gap',
    timestamp: observedAt,
    path: path.startsWith('/') ? path : join(repoDir, path),
    description: 'Artifact could not be used for incident detection',
    value: { reason: redactIncidentText(reason, 160) },
  }], { observedAt, issue, session, repoDir }));
}

function readWorkflowState(repoDir: string): JsonReadResult<WorkflowStateLike> {
  return readJsonTolerant<WorkflowStateLike>(join(repoDir, '.wavemill', 'workflow-state.json'));
}

function enumerateFeatureDirs(repoDir: string, workflowState?: WorkflowStateLike, explicit?: string[]): FeatureIdentity[] {
  const features = new Map<string, FeatureIdentity>();
  for (const dir of explicit ?? []) {
    features.set(resolve(dir), { featureDir: resolve(dir) });
  }
  const tasks = workflowState?.tasks ?? {};
  for (const [issue, task] of Object.entries(tasks)) {
    const slug = stringValue(task.slug);
    const worktree = stringValue(task.worktree);
    const directFeatureDir = stringValue(task.featureDir);
    const featureDir = directFeatureDir
      ? resolve(directFeatureDir)
      : worktree && slug
        ? join(worktree, 'features', slug)
        : slug
          ? join(repoDir, 'features', slug)
          : undefined;
    if (featureDir && existsSync(featureDir)) {
      features.set(featureDir, { featureDir, issue, slug, worktree });
    }
  }
  const featuresDir = join(repoDir, 'features');
  if (existsSync(featuresDir)) {
    for (const entry of safeReaddir(featuresDir)) {
      const featureDir = join(featuresDir, entry);
      try {
        if (statSync(featureDir).isDirectory()) {
          features.set(featureDir, features.get(featureDir) ?? { featureDir, slug: entry });
        }
      } catch {
        // Ignore unreadable feature entries in the read-only observer.
      }
    }
  }
  return [...features.values()];
}

function readBoundedJobResult(resultPath: string): Record<string, unknown> {
  const read = readJsonTolerant<Record<string, unknown>>(resultPath);
  if (read.status !== 'ok') return { status: read.status, reason: read.status === 'malformed' ? read.reason : undefined };
  const result = read.value;
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    persisted: result.persisted,
    reason: redactIncidentText(String(result.reason ?? result.error ?? ''), 160),
  };
}

function dependencyKind(reason: string, excerpt?: string): string {
  const combined = `${reason} ${excerpt ?? ''}`.toLowerCase();
  if (/ls-remote|ssh|permission denied|publickey/.test(combined)) return 'git_ssh';
  if (/rate.?limit|429/.test(combined)) return 'github_rate_limit';
  if (/linear/.test(combined)) return 'linear_api';
  if (/queue|dependency.*plan/.test(combined)) return 'dependency_planning_failed';
  return reason.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'remote_probe_failed';
}

function dedupeIncidents(incidents: WavemillIncident[]): WavemillIncident[] {
  const byFingerprint = new Map<string, WavemillIncident>();
  for (const incident of incidents) {
    const existing = byFingerprint.get(incident.fingerprint);
    if (!existing) {
      byFingerprint.set(incident.fingerprint, incident);
      continue;
    }
    byFingerprint.set(incident.fingerprint, {
      ...existing,
      evidence: [...existing.evidence, ...incident.evidence],
      occurrenceCount: existing.occurrenceCount + incident.occurrenceCount,
      escalated: existing.escalated || incident.escalated,
      severity: severityRank(incident.severity) > severityRank(existing.severity) ? incident.severity : existing.severity,
      lastObserved: incident.lastObserved > existing.lastObserved ? incident.lastObserved : existing.lastObserved,
    });
  }
  return [...byFingerprint.values()];
}

function maybeIncident(incident: WavemillIncident | null): WavemillIncident[] {
  return incident ? [incident] : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function severityRank(value: WavemillIncident['severity']): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[value];
}
