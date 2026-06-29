import { createHash } from 'node:crypto';

import type { ReviewFinding, ReviewResult } from '../../review-engine.ts';
import type { StageStatus } from '../../stage-result.ts';
import {
  executeReviewChanges,
  executeWriteStageResult,
  type CommandToolsDeps,
} from './command-tools.ts';
import {
  githubAddLabel,
  githubCreatePr,
  type GitHubToolDeps,
} from './github.ts';
import {
  executeLinearComment,
  type LinearClient,
  type WorkflowToolStageArtifactEntry,
  type WorkflowToolTranscriptEvent,
} from './linear-tools.ts';
import type {
  GitHubAddLabelResult,
  GitHubCreatePrResult,
  GitHubLabelRef,
  GitHubPullRequestRef,
  LinearCommentResult,
  WorkflowPhase,
} from './contracts.ts';
import {
  createInMemoryDedupeRegistry,
  type DedupeRegistry,
} from './dedupe.ts';
import type { NetworkPolicy } from '../network-policy.ts';

export interface NormalizedReviewFinding {
  id: string;
  source: 'code' | 'ui';
  severity: ReviewFinding['severity'];
  location: string;
  category: string;
  description: string;
}

export interface ReviewFindingFixResult {
  ok: boolean;
  outcome: 'applied' | 'skipped' | 'denied' | 'failed';
  findingId?: string;
  filesChanged?: string[];
  message?: string;
}

export type ReviewFindingFixExecutor = (input: {
  finding: NormalizedReviewFinding;
  issueId: string;
  featureDir: string;
  repo: string;
  base: string;
  head: string;
  sessionId: string;
  phase: WorkflowPhase;
}) => Promise<ReviewFindingFixResult>;

export interface ReviewFlowOptions {
  issueId: string;
  featureDir: string;
  repo: string;
  base: string;
  head: string;
  headSha: string;
  title: string;
  body: string;
  labels?: string[];
  sessionId: string;
  phase?: WorkflowPhase;
  registry?: DedupeRegistry;
  transcript: { append(event: WorkflowToolTranscriptEvent): void };
  stageArtifact: { append(entry: WorkflowToolStageArtifactEntry): void };
  clock?: () => number;
  linearClient: LinearClient;
  githubDeps?: Partial<GitHubToolDeps>;
  networkPolicy?: NetworkPolicy;
  fixFindings?: ReviewFindingFixExecutor;
  reviewChangesImpl?: CommandToolsDeps['reviewChangesImpl'];
  readStageResultImpl?: CommandToolsDeps['readStageResultImpl'];
  writeStageResultImpl?: CommandToolsDeps['writeStageResultImpl'];
  updateStageResultImpl?: CommandToolsDeps['updateStageResultImpl'];
}

export interface ReviewFlowReviewSummary {
  status: 'completed' | 'failed';
  findings: string;
  findingCount: number;
  blockingCount: number;
  needsStrongerReviewer: boolean;
}

export interface ReviewFlowFixOutcome {
  findingId: string;
  outcome: ReviewFindingFixResult['outcome'];
  ok: boolean;
  message?: string;
  filesChanged?: string[];
}

export interface ReviewFlowFixSummary {
  attempted: number;
  applied: number;
  skipped: number;
  denied: number;
  failed: number;
  outcomes: ReviewFlowFixOutcome[];
}

export interface ReviewFlowResult {
  ok: boolean;
  review: ReviewFlowReviewSummary;
  fixes: ReviewFlowFixSummary;
  linearComment?: LinearCommentResult;
  pullRequest?: GitHubCreatePrResult;
  labels: Array<GitHubAddLabelResult>;
  stageResult?: Awaited<ReturnType<typeof executeWriteStageResult>>;
  haltedBeforeMerge: true;
  merged: false;
  warnings: string[];
}

const DEFAULT_PHASE: WorkflowPhase = 'review';

