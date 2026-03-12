#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { callClaude, parseJsonFromLLM } from '../shared/lib/llm-cli.ts';
import { fetchIssueData, formatIssueAsPrompt, fetchPrContext } from '../shared/lib/eval-context-gatherer.ts';
import { readEvalRecords } from '../shared/lib/eval-persistence.ts';
import { appendChallengeComparison, type ChallengeComparison } from '../shared/lib/challenge-comparison.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function prUrlFromNumber(pr: string, repoDir: string): string {
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

function prNumberFromValue(pr: string): string {
  const match = pr.match(/\/pull\/(\d+)$/);
  return match?.[1] || pr;
}

function buildPrompt(input: {
  issuePrompt: string;
  primaryDiff: string;
  challengerDiff: string;
  primaryEvalScore: number;
  challengerEvalScore: number;
}): string {
  return `You are judging two pull requests for the same task.

Return JSON only with this exact structure:
{
  "winner": "primary" | "challenger",
  "rationale": "short explanation",
  "dimensions": {
    "correctness": { "primary": number, "challenger": number },
    "codeQuality": { "primary": number, "challenger": number },
    "completeness": { "primary": number, "challenger": number },
    "scopeDiscipline": { "primary": number, "challenger": number }
  }
}

Scores must be integers from 1 to 10.

Task context:
${input.issuePrompt}

Primary eval score: ${input.primaryEvalScore}
Challenger eval score: ${input.challengerEvalScore}

Primary diff:
${input.primaryDiff}

Challenger diff:
${input.challengerDiff}`;
}

function validateComparisonJson(parsed: any): Omit<ChallengeComparison, 'challengePairId' | 'primaryModel' | 'challengerModel' | 'primaryPrUrl' | 'challengerPrUrl' | 'primaryEvalScore' | 'challengerEvalScore' | 'winnerModel' | 'timestamp'> {
  const winner = parsed?.winner;
  const rationale = parsed?.rationale;
  const dimensions = parsed?.dimensions;
  if (winner !== 'primary' && winner !== 'challenger') {
    throw new Error(`Invalid winner: ${winner}`);
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new Error('Comparison rationale must be a non-empty string');
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
        `Invalid ${key} scores: primary=${dimension.primary}, challenger=${dimension.challenger}. ` +
        'Expected integers from 1 to 10.'
      );
    }
  }
  return { winner, rationale: rationale.trim(), dimensions };
}

