import { basename, join } from 'node:path';
import type { StageResult } from './stage-result.ts';
import { redactText } from './text-redaction.ts';
import {
  createIncident,
  type IncidentEvidence,
  type IncidentSeverity,
  type WavemillIncident,
} from './wavemill-incident-model.ts';

interface IncidentContext {
  observedAt?: string;
  issue?: string;
  session?: string;
  repoDir?: string;
}

export interface DependencyFailureInput extends IncidentContext {
  failureKind: string;
  failureCount: number;
  timeWindowMinutes: number;
  errorSummary?: string;
  evidencePath?: string;
  structuredReason?: string;
}

export function redactIncidentText(value: string, maxLength = 220): string {
  return redactText(value)
    .replace(/(LINEAR_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY)=\S+/gi, '$1=[redacted]')
    .replace(/(api[_-]?key|token|secret|password)=\S+/gi, '$1=[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, '$1 [redacted]')
    .replace(/(prompt|transcript)=.+/gi, '$1=[redacted]')
    .slice(0, maxLength);
}

export function classifyPlanningFailure(result: StageResult, featureDir: string, context: IncidentContext = {}): WavemillIncident | null {
  if (result.status !== 'failed') return null;
  const reason = normalizeReason(result.failureReason || 'unknown');
  const artifacts = result.artifacts?.type === 'planning' ? result.artifacts : undefined;
  const usage = artifacts?.usage;
  const bounds = artifacts?.bounds;
  const hasPlan = Boolean(artifacts?.planFile);
  const planValid = artifacts?.planArtifactValid === true;
  const stagePath = join(featureDir, '.planning-result.json');
  const usageText = formatUsage(reason, usage, bounds);
  const planState = planValid ? 'valid plan artifact' : hasPlan ? 'invalid plan artifact' : 'no plan artifact';
  const classification = planningClassification(reason);

  return createIncident({
    ...context,
    category: classification.category,
    severity: classification.severity,
    confidence: classification.confidence,
    normalizedRootCauseClass: `native_planning_${reason}`,
    observedAt: context.observedAt ?? result.finishedAt ?? result.startedAt,
    evidence: [{
      evidenceType: 'planning_result',
      timestamp: context.observedAt ?? result.finishedAt ?? result.startedAt,
      path: stagePath,
      description: `Native planning terminal reason: ${reason}`,
      value: {
        status: result.status,
        failureReason: reason,
        planner: result.agent,
        model: result.model,
        planArtifactValid: planValid,
        hasPlanArtifact: hasPlan,
        bounds,
        usage,
      },
    }],
    redactedSummary: `Planning failed with ${reason}; planner=${result.agent || 'unknown'} model=${result.model || 'unknown'}; ${usageText}; ${planState}.`,
    recommendedAction: planningAction(reason),
  });
}

function planningClassification(reason: string): { category: WavemillIncident['category']; severity: IncidentSeverity; confidence: WavemillIncident['confidence'] } {
  switch (reason) {
    case 'turn_limit':
    case 'tool_call_limit':
    case 'wall_clock_limit':
      return { category: 'model_task_harness_outcome', severity: 'high', confidence: 'high' };
    case 'tool_stagnation':
      return { category: 'model_task_harness_outcome', severity: 'medium', confidence: 'medium' };
    case 'provider_error':
      return { category: 'external_transient_dependency', severity: 'high', confidence: 'high' };
    case 'aborted':
      return { category: 'configuration_operator', severity: 'medium', confidence: 'high' };
    case 'invalid_artifact':
    case 'empty_final_plan':
      return { category: 'model_task_harness_outcome', severity: 'high', confidence: 'high' };
    default:
      return { category: 'model_task_harness_outcome', severity: 'medium', confidence: 'medium' };
  }
}

function planningAction(reason: string): string {
  switch (reason) {
    case 'turn_limit':
    case 'tool_call_limit':
    case 'wall_clock_limit':
      return 'Review task scope and native planning bounds; rerun planning only after confirming the task packet is appropriately sized.';
    case 'provider_error':
      return 'Check provider and network health before retrying the same planning stage.';
    case 'aborted':
      return 'Confirm whether an operator intentionally aborted the stage before retrying.';
    case 'invalid_artifact':
    case 'empty_final_plan':
      return 'Inspect the final plan artifact validation result and tighten the planner output contract if repeated.';
    default:
      return 'Inspect the structured planning result and decide whether this is task-local or harness behavior.';
  }
}

function formatUsage(reason: string, usage: Record<string, unknown> | undefined, bounds: Record<string, unknown> | undefined): string {
  if (reason === 'turn_limit' && usage?.turnsCompleted !== undefined && bounds?.maxTurns !== undefined) {
    return `turns=${usage.turnsCompleted}/${bounds.maxTurns}`;
  }
  if (reason === 'tool_call_limit' && usage?.toolCallsExecuted !== undefined && bounds?.maxToolCalls !== undefined) {
    return `toolCalls=${usage.toolCallsExecuted}/${bounds.maxToolCalls}`;
  }
  if (reason === 'wall_clock_limit' && usage?.wallClockMs !== undefined && bounds?.maxWallClockMs !== undefined) {
    return `wallClockMs=${usage.wallClockMs}/${bounds.maxWallClockMs}`;
  }
  return 'execution usage unavailable';
}

export function classifyDependencyFailure(input: DependencyFailureInput): WavemillIncident | null {
  if (input.failureCount <= 0) return null;
  const escalated = input.failureCount >= 3;
  const kind = normalizeReason(input.failureKind || 'remote_probe_failed');
  const structuredReason = normalizeReason(input.structuredReason || kind);
  const summary = redactIncidentText(input.errorSummary || kind, 200);
  return createIncident({
    ...input,
    category: 'external_transient_dependency',
    severity: escalated ? 'high' : 'low',
    confidence: 'high',
    normalizedRootCauseClass: `dependency_${kind}`,
    escalated,
    evidence: [{
      evidenceType: 'dependency_probe',
      timestamp: input.observedAt ?? new Date().toISOString(),
      path: input.evidencePath,
      description: `${input.failureCount} ${kind} failure(s) within ${input.timeWindowMinutes}m`,
      value: {
        failureKind: kind,
        structuredReason,
        failureCount: input.failureCount,
        timeWindowMinutes: input.timeWindowMinutes,
        escalated,
        errorSummary: summary,
      },
    }],
    redactedSummary: escalated
      ? `Repeated dependency probe failures (${kind}) across ${input.failureCount} observations: ${summary}`
      : `Observed one non-escalated dependency probe failure (${kind}): ${summary}`,
    recommendedAction: escalated
      ? 'Check remote service, SSH credentials, and provider rate limits before treating this as a Wavemill product defect.'
      : 'Observe for recurrence; do not escalate a single transient remote failure as a product defect.',
  });
}

export function classifyStaleOrphaned(observationKind: string, evidence: IncidentEvidence[], context: IncidentContext = {}): WavemillIncident | null {
  if (evidence.length === 0) return null;
  const kind = normalizeReason(observationKind);
  const severity: IncidentSeverity = kind === 'missing_eval_records' || kind === 'stale_comparison' ? 'high' : 'medium';
  return createIncident({
    ...context,
    category: 'stale_orphaned_state',
    severity,
    confidence: kind === 'orphaned_job' ? 'medium' : 'high',
    normalizedRootCauseClass: kind,
    evidence,
    redactedSummary: `${kind.replace(/_/g, ' ')} detected from ${evidence.map((item) => basename(item.path ?? item.evidenceType)).join(', ')}.`,
    recommendedAction: 'Reconcile job state with eval evidence before rerunning or closing the workflow.',
  });
}

export function classifyConfigurationIssue(configKind: string, evidence: IncidentEvidence[], context: IncidentContext = {}): WavemillIncident | null {
  if (evidence.length === 0) return null;
  const kind = normalizeReason(configKind);
  return createIncident({
    ...context,
    category: 'configuration_operator',
    severity: 'medium',
    confidence: 'high',
    normalizedRootCauseClass: kind,
    evidence,
    redactedSummary: `Configuration/operator condition detected: ${kind.replace(/_/g, ' ')}.`,
    recommendedAction: 'Correct the local configuration or confirm the operator action before retrying.',
  });
}

function normalizeReason(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (normalized === 'invalid_empty_final_plan' || normalized === 'empty_plan') return 'empty_final_plan';
  return normalized || 'unknown';
}