function now(clock?: () => number): number {
  return clock ? clock() : Date.now();
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function makeFixSummary(): ReviewFlowFixSummary {
  return {
    attempted: 0,
    applied: 0,
    skipped: 0,
    denied: 0,
    failed: 0,
    outcomes: [],
  };
}

function normalizeFinding(source: 'code' | 'ui', finding: ReviewFinding): NormalizedReviewFinding {
  const identity = `${source}\n${finding.severity}\n${finding.location}\n${finding.category}\n${finding.description}`;
  return {
    id: `review_finding:${shortHash(identity)}`,
    source,
    severity: finding.severity,
    location: finding.location,
    category: finding.category,
    description: finding.description,
  };
}

function extractFindings(review: ReviewResult): NormalizedReviewFinding[] {
  const code = review.codeReviewFindings.map((finding) => normalizeFinding('code', finding));
  const ui = (review.uiFindings ?? []).map((finding) => normalizeFinding('ui', finding));
  return [...code, ...ui];
}

function parseStructuredReview(findings: string): ReviewResult {
  const parsed = JSON.parse(findings) as Partial<ReviewResult>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.codeReviewFindings)) {
    throw new Error('review_changes returned malformed JSON review payload');
  }
  if (parsed.verdict !== 'ready' && parsed.verdict !== 'not_ready') {
    throw new Error('review_changes returned invalid review verdict');
  }
  return {
    verdict: parsed.verdict,
    codeReviewFindings: parsed.codeReviewFindings,
    uiFindings: Array.isArray(parsed.uiFindings) ? parsed.uiFindings : undefined,
    needsStrongerReviewer: parsed.needsStrongerReviewer === true,
    strongerReviewerReason: parsed.strongerReviewerReason,
    metadata: parsed.metadata,
  };
}

function buildLinearCommentBody(issueId: string, review: ReviewFlowReviewSummary, fixes: ReviewFlowFixSummary): string {
  const lines = [
    `Native review summary for ${issueId}`,
    ``,
    `- Findings: ${review.findingCount}`,
    `- Blocking findings: ${review.blockingCount}`,
    `- Needs stronger reviewer: ${review.needsStrongerReviewer ? 'yes' : 'no'}`,
    `- Fixes applied: ${fixes.applied}`,
    `- Fixes denied: ${fixes.denied}`,
    `- Fixes skipped: ${fixes.skipped}`,
    `- Fixes failed: ${fixes.failed}`,
    ``,
    'Structured review output:',
    '```json',
    review.findings,
    '```',
  ];
  return lines.join('\n');
}

function buildPrBody(baseBody: string, review: ReviewFlowReviewSummary, fixes: ReviewFlowFixSummary): string {
  const reviewSummary = [
    '## Native Review',
    '',
    `- Findings: ${review.findingCount}`,
    `- Blocking findings: ${review.blockingCount}`,
    `- Needs stronger reviewer: ${review.needsStrongerReviewer ? 'yes' : 'no'}`,
    `- Fixes applied: ${fixes.applied}`,
    `- Fixes denied: ${fixes.denied}`,
    `- Fixes skipped: ${fixes.skipped}`,
    `- Fixes failed: ${fixes.failed}`,
    '',
    '```json',
    review.findings,
    '```',
  ].join('\n');
  return `${baseBody.trim()}\n\n${reviewSummary}`.trim();
}

function buildStageArtifacts(input: {
  review: ReviewFlowReviewSummary;
  fixes: ReviewFlowFixSummary;
  linearComment?: LinearCommentResult;
  pullRequest?: GitHubCreatePrResult;
  labels: GitHubAddLabelResult[];
  warnings: string[];
}): Record<string, unknown> {
  return {
    review: {
      status: input.review.status,
      findingCount: input.review.findingCount,
      blockingCount: input.review.blockingCount,
      needsStrongerReviewer: input.review.needsStrongerReviewer,
    },
    fixes: input.fixes,
    linearComment: summarizeMutation(input.linearComment),
    pullRequest: summarizeMutation(input.pullRequest),
    labels: input.labels.map((label) => summarizeMutation(label)),
    haltedBeforeMerge: true,
    merged: false,
    warnings: input.warnings,
  };
}

