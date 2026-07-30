import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ChallengeEvalStage,
  ChallengeStageEval,
  ChallengeStageEvidenceItem,
  EvalExecutedPlanning,
  EvalPhaseDurations,
  EvalRecord,
  EvalRouting,
  RoutePrediction,
  RoutingDecision,
} from './eval-schema.ts';

const MAX_SNIPPET_CHARS = 320;

interface GatheredStageArtifactsLike {
  planContent?: string;
  selfReviewSummary?: string;
  routingDecision?: RoutingDecision;
  routing?: EvalRouting;
  routePrediction?: RoutePrediction;
  executedPlanning?: EvalExecutedPlanning;
  phaseDurations?: EvalPhaseDurations;
}

export interface BuildChallengeStageEvalInput {
  repoDir: string;
  issueId?: string;
  branchName?: string;
  worktreePath?: string;
  challengeStage?: 'plan' | 'implementation' | 'review';
  record: EvalRecord;
  stageArtifacts: GatheredStageArtifactsLike;
}

type StageResultShape = {
  status?: string;
  agent?: string;
  model?: string;
  notes?: string;
  executionOutcome?: {
    status?: string;
    failureReason?: string;
    artifactStatus?: {
      produced?: unknown;
      valid?: unknown;
      approvalReady?: unknown;
    };
    metrics?: {
      completedTurns?: unknown;
      executedToolCalls?: unknown;
      wallClockMs?: unknown;
    };
  };
  artifacts?: {
    type?: string;
    findingsCount?: unknown;
    blockingIssues?: unknown;
    prNumber?: unknown;
    prUrl?: unknown;
  };
};

function truncate(value: string | undefined, maxChars: number = MAX_SNIPPET_CHARS): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function addEvidence(
  evidence: ChallengeStageEvidenceItem[],
  label: string,
  summary: string | undefined,
  source?: string,
): void {
  const trimmed = truncate(summary);
  if (!trimmed) return;
  evidence.push(source ? { label, summary: trimmed, source } : { label, summary: trimmed });
}

function deriveSlug(branchName: string | undefined, worktreePath: string | undefined): string | undefined {
  const fromBranch = branchName?.replace(/^(task|bug)\//, '').trim();
  if (fromBranch) {
    return fromBranch;
  }
  const base = worktreePath ? path.basename(worktreePath).trim() : '';
  return base || undefined;
}

function readStageResult(
  repoDir: string,
  issueId: string | undefined,
  slug: string | undefined,
  worktreePath: string | undefined,
  stage: 'planning' | 'review',
): StageResultShape | null | undefined {
  const fileName = `.${stage}-result.json`;
  const archiveName = `${stage}-result.json`;
  const candidates: string[] = [];

  if (slug) {
    for (const root of [worktreePath, repoDir]) {
      if (!root) continue;
      for (const dir of ['features', 'bugs']) {
        candidates.push(path.join(root, dir, slug, fileName));
      }
    }
  }

  if (issueId) {
    candidates.push(path.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId, fileName));
    candidates.push(path.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId, archiveName));
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as StageResultShape;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  return undefined;
}