function runGh(args: string[], repoDir: string): string {
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

function tryGh(args: string[], repoDir: string, label: string): void {
  try {
    runGh(args, repoDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[compare-prs] ${label} failed: ${message}`);
  }
}

function withBodyFile<T>(body: string, fn: (filePath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-compare-'));
  const filePath = join(dir, 'body.txt');
  writeFileSync(filePath, body, 'utf-8');
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

runTool({
  name: 'compare-prs',
  description: 'Compare two challenge-mode PRs and persist a structured recommendation.',
  options: {
    issue: { type: 'string', description: 'Linear issue identifier' },
    'pair-id': { type: 'string', description: 'Challenge pair identifier' },
    'primary-pr': { type: 'string', description: 'Primary PR number or URL' },
    'challenger-pr': { type: 'string', description: 'Challenger PR number or URL' },
    'primary-model': { type: 'string', description: 'Primary solution model' },
    'challenger-model': { type: 'string', description: 'Challenger solution model' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
    model: { type: 'string', description: 'Comparison judge model override' },
    comment: { type: 'boolean', description: 'Post recommendation comments on both PRs' },
    'auto-merge': { type: 'boolean', description: 'Merge winner and close loser after comparison' },
  },
  async run({ args }) {
    const repoDir = (args['repo-dir'] as string) || process.cwd();
    const issueId = args.issue as string;
    const pairId = args['pair-id'] as string;
    const primaryPr = args['primary-pr'] as string;
    const challengerPr = args['challenger-pr'] as string;
    const primaryModel = args['primary-model'] as string;
    const challengerModel = args['challenger-model'] as string;
    if (!issueId || !pairId || !primaryPr || !challengerPr || !primaryModel || !challengerModel) {
      throw new Error('Missing required arguments for compare-prs');
    }

    const config = loadWavemillConfig(repoDir);
    const comparisonModel = (args.model as string) || config.challenge?.comparisonModel || 'claude-opus-4-6';
    const issuePrompt = formatIssueAsPrompt(fetchIssueData(issueId, repoDir), issueId);
    const primaryNumber = prNumberFromValue(primaryPr);
    const challengerNumber = prNumberFromValue(challengerPr);
    const primaryPrUrl = prUrlFromNumber(primaryPr, repoDir);
    const challengerPrUrl = prUrlFromNumber(challengerPr, repoDir);
    const primaryDiff = fetchPrContext(primaryNumber, repoDir).diff;
    const challengerDiff = fetchPrContext(challengerNumber, repoDir).diff;
    const evals = readEvalRecords();
    const primaryEval = evals.find((record) => record.challengePairId === pairId && record.prUrl === primaryPrUrl);
    const challengerEval = evals.find((record) => record.challengePairId === pairId && record.prUrl === challengerPrUrl);
    if (!primaryEval || !challengerEval) {
      throw new Error(`Missing eval records for challenge pair ${pairId}`);
    }
    if (typeof primaryEval.score !== 'number' || typeof challengerEval.score !== 'number') {
      throw new Error(`Invalid eval scores for challenge pair ${pairId}`);
    }

    const prompt = buildPrompt({
      issuePrompt,
      primaryDiff,
      challengerDiff,
      primaryEvalScore: primaryEval.score,
      challengerEvalScore: challengerEval.score,
    });
    const response = await callClaude(prompt, {
      mode: 'sync',
      model: comparisonModel,
      timeout: 180_000,
      retry: true,
      maxRetries: 2,
    });
    const verdict = validateComparisonJson(parseJsonFromLLM(response.text));
    const winnerModel = verdict.winner === 'primary' ? primaryModel : challengerModel;

    const record: ChallengeComparison = {
      challengePairId: pairId,
      primaryModel,
      challengerModel,
      primaryPrUrl,
      challengerPrUrl,
      primaryEvalScore: primaryEval.score,
      challengerEvalScore: challengerEval.score,
      winner: verdict.winner,
      winnerModel,
      rationale: verdict.rationale,
      dimensions: verdict.dimensions,
      timestamp: new Date().toISOString(),
    };

    appendChallengeComparison(record);

    const commentBody = [
      `Challenge comparison for \`${pairId}\``,
      ``,
      `Recommended winner: ${record.winner} (${record.winnerModel})`,
      `Other PR: ${record.winner === 'primary' ? challengerPrUrl : primaryPrUrl}`,
      ``,
      record.rationale,
    ].join('\n');

    if (args.comment || config.challenge?.autoMergeWinner) {
      withBodyFile(commentBody, (bodyFile) => {
        tryGh(['pr', 'comment', primaryNumber, '--body-file', bodyFile], repoDir, `comment primary PR ${primaryNumber}`);
        tryGh(['pr', 'comment', challengerNumber, '--body-file', bodyFile], repoDir, `comment challenger PR ${challengerNumber}`);
      });
    }

    if (args['auto-merge'] || config.challenge?.autoMergeWinner) {
      const winnerNumber = record.winner === 'primary' ? primaryNumber : challengerNumber;
      const loserNumber = record.winner === 'primary' ? challengerNumber : primaryNumber;
      tryGh(['pr', 'merge', winnerNumber, '--merge', '--delete-branch=false'], repoDir, `merge winner PR ${winnerNumber}`);
      withBodyFile(`Closing after challenge comparison. Recommended winner: ${record.winnerModel}`, (bodyFile) => {
        tryGh(['pr', 'comment', loserNumber, '--body-file', bodyFile], repoDir, `comment loser PR ${loserNumber}`);
      });
      tryGh(['pr', 'close', loserNumber], repoDir, `close loser PR ${loserNumber}`);
    }

    console.log(JSON.stringify(record, null, 2));
  },
});
