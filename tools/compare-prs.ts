#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { callClaude, parseJsonFromLLM } from '../shared/lib/llm-cli.ts';
import { fetchIssueData, formatIssueAsPrompt, fetchPrContext } from '../shared/lib/eval-context-gatherer.ts';
import { hasChallengeEvalRecordPair, readEvalRecords } from '../shared/lib/eval-persistence.ts';
import {
  appendChallengeComparison,
  detectVariedDimensions,
  classifyChallengeType,
  type ChallengeComparison,
  type ChallengeRoutingMeta,
} from '../shared/lib/challenge-comparison.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import {
  buildChallengeCommentBody,
  buildComparisonPrompt,
  formatRoutingSummary,
  prNumberFromValue,
  prUrlFromNumber,
  tryGh,
  validateComparisonJson,
  withBodyFile,
} from '../shared/lib/pr-comparison.ts';

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
    'primary-planner': { type: 'string', description: 'Primary planner model' },
    'primary-reviewer': { type: 'string', description: 'Primary reviewer model' },
    'primary-plan-depth': { type: 'string', description: 'Primary plan depth' },
    'primary-code-depth': { type: 'string', description: 'Primary code depth' },
    'primary-review-mode': { type: 'string', description: 'Primary review mode' },
    'challenger-planner': { type: 'string', description: 'Challenger planner model' },
    'challenger-reviewer': { type: 'string', description: 'Challenger reviewer model' },
    'challenger-plan-depth': { type: 'string', description: 'Challenger plan depth' },
    'challenger-code-depth': { type: 'string', description: 'Challenger code depth' },
    'challenger-review-mode': { type: 'string', description: 'Challenger review mode' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
    model: { type: 'string', description: 'Comparison judge model override' },
    comment: { type: 'boolean', description: 'Post recommendation comments on both PRs' },
    'auto-merge': { type: 'boolean', description: 'Merge winner and close loser after comparison' },
    'check-only': { type: 'boolean', description: 'Only verify required eval records exist' },
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
    const evalsDir = resolveEvalsDir(undefined, repoDir).dir;
    const hasRequiredEvalRecords = hasChallengeEvalRecordPair(
      pairId,
      primaryPrUrl,
      challengerPrUrl,
      { dir: evalsDir },
    );
    if (!hasRequiredEvalRecords) {
      throw new Error(`Missing eval records for challenge pair ${pairId}`);
    }
    if (args['check-only']) {
      console.log(JSON.stringify({
        pairId,
        primaryPrUrl,
        challengerPrUrl,
        hasRequiredEvalRecords,
      }, null, 2));
      return;
    }

    const primaryDiff = fetchPrContext(primaryNumber, repoDir).diff;
    const challengerDiff = fetchPrContext(challengerNumber, repoDir).diff;
    const evals = readEvalRecords({ dir: evalsDir });
    const primaryEval = evals.find((record) => record.challengePairId === pairId && record.prUrl === primaryPrUrl);
    const challengerEval = evals.find((record) => record.challengePairId === pairId && record.prUrl === challengerPrUrl);
    if (!primaryEval || !challengerEval) {
      throw new Error(`Missing eval records for challenge pair ${pairId}`);
    }
    if (typeof primaryEval.score !== 'number' || typeof challengerEval.score !== 'number') {
      throw new Error(`Invalid eval scores for challenge pair ${pairId}`);
    }

    // Build routing metadata if provided
    const primaryRouting: ChallengeRoutingMeta | undefined = args['primary-planner'] ? {
      planner: (args['primary-planner'] as string) || '',
      coder: primaryModel,
      reviewer: (args['primary-reviewer'] as string) || '',
      planDepth: (args['primary-plan-depth'] as string) || '',
      codeDepth: (args['primary-code-depth'] as string) || '',
      reviewMode: (args['primary-review-mode'] as string) || '',
    } : undefined;

    const challengerRouting: ChallengeRoutingMeta | undefined = args['challenger-planner'] ? {
      planner: (args['challenger-planner'] as string) || '',
      coder: challengerModel,
      reviewer: (args['challenger-reviewer'] as string) || '',
      planDepth: (args['challenger-plan-depth'] as string) || '',
      codeDepth: (args['challenger-code-depth'] as string) || '',
      reviewMode: (args['challenger-review-mode'] as string) || '',
    } : undefined;

    const prompt = buildComparisonPrompt({
      issuePrompt,
      primaryDiff,
      challengerDiff,
      primaryEvalScore: primaryEval.score,
      challengerEvalScore: challengerEval.score,
      primaryRouting,
      challengerRouting,
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

    // Compute enrichment fields
    const variedDimensions = detectVariedDimensions(primaryRouting, challengerRouting);
    const challengeType = variedDimensions ? classifyChallengeType(variedDimensions) : undefined;

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
      primaryRouting,
      challengerRouting,
      variedDimensions,
      challengeType,
      workflowInsight: verdict.workflowInsight,
    };

    appendChallengeComparison(record);

    const routingSummary = formatRoutingSummary(primaryRouting, challengerRouting, challengeType);
    const primaryCommentBody = buildChallengeCommentBody({
      pairId,
      winner: record.winner,
      winnerModel: record.winnerModel,
      rationale: record.rationale,
      otherPrUrl: challengerPrUrl,
      routingSummary,
    });
    const challengerCommentBody = buildChallengeCommentBody({
      pairId,
      winner: record.winner,
      winnerModel: record.winnerModel,
      rationale: record.rationale,
      otherPrUrl: primaryPrUrl,
      routingSummary,
    });

    if (args.comment || config.challenge?.autoMergeWinner) {
      withBodyFile(primaryCommentBody, (bodyFile) => {
        tryGh(['pr', 'comment', primaryNumber, '--body-file', bodyFile], repoDir, `comment primary PR ${primaryNumber}`);
      });
      withBodyFile(challengerCommentBody, (bodyFile) => {
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