function summarizePlanningResult(result: StageResultShape | null | undefined): string | undefined {
  if (!result) return undefined;
  const outcome = result.executionOutcome;
  const artifact = outcome?.artifactStatus;
  const metrics = outcome?.metrics;
  const parts = [
    result.status ? `status=${result.status}` : '',
    result.model ? `model=${result.model}` : '',
    result.agent ? `agent=${result.agent}` : '',
    outcome?.status ? `outcome=${outcome.status}` : '',
    outcome?.failureReason ? `reason=${outcome.failureReason}` : '',
    typeof artifact?.approvalReady === 'boolean' ? `approvalReady=${artifact.approvalReady}` : '',
    typeof artifact?.valid === 'boolean' ? `artifactValid=${artifact.valid}` : '',
    typeof metrics?.completedTurns === 'number' ? `turns=${metrics.completedTurns}` : '',
    typeof metrics?.executedToolCalls === 'number' ? `toolCalls=${metrics.executedToolCalls}` : '',
    typeof metrics?.wallClockMs === 'number' ? `wallClockMs=${metrics.wallClockMs}` : '',
    truncate(result.notes, 120) ? `notes=${truncate(result.notes, 120)}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

function summarizeReviewResult(result: StageResultShape | null | undefined): string | undefined {
  if (!result) return undefined;
  const findings = typeof result.artifacts?.findingsCount === 'number'
    ? `findings=${result.artifacts.findingsCount}`
    : '';
  const blockers = typeof result.artifacts?.blockingIssues === 'number'
    ? `blocking=${result.artifacts.blockingIssues}`
    : '';
  const parts = [
    result.status ? `status=${result.status}` : '',
    result.model ? `model=${result.model}` : '',
    findings,
    blockers,
    truncate(result.notes, 120) ? `notes=${truncate(result.notes, 120)}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

function summarizeRouting(stageArtifacts: GatheredStageArtifactsLike): string | undefined {
  const planner = stageArtifacts.routing?.planner?.resolvedModelId;
  const coder = stageArtifacts.routing?.coder?.resolvedModelId;
  const reviewer = stageArtifacts.routing?.reviewer?.resolvedModelId;
  const routeMode = stageArtifacts.routingDecision?.routeMode;
  const parts = [
    planner ? `planner=${planner}` : '',
    coder ? `coder=${coder}` : '',
    reviewer ? `reviewer=${reviewer}` : '',
    routeMode ? `routeMode=${routeMode}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function summarizePlanCritique(record: EvalRecord): string | undefined {
  const critique = record.metadata?.planCritique as Record<string, { score?: number }> | undefined;
  if (!critique) return undefined;
  const parts = [
    typeof critique.component_boundaries?.score === 'number' ? `boundaries=${critique.component_boundaries.score.toFixed(2)}` : '',
    typeof critique.invariant_coverage?.score === 'number' ? `invariants=${critique.invariant_coverage.score.toFixed(2)}` : '',
    typeof critique.approach_soundness?.score === 'number' ? `approach=${critique.approach_soundness.score.toFixed(2)}` : '',
    typeof critique.missed_patches?.score === 'number' ? `patches=${critique.missed_patches.score.toFixed(2)}` : '',
    typeof critique.overall?.score === 'number' ? `overall=${critique.overall.score.toFixed(2)}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function summarizeStageScore(record: EvalRecord, stage: ChallengeEvalStage): string | undefined {
  const stageScore = record.metadata?.stageScores?.[stage] as { score?: number; rationale?: string } | undefined;
  if (!stageScore) return undefined;
  const parts = [
    typeof stageScore.score === 'number' ? `score=${stageScore.score.toFixed(2)}` : '',
    truncate(stageScore.rationale, 160) ? `rationale=${truncate(stageScore.rationale, 160)}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

function summarizeReviewOutcome(record: EvalRecord): string | undefined {
  const review = record.outcomes?.review;
  if (!review) return undefined;
  return [
    `rounds=${review.rounds}`,
    `approvals=${review.approvals}`,
    `changeRequests=${review.changeRequests}`,
    typeof review.selfReviewBlockers === 'number' ? `selfReviewBlockers=${review.selfReviewBlockers}` : '',
    typeof review.selfReviewWarnings === 'number' ? `selfReviewWarnings=${review.selfReviewWarnings}` : '',
  ].filter(Boolean).join(', ');
}

function summarizeInterventions(record: EvalRecord): string | undefined {
  const interventions = record.interventions || [];
  if (interventions.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const intervention of interventions) {
    counts.set(intervention.type, (counts.get(intervention.type) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => `${type}=${count}`)
    .join(', ');
}

function directFallbackReason(parts: string[]): string {
  return `Missing ${parts.join(' and ')}`;
}

function buildPlannerStageEval(
  input: BuildChallengeStageEvalInput,
  slug: string | undefined,
): ChallengeStageEval {
  const evidence: ChallengeStageEvidenceItem[] = [];
  const planningResult = readStageResult(input.repoDir, input.issueId, slug, input.worktreePath, 'planning');
  const planContent = truncate(input.stageArtifacts.planContent);

  addEvidence(evidence, 'plan_text', planContent, 'plan.md');
  addEvidence(evidence, 'planning_result', summarizePlanningResult(planningResult), '.planning-result.json');
  addEvidence(evidence, 'routing', summarizeRouting(input.stageArtifacts), '.routing-complete');
  addEvidence(evidence, 'plan_critique', summarizePlanCritique(input.record), 'judge.planCritique');
  addEvidence(evidence, 'interventions', summarizeInterventions(input.record), 'interventions');
  if (input.stageArtifacts.executedPlanning) {
    addEvidence(
      evidence,
      'executed_planning',
      [
        input.stageArtifacts.executedPlanning.status ? `status=${input.stageArtifacts.executedPlanning.status}` : '',
        input.stageArtifacts.executedPlanning.model ? `model=${input.stageArtifacts.executedPlanning.model}` : '',
        input.stageArtifacts.executedPlanning.agent ? `agent=${input.stageArtifacts.executedPlanning.agent}` : '',
        input.stageArtifacts.executedPlanning.executionOutcome?.status
          ? `outcome=${input.stageArtifacts.executedPlanning.executionOutcome.status}`
          : '',
        input.stageArtifacts.executedPlanning.executionOutcome?.failureReason
          ? `reason=${input.stageArtifacts.executedPlanning.executionOutcome.failureReason}`
          : '',
        typeof input.stageArtifacts.executedPlanning.executionOutcome?.artifactStatus.approvalReady === 'boolean'
          ? `approvalReady=${input.stageArtifacts.executedPlanning.executionOutcome.artifactStatus.approvalReady}`
          : '',
      ].filter(Boolean).join(', '),
      input.stageArtifacts.executedPlanning.source,
    );
  }

  const missing: string[] = [];
  if (!planContent) missing.push('plan.md');
  if (!planningResult) missing.push('.planning-result.json');

  if (missing.length === 0) {
    return {
      stage: 'plan',
      provenance: 'direct',
      summary: 'Direct planning evidence captured from plan text and planning result artifacts.',
      evidence,
    };
  }

  addEvidence(evidence, 'inferred_plan_score', summarizeStageScore(input.record, 'plan'), 'metadata.stageScores.plan');

  return {
    stage: 'plan',
    provenance: 'inferred',
    summary: 'Planning comparison fell back to inferred evidence because direct planning artifacts were incomplete.',
    fallbackReason: directFallbackReason(missing),
    evidence,
  };
}

function buildReviewerStageEval(
  input: BuildChallengeStageEvalInput,
  slug: string | undefined,
): ChallengeStageEval {
  const evidence: ChallengeStageEvidenceItem[] = [];
  const reviewResult = readStageResult(input.repoDir, input.issueId, slug, input.worktreePath, 'review');
  const selfReviewSummary = truncate(input.stageArtifacts.selfReviewSummary);

  addEvidence(evidence, 'self_review_summary', selfReviewSummary, 'review-log');
  addEvidence(evidence, 'review_result', summarizeReviewResult(reviewResult), '.review-result.json');
  addEvidence(evidence, 'review_outcome', summarizeReviewOutcome(input.record), 'outcomes.review');
  addEvidence(evidence, 'interventions', summarizeInterventions(input.record), 'interventions');
  if (input.stageArtifacts.phaseDurations?.review !== undefined) {
    addEvidence(
      evidence,
      'review_duration',
      `reviewSeconds=${input.stageArtifacts.phaseDurations.review}`,
      '.review-result.json',
    );
  }

  const missing: string[] = [];
  if (!selfReviewSummary) missing.push('self-review summary');
  if (!reviewResult) missing.push('.review-result.json');

  if (missing.length === 0) {
    return {
      stage: 'review',
      provenance: 'direct',
      summary: 'Direct review evidence captured from self-review output and review result artifacts.',
      evidence,
    };
  }

  addEvidence(evidence, 'inferred_review_score', summarizeStageScore(input.record, 'review'), 'metadata.stageScores.review');

  return {
    stage: 'review',
    provenance: 'inferred',
    summary: 'Review comparison fell back to inferred evidence because direct review artifacts were incomplete.',
    fallbackReason: directFallbackReason(missing),
    evidence,
  };
}

export function buildChallengeStageEval(input: BuildChallengeStageEvalInput): ChallengeStageEval | undefined {
  if (input.challengeStage !== 'plan' && input.challengeStage !== 'review') {
    return undefined;
  }

  const slug = deriveSlug(input.branchName, input.worktreePath);
  return input.challengeStage === 'plan'
    ? buildPlannerStageEval(input, slug)
    : buildReviewerStageEval(input, slug);
}