function summarizeMutation(result: LinearCommentResult | GitHubCreatePrResult | GitHubAddLabelResult | undefined): Record<string, unknown> | null {
  if (!result) {
    return null;
  }
  if (result.ok) {
    return {
      ok: true,
      tool: result.tool,
      idempotency: result.idempotency,
    };
  }
  return {
    ok: false,
    tool: result.tool,
    error: result.error,
    message: result.message,
  };
}

function stageNotes(review: ReviewFlowReviewSummary, ok: boolean): string {
  if (!ok) {
    return `Native review flow failed after ${review.findingCount} findings`;
  }
  if (review.needsStrongerReviewer) {
    return 'Native review requested a stronger reviewer; merge remains halted';
  }
  return `Native review completed with ${review.findingCount} findings; merge remains halted`;
}

function createDeps(options: ReviewFlowOptions): CommandToolsDeps {
  return {
    registry: options.registry ?? createInMemoryDedupeRegistry({ clock: options.clock }),
    transcript: options.transcript,
    stageArtifact: options.stageArtifact,
    sessionId: options.sessionId,
    phase: options.phase ?? DEFAULT_PHASE,
    repoDir: options.featureDir,
    clock: options.clock,
    reviewChangesImpl: options.reviewChangesImpl,
    readStageResultImpl: options.readStageResultImpl,
    writeStageResultImpl: options.writeStageResultImpl,
    updateStageResultImpl: options.updateStageResultImpl,
    networkPolicy: options.networkPolicy,
  };
}

function recordToolEvent(input: {
  options: ReviewFlowOptions;
  tool: string;
  action: string;
  details?: Record<string, unknown>;
  idempotency?: {
    key: string;
    outcome: string;
    ref: GitHubPullRequestRef | GitHubLabelRef | null;
    reason?: string;
  };
  includeStageArtifact?: boolean;
}): void {
  const ts = now(input.options.clock);
  const phase = input.options.phase ?? DEFAULT_PHASE;
  const event: WorkflowToolTranscriptEvent = {
    type: 'workflow_tool_call',
    tool: input.tool,
    phase,
    action: input.action,
    details: input.details,
    idempotency: input.idempotency,
    at: ts,
  };
  input.options.transcript.append(event);
  if (input.includeStageArtifact) {
    input.options.stageArtifact.append({
      tool: input.tool,
      phase,
      details: input.details,
      idempotency: input.idempotency ?? { key: '', outcome: 'skipped', ref: null },
      at: ts,
    });
  }
}

async function writeTerminalStageResult(
  options: ReviewFlowOptions,
  deps: CommandToolsDeps,
  input: {
    ok: boolean;
    review: ReviewFlowReviewSummary;
    fixes: ReviewFlowFixSummary;
    linearComment?: LinearCommentResult;
    pullRequest?: GitHubCreatePrResult;
    labels: GitHubAddLabelResult[];
    warnings: string[];
    failureReason?: string;
  },
): Promise<Awaited<ReturnType<typeof executeWriteStageResult>>> {
  const status: StageStatus = input.ok ? 'completed' : 'failed';
  return executeWriteStageResult({
    featureDir: options.featureDir,
    issueId: options.issueId,
    stage: 'review',
    status,
    notes: stageNotes(input.review, input.ok),
    artifacts: {
      ...buildStageArtifacts(input),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    },
  }, deps);
}

