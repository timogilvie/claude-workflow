import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectVariedDimensions,
  type ChallengeComparisonDimensions,
  type ChallengeComparison,
  type ChallengeRoutingMeta,
  type ChallengeSideExecutionProvenance,
  type ChallengeProvenanceValidation,
} from './challenge-comparison.ts';
import type { ChallengeStageEval } from './eval-schema.ts';
import { formatRubricForJudgePrompt } from './rubric.ts';
import { errorMessage } from './error-utils.ts';

export type PresentationOrder = 'primary-first' | 'challenger-first';

type CandidateLabel = 'Candidate A' | 'Candidate B';
type CandidateKey = 'A' | 'B';

export interface BlindComparisonDimensions {
  completeness: { A: number; B: number };
  correctness: { A: number; B: number };
  code_quality: { A: number; B: number };
  intervention_impact: { A: number; B: number };
  autonomy: { A: number; B: number };
}

export interface BlindComparisonResult {
  winner: CandidateKey;
  rationale: string;
  workflowInsight?: string;
  dimensions: BlindComparisonDimensions;
}

export type ValidatedComparisonResult = Omit<
  ChallengeComparison,
  | 'challengePairId'
  | 'primaryModel'
  | 'challengerModel'
  | 'primaryPrUrl'
  | 'challengerPrUrl'
  | 'primaryEvalScore'
  | 'challengerEvalScore'
  | 'winnerModel'
  | 'timestamp'
  | 'primaryRouting'
  | 'challengerRouting'
  | 'variedDimensions'
  | 'challengeType'
  | 'variedStage'
  | 'stageEvidenceMode'
  | 'presentationOrder'
  // Schema-carrier fields (not populated by judge, HOK-2794)
  | 'forkStage'
  | 'forkCommit'
  | 'sharedPrefix'
  | 'primaryInheritedStages'
  | 'challengerInheritedStages'
  | 'primaryDiffIdentity'
  | 'challengerDiffIdentity'
  | 'judge_model'
  | 'judge_prompt_hash'
  | 'primary_cost_usd'
  | 'challenger_cost_usd'
  | 'criterionRationales'
  | 'noComparisonReason'
>;

export function resolvePresentationOrder(
  explicit?: string,
  rng: () => number = Math.random,
): PresentationOrder {
  if (explicit === undefined || explicit === '' || explicit === 'random') {
    return rng() < 0.5 ? 'primary-first' : 'challenger-first';
  }
  if (explicit === 'primary-first' || explicit === 'challenger-first') {
    return explicit;
  }
  throw new Error(`Invalid presentation order: ${explicit}. Expected primary-first, challenger-first, or random.`);
}

function formatStageEvidenceBlock(
  side: CandidateLabel,
  evidence: ChallengeStageEval,
): string {
  const items = evidence.evidence
    .slice(0, 6)
    .map((item) => `- ${item.label}: ${item.summary}${item.source ? ` [${item.source}]` : ''}`)
    .join('\n');
  return `${side} ${evidence.stage} evidence (${evidence.provenance}): ${evidence.summary}${evidence.fallbackReason ? ` Fallback: ${evidence.fallbackReason}.` : ''}\n${items}`;
}

/**
 * Resolve a pull request number to its GitHub URL.
 */
