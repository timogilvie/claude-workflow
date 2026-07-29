import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectVariedDimensions,
  type ChallengeComparisonDimensions,
  type ChallengeExecutionProvenance,
  type ChallengeProvenanceValidation,
  type ChallengeComparison,
  type ChallengeRoutingMeta,
} from './challenge-comparison.ts';
import { scoreSourceLabel } from './challenge-score-selector.ts';
import type { ChallengeStageEval } from './eval-schema.ts';
import { formatRubricForJudgePrompt } from './rubric.ts';
import { errorMessage } from './error-utils.ts';

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
>;

function formatStageEvidenceBlock(
  side: 'Primary' | 'Challenger',
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
  primaryEvalScore: number;
  challengerEvalScore: number;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  primaryEvalScoreSource?: string;
  challengerEvalScoreSource?: string;
  primaryPerStageScores?: Record<string, number>;
  challengerPerStageScores?: Record<string, number>;
  challengeType?: string;
  primaryStageEval?: ChallengeStageEval;
  challengerStageEval?: ChallengeStageEval;
  executionProvenance?: ChallengeExecutionProvenance;
  provenanceValidation?: ChallengeProvenanceValidation;
}): string {
  let workflowContext = '';
  let stageEvidenceContext = '';

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

    let perStageContext = '';
    const primaryStages = input.primaryPerStageScores ?? {};
    const challengerStages = input.challengerPerStageScores ?? {};
    if (Object.keys({ ...primaryStages, ...challengerStages }).length > 0) {
      const stageLines = Object.keys({ ...primaryStages, ...challengerStages }).sort().map((stage) => {
        const p = primaryStages[stage] !== undefined ? primaryStages[stage].toFixed(2) : 'n/a';
        const c = challengerStages[stage] !== undefined ? challengerStages[stage].toFixed(2) : 'n/a';
        return `  ${stage}: primary=${p}, challenger=${c}`;
      });
      perStageContext = `\nPer-stage scores:\n${stageLines.join('\n')}\n`;
    }

    const executionContext = input.executionProvenance
      ? `\nExecuted provenance:\n${formatExecutionProvenance(input.executionProvenance, input.provenanceValidation)}\n`
      : '';

    workflowContext = `

## Workflow Context

Intended routing:
Primary side:
- Planner: ${input.primaryRouting.planner} | Coder: ${input.primaryRouting.coder} | Reviewer: ${input.primaryRouting.reviewer}
- Plan depth: ${input.primaryRouting.planDepth} | Code depth: ${input.primaryRouting.codeDepth} | Review mode: ${input.primaryRouting.reviewMode}

Challenger side:
- Planner: ${input.challengerRouting.planner} | Coder: ${input.challengerRouting.coder} | Reviewer: ${input.challengerRouting.reviewer}
- Plan depth: ${input.challengerRouting.planDepth} | Code depth: ${input.challengerRouting.codeDepth} | Review mode: ${input.challengerRouting.reviewMode}

Variables that differed: ${variedFields.join(', ') || 'none'}
${perStageContext}
${executionContext}
Consider whether routing differences (not just code differences) may have influenced the outcome.
`;
  }

  const primaryScoreLabel = scoreSourceLabel(input.primaryEvalScoreSource || 'overall', 'Primary');
  const challengerScoreLabel = scoreSourceLabel(input.challengerEvalScoreSource || 'overall', 'Challenger');

  if (
    (input.challengeType === 'planner-only' || input.challengeType === 'reviewer-only')
    && input.primaryStageEval?.provenance === 'direct'
    && input.challengerStageEval?.provenance === 'direct'
  ) {
    stageEvidenceContext = `

## Direct Stage Evidence

Use this evidence as the primary signal for the varied stage.

${formatStageEvidenceBlock('Primary', input.primaryStageEval)}

${formatStageEvidenceBlock('Challenger', input.challengerStageEval)}
`;
  }

  return `You are judging two pull requests for the same task.

Return JSON only with this exact structure:
{
  "winner": "primary" | "challenger",
  "rationale": "short explanation",
  "workflowInsight": "optional observation about how routing differences may have influenced the result",
  "dimensions": {
    "completeness": { "primary": number, "challenger": number },
    "correctness": { "primary": number, "challenger": number },
    "code_quality": { "primary": number, "challenger": number },
    "intervention_impact": { "primary": number, "challenger": number },
    "autonomy": { "primary": number, "challenger": number }
  }
}

Scores must be integers from 1 to 10.

Use these criterion definitions exactly:
${formatRubricForJudgePrompt()}

${workflowContext}

${stageEvidenceContext}

Task context:
${input.issuePrompt}

${primaryScoreLabel}: ${input.primaryEvalScore}
${challengerScoreLabel}: ${input.challengerEvalScore}

Primary diff:
${input.primaryDiff}

Challenger diff:
${input.challengerDiff}`;
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
    primaryDiff: truncateDiffForPrompt(input.primaryDiff, 'primary', primaryBudget),
    challengerDiff: truncateDiffForPrompt(input.challengerDiff, 'challenger', challengerBudget),
  });

  while (byteLength(prompt) > maxPromptBytes && availableDiffBytes > 0) {
    availableDiffBytes = Math.floor(availableDiffBytes * 0.9);
    const nextPrimaryBudget = totalDiffBytes > 0
      ? Math.floor(availableDiffBytes * (primaryBytes / totalDiffBytes))
      : 0;
    const nextChallengerBudget = Math.max(0, availableDiffBytes - nextPrimaryBudget);
    prompt = buildComparisonPrompt({
      ...input,
      primaryDiff: truncateDiffForPrompt(input.primaryDiff, 'primary', nextPrimaryBudget),
      challengerDiff: truncateDiffForPrompt(input.challengerDiff, 'challenger', nextChallengerBudget),
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
export function validateComparisonJson(parsed: any): ValidatedComparisonResult {
  const winner = parsed?.winner;
  const rationale = parsed?.rationale;
  const dimensions = parsed?.dimensions;
  const workflowInsight = parsed?.workflowInsight;

  if (winner !== 'primary' && winner !== 'challenger') {
    throw new Error(`Invalid winner: ${winner}`);
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
    if (!dimension || typeof dimension.primary !== 'number' || typeof dimension.challenger !== 'number') {
      throw new Error(`Invalid dimension payload for ${key}`);
    }
    if (
      !Number.isInteger(dimension.primary) ||
      !Number.isInteger(dimension.challenger) ||
      dimension.primary < 1 ||
      dimension.primary > 10 ||
      dimension.challenger < 1 ||
      dimension.challenger > 10
    ) {
      throw new Error(
        `Invalid ${key} scores: primary=${dimension.primary}, challenger=${dimension.challenger}. ` +
        'Expected integers from 1 to 10.'
      );
    }
  }

  if (dimensions?.scopeDiscipline !== undefined || dimensions?.codeQuality !== undefined) {
    throw new Error('Legacy comparison keys are not allowed. Use canonical rubric keys only.');
  }

  const result: ValidatedComparisonResult = {
    winner,
    rationale: rationale.trim(),
    dimensions: dimensions as ChallengeComparisonDimensions,
  };
  if (workflowInsight && workflowInsight.trim().length > 0) {
    result.workflowInsight = workflowInsight.trim();
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
  comparisonOutcome?: string;
  validity?: string;
  mismatchReasons?: string[];
}): string {
  const commentParts = [
    `Challenge comparison for \`${input.pairId}\``,
    ``,
  ];

  if (input.routingSummary) {
    commentParts.push(input.routingSummary, '');
  }

  if (input.comparisonOutcome === 'inconclusive' || input.validity === 'invalid' || !input.winner) {
    commentParts.push(`Result: inconclusive`, `Other PR: ${input.otherPrUrl}`);
    if (input.mismatchReasons && input.mismatchReasons.length > 0) {
      commentParts.push('', 'Execution provenance mismatch:');
      for (const reason of input.mismatchReasons) {
        commentParts.push(`- ${reason}`);
      }
    }
    commentParts.push('', input.rationale);
  } else {
    commentParts.push(
      `Recommended winner: ${input.winner} (${input.winnerModel})`,
      `Other PR: ${input.otherPrUrl}`,
      ``,
      input.rationale,
    );
  }

  return commentParts.join('\n');
}

function formatStageLine(
  sideLabel: string,
  stageLabel: string,
  stage: ChallengeExecutionProvenance['primary']['stages']['planning'],
): string {
  if (!stage) return `${sideLabel} ${stageLabel}: missing`;
  const executed = stage.model
    ? `${stage.agent || 'unknown-agent'} / ${stage.model}`
    : stage.status;
  return `${sideLabel} ${stageLabel}: ${executed} (${stage.status}) [${stage.sourcePath}]`;
}

export function formatExecutionProvenance(
  provenance: ChallengeExecutionProvenance,
  validation?: ChallengeProvenanceValidation,
): string {
  const lines = [
    formatStageLine('Primary', 'planner', provenance.primary.stages.planning),
    formatStageLine('Primary', 'coder', provenance.primary.stages.coding),
    formatStageLine('Primary', 'reviewer', provenance.primary.stages.review),
    formatStageLine('Challenger', 'planner', provenance.challenger.stages.planning),
    formatStageLine('Challenger', 'coder', provenance.challenger.stages.coding),
    formatStageLine('Challenger', 'reviewer', provenance.challenger.stages.review),
  ];
  if (validation?.mismatches.length) {
    lines.push('Mismatches:');
    for (const mismatch of validation.mismatches) {
      lines.push(`- ${mismatch.reason}${mismatch.sourcePath ? ` [${mismatch.sourcePath}]` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * Format routing metadata for PR comment output.
 */
export function formatRoutingSummary(
  primaryRouting?: ChallengeRoutingMeta,
  challengerRouting?: ChallengeRoutingMeta,
  challengeType?: string,
  executionProvenance?: ChallengeExecutionProvenance,
  provenanceValidation?: ChallengeProvenanceValidation,
): string {
  if (!primaryRouting || !challengerRouting) {
    return executionProvenance ? formatExecutionProvenance(executionProvenance, provenanceValidation) : '';
  }

  const parts: string[] = [];

  parts.push(
    `Intended primary route: ${primaryRouting.planner || 'unknown'} (planner) + ${primaryRouting.coder} (coder)` +
    (primaryRouting.reviewer ? ` + ${primaryRouting.reviewer} (reviewer)` : '')
  );
  parts.push(
    `Intended challenger route: ${challengerRouting.planner || 'unknown'} (planner) + ${challengerRouting.coder} (coder)` +
    (challengerRouting.reviewer ? ` + ${challengerRouting.reviewer} (reviewer)` : '')
  );

  let summary = parts.join(' vs ');

  if (challengeType) {
    summary += `\nChallenge type: ${challengeType}`;
  }
  if (executionProvenance) {
    summary += `\n${formatExecutionProvenance(executionProvenance, provenanceValidation)}`;
  }

  return summary;
}