export async function runReviewFlow(options: ReviewFlowOptions): Promise<ReviewFlowResult> {
  const phase = options.phase ?? DEFAULT_PHASE;
  const required: Array<[string, string | undefined | string[]]> = [
    ['issueId', options.issueId],
    ['featureDir', options.featureDir],
    ['repo', options.repo],
    ['base', options.base],
    ['head', options.head],
    ['headSha', options.headSha],
    ['title', options.title],
    ['body', options.body],
  ];
  const missing = required.find(([, value]) => {
    if (Array.isArray(value)) return value.length === 0;
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing) {
    throw new Error(`runReviewFlow missing required option: ${missing[0]}`);
  }

  const deps = createDeps(options);
  const registry = deps.registry;
  const reviewCall = await executeReviewChanges({
    base: options.base,
    worktree: options.featureDir,
    json: true,
  }, deps);

  const initialReview: ReviewFlowReviewSummary = {
    status: reviewCall.ok ? 'completed' : 'failed',
    findings: reviewCall.ok ? reviewCall.findings : '',
    findingCount: reviewCall.ok ? reviewCall.findingCount ?? 0 : 0,
    blockingCount: reviewCall.ok ? reviewCall.blockingCount ?? 0 : 0,
    needsStrongerReviewer: false,
  };
  const emptyFixes = makeFixSummary();

  if (!reviewCall.ok) {
    const warnings = [reviewCall.message];
    const stageResult = await writeTerminalStageResult(options, deps, {
      ok: false,
      review: initialReview,
      fixes: emptyFixes,
      labels: [],
      warnings,
      failureReason: reviewCall.message,
    });
    return {
      ok: false,
      review: initialReview,
      fixes: emptyFixes,
      labels: [],
      stageResult,
      haltedBeforeMerge: true,
      merged: false,
      warnings,
    };
  }

  let parsedReview: ReviewResult;
  try {
    parsedReview = parseStructuredReview(reviewCall.findings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedReview: ReviewFlowReviewSummary = {
      ...initialReview,
      status: 'failed',
    };
    const warnings = [message];
    const stageResult = await writeTerminalStageResult(options, deps, {
      ok: false,
      review: failedReview,
      fixes: emptyFixes,
      labels: [],
      warnings,
      failureReason: message,
    });
    return {
      ok: false,
      review: failedReview,
      fixes: emptyFixes,
      labels: [],
      stageResult,
      haltedBeforeMerge: true,
      merged: false,
      warnings,
    };
  }

  const review: ReviewFlowReviewSummary = {
    ...initialReview,
    needsStrongerReviewer: parsedReview.needsStrongerReviewer === true,
  };

  const findings = extractFindings(parsedReview);
  const fixes = makeFixSummary();
  const warnings: string[] = [];
  const labels: GitHubAddLabelResult[] = [];
  let linearComment: LinearCommentResult | undefined;
  let pullRequest: GitHubCreatePrResult | undefined;

  if (!review.needsStrongerReviewer) {
    for (const finding of findings) {
      fixes.attempted += 1;
      const key = `review_fix:${options.issueId}:${finding.id}`;
      let result: ReviewFindingFixResult;

      if (!options.fixFindings) {
        result = {
          ok: true,
          outcome: 'skipped',
          findingId: finding.id,
          message: 'no fix executor configured',
        };
      } else {
        result = await options.fixFindings({
          finding,
          issueId: options.issueId,
          featureDir: options.featureDir,
          repo: options.repo,
          base: options.base,
          head: options.head,
          sessionId: options.sessionId,
          phase,
        });
      }

      const outcome = result.outcome;
      if (outcome === 'applied') fixes.applied += 1;
      if (outcome === 'skipped') fixes.skipped += 1;
      if (outcome === 'denied') fixes.denied += 1;
      if (outcome === 'failed') fixes.failed += 1;

      fixes.outcomes.push({
        findingId: finding.id,
        outcome,
        ok: result.ok,
        message: result.message,
        filesChanged: result.filesChanged,
      });

      if (outcome === 'failed' || outcome === 'denied') {
        warnings.push(result.message ?? `${finding.id} ${outcome}`);
      }

      recordToolEvent({
        options,
        tool: 'review_fix',
        action: 'narrow_fix',
        details: {
          finding,
          message: result.message,
          filesChanged: result.filesChanged ?? [],
        },
        idempotency: {
          key,
          outcome,
          ref: null,
          reason: result.message,
        },
        includeStageArtifact: true,
      });
      if (outcome === 'applied') {
        registry.record(key, { key, outcome: 'updated', ref: null, reason: result.message });
      }
    }
  }

  if (review.needsStrongerReviewer) {
    const stageResult = await writeTerminalStageResult(options, deps, {
      ok: true,
      review,
      fixes,
      labels,
      warnings,
    });
    return {
      ok: true,
      review,
      fixes,
      labels,
      stageResult,
      haltedBeforeMerge: true,
      merged: false,
      warnings,
    };
  }

  linearComment = await executeLinearComment({
    issue: options.issueId,
    body: buildLinearCommentBody(options.issueId, review, fixes),
    sessionId: options.sessionId,
    phase,
  }, {
    client: options.linearClient,
    registry,
    transcript: options.transcript,
    stageArtifact: options.stageArtifact,
    sessionId: options.sessionId,
    phase,
    clock: options.clock,
    networkPolicy: options.networkPolicy,
  });
  if (!linearComment.ok) {
    warnings.push(`linear_comment: ${linearComment.message}`);
  }

  pullRequest = await githubCreatePr({
    repo: options.repo,
    phase,
    head: options.head,
    base: options.base,
    headSha: options.headSha,
    title: options.title,
    body: buildPrBody(options.body, review, fixes),
  }, options.githubDeps);

  recordToolEvent({
    options,
    tool: 'github_create_pr',
    action: pullRequest.ok && pullRequest.idempotency.outcome === 'updated' ? 'update_pr' : 'create_pr',
    details: pullRequest.ok
      ? {
          repo: options.repo,
          head: options.head,
          base: options.base,
          title: options.title,
        }
      : {
          repo: options.repo,
          head: options.head,
          base: options.base,
          error: pullRequest.error,
          message: pullRequest.message,
        },
    idempotency: pullRequest.ok
      ? {
          key: pullRequest.idempotency.key,
          outcome: pullRequest.idempotency.outcome,
          ref: pullRequest.idempotency.ref,
          reason: pullRequest.idempotency.reason,
        }
      : {
          key: `github_create_pr:${options.repo}:${options.head}:${options.base}:${options.headSha}`,
          outcome: 'skipped',
          ref: null,
          reason: pullRequest.message,
        },
    includeStageArtifact: true,
  });

  if (!pullRequest.ok) {
    warnings.push(`github_create_pr: ${pullRequest.message}`);
    const stageResult = await writeTerminalStageResult(options, deps, {
      ok: false,
      review,
      fixes,
      linearComment,
      pullRequest,
      labels,
      warnings,
      failureReason: pullRequest.message,
    });
    return {
      ok: false,
      review,
      fixes,
      linearComment,
      pullRequest,
      labels,
      stageResult,
      haltedBeforeMerge: true,
      merged: false,
      warnings,
    };
  }

  const dedupedLabels = [...new Set((options.labels ?? []).map((label) => label.trim()).filter(Boolean))];
  for (const label of dedupedLabels) {
    const labelResult = await githubAddLabel({
      repo: options.repo,
      phase,
      targetKind: 'pull_request',
      targetNumber: pullRequest.idempotency.ref!.number,
      label,
    }, options.githubDeps);
    labels.push(labelResult);
    recordToolEvent({
      options,
      tool: 'github_add_label',
      action: 'add_label',
      details: labelResult.ok
        ? {
            repo: options.repo,
            targetNumber: pullRequest.idempotency.ref!.number,
            label,
          }
        : {
            repo: options.repo,
            targetNumber: pullRequest.idempotency.ref!.number,
            label,
            error: labelResult.error,
            message: labelResult.message,
          },
      idempotency: labelResult.ok
        ? {
            key: labelResult.idempotency.key,
            outcome: labelResult.idempotency.outcome,
            ref: labelResult.idempotency.ref,
            reason: labelResult.idempotency.reason,
          }
        : {
            key: `github_add_label:${options.repo}:pull_request:${pullRequest.idempotency.ref!.number}:${label.toLowerCase()}`,
            outcome: 'skipped',
            ref: null,
            reason: labelResult.message,
          },
      includeStageArtifact: true,
    });
    if (!labelResult.ok) {
      warnings.push(`github_add_label(${label}): ${labelResult.message}`);
    }
  }

  const stageResult = await writeTerminalStageResult(options, deps, {
    ok: true,
    review,
    fixes,
    linearComment,
    pullRequest,
    labels,
    warnings,
  });

  return {
    ok: true,
    review,
    fixes,
    linearComment,
    pullRequest,
    labels,
    stageResult,
    haltedBeforeMerge: true,
    merged: false,
    warnings,
  };
}
