import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectVariedDimensions, type ChallengeComparison, type ChallengeRoutingMeta } from './challenge-comparison.ts';

type ComparisonVerdict = Omit<
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
>;

/**
 * Resolve a PR number to a full GitHub pull request URL.
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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve PR URL for ${pr}: ${message}`);
  }
}

/**
 * Extract a PR number from either a raw number string or PR URL.
 */
export function prNumberFromValue(pr: string): string {
  const match = pr.match(/\/pull\/(\d+)$/);
  return match?.[1] || pr;
}

/**
 * Build the prompt used to compare two PRs for the same challenge task.
 */
export function buildComparisonPrompt(input: {
  issuePrompt: string;
  primaryDiff: string;
  challengerDiff: string;
  primaryEvalScore: number;
  challengerEvalScore: number;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
}): string {
  let workflowContext = '';

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

Primary side:
- Planner: ${input.primaryRouting.planner} | Coder: ${input.primaryRouting.coder} | Reviewer: ${input.primaryRouting.reviewer}
- Plan depth: ${input.primaryRouting.planDepth} | Code depth: ${input.primaryRouting.codeDepth} | Review mode: ${input.primaryRouting.reviewMode}

Challenger side:
- Planner: ${input.challengerRouting.planner} | Coder: ${input.challengerRouting.coder} | Reviewer: ${input.challengerRouting.reviewer}
- Plan depth: ${input.challengerRouting.planDepth} | Code depth: ${input.challengerRouting.codeDepth} | Review mode: ${input.challengerRouting.reviewMode}

Variables that differed: ${variedFields.join(', ') || 'none'}

Consider whether routing differences (not just code differences) may have influenced the outcome.
`;
  }

  return `You are judging two pull requests for the same task.

Return JSON only with this exact structure:
{
  "winner": "primary" | "challenger",
  "rationale": "short explanation",
  "workflowInsight": "optional observation about how routing differences may have influenced the result",
  "dimensions": {
    "correctness": { "primary": number, "challenger": number },
    "codeQuality": { "primary": number, "challenger": number },
    "completeness": { "primary": number, "challenger": number },
    "scopeDiscipline": { "primary": number, "challenger": number }
  }
}

Scores must be integers from 1 to 10.
${workflowContext}

Task context:
${input.issuePrompt}

Primary eval score: ${input.primaryEvalScore}
Challenger eval score: ${input.challengerEvalScore}

Primary diff:
${input.primaryDiff}

Challenger diff:
${input.challengerDiff}`;
}

/**
 * Validate and normalize the LLM comparison response payload.
 */
export function validateComparisonJson(parsed: any): ComparisonVerdict {
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
  for (const key of ['correctness', 'codeQuality', 'completeness', 'scopeDiscipline']) {
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
        `Invalid ${key} scores: primary=${dimension.primary}, challenger=${dimension.challenger}. Expected integers from 1 to 10.`,
      );
    }
  }

  const result: ComparisonVerdict = { winner, rationale: rationale.trim(), dimensions };
  if (workflowInsight && workflowInsight.trim().length > 0) {
    result.workflowInsight = workflowInsight.trim();
  }
  return result;
}

/**
 * Run a GitHub CLI command and return its trimmed stdout.
 */
export function runGh(args: string[], repoDir: string): string {
  try {
    return execFileSync('gh', args, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`gh ${args.join(' ')} failed: ${message}`);
  }
}

/**
 * Run a GitHub CLI command but downgrade failures to warnings.
 */
export function tryGh(args: string[], repoDir: string, label: string): void {
  try {
    runGh(args, repoDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[compare-prs] ${label} failed: ${message}`);
  }
}

/**
 * Persist a temporary comment body to disk for a single callback invocation.
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
 * Summarize routing differences between the primary and challenger workflows.
 */
export function formatRoutingSummary(
  primaryRouting?: ChallengeRoutingMeta,
  challengerRouting?: ChallengeRoutingMeta,
  challengeType?: string,
): string {
  if (!primaryRouting || !challengerRouting) {
    return '';
  }

  const parts: string[] = [];
  parts.push(
    `Primary used ${primaryRouting.planner || 'unknown'} (planner) + ${primaryRouting.coder} (coder)` +
      (primaryRouting.reviewer ? ` + ${primaryRouting.reviewer} (reviewer)` : ''),
  );
  parts.push(
    `Challenger used ${challengerRouting.planner || 'unknown'} (planner) + ${challengerRouting.coder} (coder)` +
      (challengerRouting.reviewer ? ` + ${challengerRouting.reviewer} (reviewer)` : ''),
  );

  let summary = parts.join(' vs ');
  if (challengeType) {
    summary += `\nChallenge type: ${challengeType}`;
  }
  return summary;
}