export function prUrlFromNumber(pr: string, repoDir: string): string {
  if (/^https?:\/\//.test(pr)) {
    return pr;
  }
  try {
    return execFileSync('gh', ['pr', 'view', pr, '--json', 'url', '--jq', '.url'], {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`Failed to resolve PR URL for ${pr}: ${errorMessage(error)}`);
  }
}

/**
 * Extract a pull request number from either a number-like string or PR URL.
 */
export function prNumberFromValue(pr: string): string {
  const match = pr.match(/\/pull\/(\d+)$/);
  return match?.[1] || pr;
}

/**
 * Build the LLM prompt used to compare two challenge PRs.
 */
export function buildComparisonPrompt(input: {
  issuePrompt: string;
  primaryDiff: string;
  challengerDiff: string;
  presentationOrder: PresentationOrder;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  challengeType?: string;
  primaryStageEval?: ChallengeStageEval;
  challengerStageEval?: ChallengeStageEval;
  primaryExecution?: ChallengeSideExecutionProvenance;
  challengerExecution?: ChallengeSideExecutionProvenance;
}): string {
  let workflowContext = '';
  let stageEvidenceContext = '';
  const sideA = sideView(input.presentationOrder, 'A', input);
  const sideB = sideView(input.presentationOrder, 'B', input);

  if (input.primaryRouting && input.challengerRouting) {
    const variedDimensions = detectVariedDimensions(input.primaryRouting, input.challengerRouting);
    const variedFields: string[] = [];
    if (variedDimensions) {
      if (variedDimensions.planner) variedFields.push('planner');
      if (variedDimensions.coder) variedFields.push('coder');
      if (variedDimensions.reviewer) variedFields.push('reviewer');
      if (variedDimensions.planDepth) variedFields.push('planDepth');
      if (variedDimensions.codeDepth) variedFields.push('codeDepth');
      if (variedDimensions.reviewMode) variedFields.push('reviewMode');
    }

    workflowContext = `

## Workflow Context

Intended routing:
Candidate A side:
- Planner: ${sideA.routing?.planner} | Coder: ${sideA.routing?.coder} | Reviewer: ${sideA.routing?.reviewer}
- Plan depth: ${sideA.routing?.planDepth} | Code depth: ${sideA.routing?.codeDepth} | Review mode: ${sideA.routing?.reviewMode}

Candidate B side:
- Planner: ${sideB.routing?.planner} | Coder: ${sideB.routing?.coder} | Reviewer: ${sideB.routing?.reviewer}
- Plan depth: ${sideB.routing?.planDepth} | Code depth: ${sideB.routing?.codeDepth} | Review mode: ${sideB.routing?.reviewMode}

Variables that differed: ${variedFields.join(', ') || 'none'}
${formatExecutionPromptContext(sideA.execution, sideB.execution)}
Consider whether routing differences (not just code differences) may have influenced the outcome.
`;
  }

  if (
    (input.challengeType === 'planner-only' || input.challengeType === 'reviewer-only')
    && sideA.stageEval?.provenance === 'direct'
    && sideB.stageEval?.provenance === 'direct'
  ) {
    stageEvidenceContext = `

## Direct Stage Evidence

Use this evidence as the primary signal for the varied stage.

${formatStageEvidenceBlock('Candidate A', sideA.stageEval)}

${formatStageEvidenceBlock('Candidate B', sideB.stageEval)}
`;
  }

  return `You are judging two candidate pull requests (Candidate A and Candidate B) for the same task.

Return JSON only with this exact structure:
{
  "winner": "A" | "B",
  "rationale": "short explanation",
  "workflowInsight": "optional observation about how routing differences may have influenced the result",
  "dimensions": {
    "completeness": { "A": number, "B": number },
    "correctness": { "A": number, "B": number },
    "code_quality": { "A": number, "B": number },
    "intervention_impact": { "A": number, "B": number },
    "autonomy": { "A": number, "B": number }
  }
}

Scores must be integers from 1 to 10.

Use these criterion definitions exactly:
${formatRubricForJudgePrompt()}

${workflowContext}

${stageEvidenceContext}

Task context:
${input.issuePrompt}

Candidate A diff:
${sideA.diff}

Candidate B diff:
${sideB.diff}`;
}

function sideView(
  order: PresentationOrder,
  candidate: CandidateKey,
  input: {
    primaryDiff: string;
    challengerDiff: string;
    primaryRouting?: ChallengeRoutingMeta;
    challengerRouting?: ChallengeRoutingMeta;
    primaryStageEval?: ChallengeStageEval;
    challengerStageEval?: ChallengeStageEval;
    primaryExecution?: ChallengeSideExecutionProvenance;
    challengerExecution?: ChallengeSideExecutionProvenance;
  },
): {
  diff: string;
  routing?: ChallengeRoutingMeta;
  stageEval?: ChallengeStageEval;
  execution?: ChallengeSideExecutionProvenance;
} {
  const isPrimary = order === 'primary-first' ? candidate === 'A' : candidate === 'B';
  return isPrimary
    ? {
        diff: input.primaryDiff,
        routing: input.primaryRouting,
        stageEval: input.primaryStageEval,
        execution: input.primaryExecution,
      }
    : {
        diff: input.challengerDiff,
        routing: input.challengerRouting,
        stageEval: input.challengerStageEval,
        execution: input.challengerExecution,
      };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function prefixWithinByteBudget(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (byteLength(candidate) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function truncateDiffForPrompt(text: string, label: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;

  let kept = prefixWithinByteBudget(text, maxBytes);
  for (let i = 0; i < 8; i++) {
    const marker = `\n[... TRUNCATED ${label} diff from ${byteLength(text)} bytes to fit comparison prompt ...]\n`;
    const remainingForContent = maxBytes - byteLength(marker);
    const nextKept = prefixWithinByteBudget(text, remainingForContent);
    if (nextKept === kept) {
      return `${kept}${marker}`;
    }
    kept = nextKept;
  }

  return kept;
}

export function buildCappedComparisonPrompt(
  input: Parameters<typeof buildComparisonPrompt>[0],
  maxPromptBytes: number,
): { prompt: string; truncated: boolean; originalBytes: number; finalBytes: number } {
  const originalPrompt = buildComparisonPrompt(input);
  const originalBytes = byteLength(originalPrompt);
  if (!Number.isFinite(maxPromptBytes) || maxPromptBytes <= 0 || originalBytes <= maxPromptBytes) {
    return { prompt: originalPrompt, truncated: false, originalBytes, finalBytes: originalBytes };
  }

  const scaffoldBytes = byteLength(buildComparisonPrompt({
    ...input,
    primaryDiff: '',
    challengerDiff: '',
  }));
  let availableDiffBytes = Math.max(0, maxPromptBytes - scaffoldBytes);
  const primaryBytes = byteLength(input.primaryDiff);
  const challengerBytes = byteLength(input.challengerDiff);
  const totalDiffBytes = primaryBytes + challengerBytes;
  const primaryBudget = totalDiffBytes > 0
    ? Math.floor(availableDiffBytes * (primaryBytes / totalDiffBytes))
    : 0;
  const challengerBudget = Math.max(0, availableDiffBytes - primaryBudget);

  let prompt = buildComparisonPrompt({
    ...input,
    primaryDiff: truncateDiffForPrompt(
      input.primaryDiff,
      input.presentationOrder === 'primary-first' ? 'candidate A' : 'candidate B',
      primaryBudget,
    ),
    challengerDiff: truncateDiffForPrompt(
      input.challengerDiff,
      input.presentationOrder === 'primary-first' ? 'candidate B' : 'candidate A',
      challengerBudget,
    ),
  });

  while (byteLength(prompt) > maxPromptBytes && availableDiffBytes > 0) {
    availableDiffBytes = Math.floor(availableDiffBytes * 0.9);
    const nextPrimaryBudget = totalDiffBytes > 0
      ? Math.floor(availableDiffBytes * (primaryBytes / totalDiffBytes))
      : 0;
    const nextChallengerBudget = Math.max(0, availableDiffBytes - nextPrimaryBudget);
    prompt = buildComparisonPrompt({
      ...input,
      primaryDiff: truncateDiffForPrompt(
        input.primaryDiff,
        input.presentationOrder === 'primary-first' ? 'candidate A' : 'candidate B',
        nextPrimaryBudget,
      ),
      challengerDiff: truncateDiffForPrompt(
        input.challengerDiff,
        input.presentationOrder === 'primary-first' ? 'candidate B' : 'candidate A',
        nextChallengerBudget,
      ),
    });
  }

  return {
    prompt,
    truncated: true,
    originalBytes,
    finalBytes: byteLength(prompt),
  };
}

/**
 * Validate and normalize the LLM comparison response payload.
 */
export function validateComparisonJson(parsed: any): BlindComparisonResult {
  const winner = parsed?.winner;
  const rationale = parsed?.rationale;
  const dimensions = parsed?.dimensions;
  const workflowInsight = parsed?.workflowInsight;

  if (winner === 'primary' || winner === 'challenger') {
    throw new Error('Unblinded comparison winner keys are not allowed. Use A or B.');
  }
  if (winner !== 'A' && winner !== 'B') {
    throw new Error(`Invalid blind winner: ${winner}`);
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new Error('Comparison rationale must be a non-empty string');
  }
  if (workflowInsight !== undefined && typeof workflowInsight !== 'string') {
    throw new Error('workflowInsight must be a string if provided');
  }
  const requiredDimensionKeys: Array<keyof ChallengeComparisonDimensions> = [
    'completeness',
    'correctness',
    'code_quality',
    'intervention_impact',
    'autonomy',
  ];
  for (const key of requiredDimensionKeys) {
    const dimension = dimensions?.[key];
    if (dimension?.primary !== undefined || dimension?.challenger !== undefined) {
      throw new Error(`Unblinded comparison dimension keys are not allowed for ${key}. Use A and B.`);
    }
    if (!dimension || typeof dimension.A !== 'number' || typeof dimension.B !== 'number') {
      throw new Error(`Invalid dimension payload for ${key}`);
    }
    if (
      !Number.isInteger(dimension.A) ||
      !Number.isInteger(dimension.B) ||
      dimension.A < 1 ||
      dimension.A > 10 ||
      dimension.B < 1 ||
      dimension.B > 10
    ) {
      throw new Error(
        `Invalid ${key} scores: A=${dimension.A}, B=${dimension.B}. ` +
        'Expected integers from 1 to 10.'
      );
    }
  }

  if (dimensions?.scopeDiscipline !== undefined || dimensions?.codeQuality !== undefined) {
    throw new Error('Legacy comparison keys are not allowed. Use canonical rubric keys only.');
  }

  const result: BlindComparisonResult = {
    winner,
    rationale: rationale.trim(),
    dimensions: dimensions as BlindComparisonDimensions,
  };
  if (workflowInsight && workflowInsight.trim().length > 0) {
    result.workflowInsight = workflowInsight.trim();
  }
  return result;
}

export function mapBlindVerdictToSides(
  verdict: BlindComparisonResult,
  order: PresentationOrder,
): ValidatedComparisonResult {
  const aSide = order === 'primary-first' ? 'primary' : 'challenger';
  const bSide = order === 'primary-first' ? 'challenger' : 'primary';
  const winner = verdict.winner === 'A' ? aSide : bSide;
  const dimensions = Object.fromEntries(
    Object.entries(verdict.dimensions).map(([key, scores]) => [
      key,
      {
        primary: aSide === 'primary' ? scores.A : scores.B,
        challenger: aSide === 'challenger' ? scores.A : scores.B,
      },
    ]),
  ) as ChallengeComparisonDimensions;

  const result: ValidatedComparisonResult = {
    winner,
    rationale: verdict.rationale,
    dimensions,
  };
  if (verdict.workflowInsight) {
    result.workflowInsight = verdict.workflowInsight;
  }
  return result;
}

/**
 * Run a GitHub CLI command and return trimmed stdout.
 */
export function runGh(args: string[], repoDir: string): string {
  try {
    return execFileSync('gh', args, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`gh ${args.join(' ')} failed: ${errorMessage(error)}`);
  }
}

/**
 * Run a GitHub CLI command and warn instead of throwing on failure.
 */
export function tryGh(args: string[], repoDir: string, label: string): void {
  try {
    runGh(args, repoDir);
  } catch (error) {
    console.warn(`[compare-prs] ${label} failed: ${errorMessage(error)}`);
  }
}

/**
 * Write a temporary body file for `gh` commands and clean it up afterward.
 */
export function withBodyFile<T>(body: string, fn: (filePath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-compare-'));
  const filePath = join(dir, 'body.txt');
  writeFileSync(filePath, body, 'utf-8');
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Build the PR comment body for a challenge comparison result.
 */
export function buildChallengeCommentBody(input: {
  pairId: string;
  winner?: 'primary' | 'challenger';
  winnerModel?: string;
  rationale: string;
  otherPrUrl: string;
  routingSummary?: string;
  provenanceValidation?: ChallengeProvenanceValidation;
}): string {
  const commentParts = [
    `Challenge comparison for \`${input.pairId}\``,
    ``,
  ];

  if (input.routingSummary) {
    commentParts.push(input.routingSummary, '');
  }

  if (input.provenanceValidation && !input.provenanceValidation.valid) {
    commentParts.push(
      `Comparison outcome: ${input.provenanceValidation.outcome ?? 'invalid'}`,
      `Other PR: ${input.otherPrUrl}`,
      ``,
      input.rationale,
    );
    return commentParts.join('\n');
  }

  commentParts.push(
    `Recommended winner: ${input.winner} (${input.winnerModel})`,
    `Other PR: ${input.otherPrUrl}`,
    ``,
    input.rationale,
  );

  return commentParts.join('\n');
}

function formatExecutedStage(stage: ChallengeSideExecutionProvenance[keyof ChallengeSideExecutionProvenance]): string {
  const agent = stage.agent || 'unknown-agent';
  const model = stage.model || 'unknown-model';
  const status = stage.status || 'unknown-status';
  const path = stage.artifactPath ? ` @ ${stage.artifactPath}` : '';
  return `${agent}/${model} [${status}, ${stage.source}${path}]`;
}

function formatExecutionPromptContext(
  candidateAExecution?: ChallengeSideExecutionProvenance,
  candidateBExecution?: ChallengeSideExecutionProvenance,
): string {
  if (!candidateAExecution || !candidateBExecution) return '';
  return `
Executed provenance:
- Candidate A planner: ${formatExecutedStage(candidateAExecution.planning)}
- Candidate A coder: ${formatExecutedStage(candidateAExecution.coding)}
- Candidate A reviewer: ${formatExecutedStage(candidateAExecution.review)}
- Candidate B planner: ${formatExecutedStage(candidateBExecution.planning)}
- Candidate B coder: ${formatExecutedStage(candidateBExecution.coding)}
- Candidate B reviewer: ${formatExecutedStage(candidateBExecution.review)}
`;
}

/**
 * Format routing metadata for PR comment output.
 */
export function formatRoutingSummary(
  primaryRouting?: ChallengeRoutingMeta,
  challengerRouting?: ChallengeRoutingMeta,
  challengeType?: string,
  primaryExecution?: ChallengeSideExecutionProvenance,
  challengerExecution?: ChallengeSideExecutionProvenance,
  provenanceValidation?: ChallengeProvenanceValidation,
): string {
  if (!primaryRouting || !challengerRouting) {
    return '';
  }

  const parts: string[] = [];

  parts.push(
    `Primary intended ${primaryRouting.planner || 'unknown'} (planner) + ${primaryRouting.coder} (coder)` +
    (primaryRouting.reviewer ? ` + ${primaryRouting.reviewer} (reviewer)` : '')
  );
  parts.push(
    `Challenger intended ${challengerRouting.planner || 'unknown'} (planner) + ${challengerRouting.coder} (coder)` +
    (challengerRouting.reviewer ? ` + ${challengerRouting.reviewer} (reviewer)` : '')
  );

  let summary = parts.join(' vs ');

  if (primaryExecution && challengerExecution) {
    summary += `\nExecuted primary: planner ${formatExecutedStage(primaryExecution.planning)}; coder ${formatExecutedStage(primaryExecution.coding)}; reviewer ${formatExecutedStage(primaryExecution.review)}`;
    summary += `\nExecuted challenger: planner ${formatExecutedStage(challengerExecution.planning)}; coder ${formatExecutedStage(challengerExecution.coding)}; reviewer ${formatExecutedStage(challengerExecution.review)}`;
  }

  if (provenanceValidation && !provenanceValidation.valid) {
    const reasonLines = provenanceValidation.issues.map((issue) => {
      const path = issue.artifactPath ? ` path=${issue.artifactPath}` : '';
      const intended = issue.intendedModel ? ` intended=${issue.intendedModel}` : '';
      const executed = issue.executedModel ? ` executed=${issue.executedModel}` : '';
      return `- ${issue.side} ${issue.role}: ${issue.reason}${intended}${executed}${path}`;
    });
    summary += `\nProvenance validation: ${provenanceValidation.outcome ?? 'invalid'}\n${reasonLines.join('\n')}`;
  }

  if (challengeType) {
    summary += `\nChallenge type: ${challengeType}`;
  }

  return summary;
}
