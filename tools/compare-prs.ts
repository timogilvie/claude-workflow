#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { callClaude, parseJsonFromLLM } from '../shared/lib/llm-cli.ts';
import { fetchIssueData, formatIssueAsPrompt, fetchPrContext } from '../shared/lib/eval-context-gatherer.ts';
import { hasChallengeEvalRecordPair, readEvalRecords } from '../shared/lib/eval-persistence.ts';
import {
  appendChallengeComparison,
  buildInvalidChallengeComparison,
  buildInvalidProvenanceComparison,
  buildSkippedIdenticalComparison,
  detectVariedDimensions,
  hasAnyVariedDimension,
  classifyChallengeType,
  resolveChallengeSideExecutionProvenance,
  validateChallengeExecutionProvenance,
  type ChallengeComparison,
  type ChallengeRoutingMeta,
} from '../shared/lib/challenge-comparison.ts';
import {
  routesIdentical,
  type InvalidChallengeReason,
} from '../shared/lib/challenge-execution-contract.ts';
import {
  selectChallengeEvalScore,
} from '../shared/lib/challenge-score-selector.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import {
  buildChallengeCommentBody,
  buildCappedComparisonPrompt,
  formatRoutingSummary,
  mapBlindVerdictToSides,
  prNumberFromValue,
  prUrlFromNumber,
  resolvePrDiffIdentity,
  resolvePresentationOrder,
  retainLoserPatch,
  tryGh,
  validateComparisonJson,
  withBodyFile,
  type ValidatedComparisonResult,
} from '../shared/lib/pr-comparison.ts';
import { writeJobResultFile } from '../shared/lib/job-tracker.ts';
import type { ChallengeStage } from '../shared/lib/challenge-mode.ts';

type ComparisonForkDescriptor = Pick<
  ChallengeComparison,
  | 'forkStage'
  | 'forkCommit'
  | 'sharedPrefix'
  | 'primaryInheritedStages'
  | 'challengerInheritedStages'
>;

type ChallengeIntentForkShape = {
  forkStage?: unknown;
  forkCommit?: unknown;
  sharedPrefix?: unknown;
  primary?: { inheritedStages?: unknown };
  challenger?: { inheritedStages?: unknown };
};

const CHALLENGE_STAGES = new Set<ChallengeStage>(['plan', 'implementation', 'review']);

function isChallengeStage(value: unknown): value is ChallengeStage {
  return typeof value === 'string' && CHALLENGE_STAGES.has(value as ChallengeStage);
}

function intentObject(value: unknown): ChallengeIntentForkShape | undefined {
  return value && typeof value === 'object' ? value as ChallengeIntentForkShape : undefined;
}

function inheritedStages(value: unknown): ChallengeStage[] {
  return Array.isArray(value) ? value.filter(isChallengeStage) : [];
}

function resolveComparisonForkDescriptor(
  primaryIntent: unknown,
  challengerIntent: unknown,
): ComparisonForkDescriptor {
  const primary = intentObject(primaryIntent);
  const challenger = intentObject(challengerIntent);
  const forkStage = isChallengeStage(primary?.forkStage)
    ? primary.forkStage
    : isChallengeStage(challenger?.forkStage)
      ? challenger.forkStage
      : null;
  const forkCommit = typeof primary?.forkCommit === 'string' && primary.forkCommit.trim()
    ? primary.forkCommit.trim()
    : typeof challenger?.forkCommit === 'string' && challenger.forkCommit.trim()
      ? challenger.forkCommit.trim()
      : null;
  return {
    forkStage,
    forkCommit,
    sharedPrefix: primary?.sharedPrefix === true || challenger?.sharedPrefix === true,
    primaryInheritedStages: inheritedStages(primary?.primary?.inheritedStages ?? challenger?.primary?.inheritedStages),
    challengerInheritedStages: inheritedStages(challenger?.challenger?.inheritedStages ?? primary?.challenger?.inheritedStages),
  };
}

function retainComparedLoserPatch(input: {
  record: Pick<ChallengeComparison, 'winner' | 'primaryDiffIdentity' | 'challengerDiffIdentity'>;
  pairId: string;
  evalsDir: string;
  repoDir: string;
}): void {
  const loserIdentity = input.record.winner === 'primary'
    ? input.record.challengerDiffIdentity
    : input.record.winner === 'challenger'
      ? input.record.primaryDiffIdentity
      : undefined;
  if (!loserIdentity) return;
  const result = retainLoserPatch({
    challengePairId: input.pairId,
    loserIdentity,
    evalsDir: input.evalsDir,
    repoDir: input.repoDir,
  });
  if (result.skippedReason === 'too_large') {
    console.warn(`[compare-prs] Loser patch exceeded 10 MiB cap; skipped ${result.path}`);
  } else if (result.skippedReason) {
    console.warn(`[compare-prs] Loser patch retention skipped (${result.skippedReason}) for ${result.path}`);
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
    'primary-feature-dir': { type: 'string', description: 'Primary feature directory containing stage results' },
    'challenger-feature-dir': { type: 'string', description: 'Challenger feature directory containing stage results' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
    model: { type: 'string', description: 'Comparison judge model override' },
    comment: { type: 'boolean', description: 'Post recommendation comments on both PRs' },
    'auto-merge': { type: 'boolean', description: 'Merge winner and close loser after comparison' },
    'check-only': { type: 'boolean', description: 'Only verify required eval records exist' },
    'presentation-order': { type: 'string', description: 'Judge presentation order: primary-first, challenger-first, or random' },
    'result-file': { type: 'string', description: 'Optional path for structured job results' },
  },
  async run({ args }) {
    const resultFile = args['result-file'] as string | undefined;
    let exitCode = 0;
    const repoDir = (args['repo-dir'] as string) || process.cwd();
    const issueId = args.issue as string;
    const pairId = args['pair-id'] as string;
    const primaryPr = args['primary-pr'] as string;
    const challengerPr = args['challenger-pr'] as string;
    const primaryModel = args['primary-model'] as string;
    const challengerModel = args['challenger-model'] as string;
    let recordForResult: ChallengeComparison | undefined;
    try {
      if (!issueId || !pairId || !primaryPr || !challengerPr || !primaryModel || !challengerModel) {
        throw new Error('Missing required arguments for compare-prs');
      }

      const config = loadWavemillConfig(repoDir);
      const comparisonModel = (args.model as string) || 'claude-opus-4-7';
      const issuePrompt = formatIssueAsPrompt(fetchIssueData(issueId, repoDir), issueId);
      const primaryNumber = prNumberFromValue(primaryPr);
      const challengerNumber = prNumberFromValue(challengerPr);
      const primaryPrUrl = prUrlFromNumber(primaryPr, repoDir);
      const challengerPrUrl = prUrlFromNumber(challengerPr, repoDir);
      // The comparison prompt needs each implementation diff.  Keep this
      // retrieval next to the PR normalization so a failed or retried
      // comparison never reaches the judge with undefined diff variables.
      const primaryDiff = fetchPrContext(primaryNumber, repoDir).diff;
      const challengerDiff = fetchPrContext(challengerNumber, repoDir).diff;
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

      const evals = readEvalRecords({ dir: evalsDir });
      const primaryEval = evals.find((record) => record.challengePairId === pairId && record.prUrl === primaryPrUrl);
      const challengerEval = evals.find((record) => record.challengePairId === pairId && record.prUrl === challengerPrUrl);
      if (!primaryEval || !challengerEval) {
        throw new Error(`Missing eval records for challenge pair ${pairId}`);
      }
      if (typeof primaryEval.score !== 'number' || typeof challengerEval.score !== 'number') {
        throw new Error(`Invalid eval scores for challenge pair ${pairId}`);
      }

      const forkDescriptor = resolveComparisonForkDescriptor(
        primaryEval.challengeIntent,
        challengerEval.challengeIntent,
      );
      const primaryDiffIdentity = resolvePrDiffIdentity({
        pr: primaryNumber,
        repoDir,
        forkCommit: forkDescriptor.forkCommit,
      });
      const challengerDiffIdentity = resolvePrDiffIdentity({
        pr: challengerNumber,
        repoDir,
        forkCommit: forkDescriptor.forkCommit,
      });

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

      const variedDimensions = detectVariedDimensions(primaryRouting, challengerRouting);
      const primaryAttestation = primaryEval.challengeExecutionEvidence;
      const challengerAttestation = challengerEval.challengeExecutionEvidence;
      const invalidReason = (primaryEval.challengeDivergenceReason
        || challengerEval.challengeDivergenceReason
        || primaryAttestation?.invalidReason
        || challengerAttestation?.invalidReason) as InvalidChallengeReason | undefined;
      const intentionallyIdentical = primaryEval.challengeIntent?.intentionallyIdentical === true
        || challengerEval.challengeIntent?.intentionallyIdentical === true;

      if (invalidReason || (routesIdentical(primaryRouting, challengerRouting) && !intentionallyIdentical)) {
        const reason = invalidReason || 'identical_effective_route';
        const invalidRecord = buildInvalidChallengeComparison({
          challengePairId: pairId,
          primaryModel,
          challengerModel,
          primaryPrUrl,
          challengerPrUrl,
          primaryEvalScore: primaryEval.score,
          challengerEvalScore: challengerEval.score,
          reason,
          details: primaryEval.challengeExecutionEvidence?.invalidDetails
            || challengerEval.challengeExecutionEvidence?.invalidDetails
            || (reason === 'identical_effective_route'
              ? 'Primary and challenger effective routes are identical without an identical-control intent.'
              : undefined),
          primaryRouting,
          challengerRouting,
          primaryAttestation,
          challengerAttestation,
          ...forkDescriptor,
          primaryDiffIdentity,
          challengerDiffIdentity,
        });
        recordForResult = invalidRecord;
        appendChallengeComparison(invalidRecord, evalsDir);
        console.log(JSON.stringify(invalidRecord, null, 2));
        if (resultFile) {
          writeJobResultFile(resultFile, {
            ok: true,
            exitCode,
            comparison: invalidRecord,
            invalidChallenge: true,
          });
        }
        return;
      }

      const primaryExecution = resolveChallengeSideExecutionProvenance({
        featureDir: args['primary-feature-dir'] as string | undefined,
        repoDir,
        evalRecord: primaryEval,
      });
      const challengerExecution = resolveChallengeSideExecutionProvenance({
        featureDir: args['challenger-feature-dir'] as string | undefined,
        repoDir,
        evalRecord: challengerEval,
      });
      const challengeType = variedDimensions && hasAnyVariedDimension(variedDimensions)
        ? classifyChallengeType(variedDimensions)
        : undefined;
      const variedStage = challengeType === 'planner-only'
        ? 'plan'
        : challengeType === 'reviewer-only'
          ? 'review'
          : challengeType === 'coder-only'
            ? 'implementation'
            : undefined;
      const provenanceValidation = validateChallengeExecutionProvenance({
        primaryExecution,
        challengerExecution,
        primaryRouting,
        challengerRouting,
        primaryModel,
        challengerModel,
        variedDimensions,
        repoDir,
      });

      if (!provenanceValidation.valid) {
        const invalidRecord = buildInvalidProvenanceComparison({
          challengePairId: pairId,
          primaryModel,
          challengerModel,
          primaryPrUrl,
          challengerPrUrl,
          primaryEvalScore: primaryEval.score,
          challengerEvalScore: challengerEval.score,
          primaryRouting,
          challengerRouting,
          primaryExecution,
          challengerExecution,
          provenanceValidation,
          variedDimensions,
          challengeType,
          variedStage,
          ...forkDescriptor,
          primaryDiffIdentity,
          challengerDiffIdentity,
        });
        recordForResult = invalidRecord;
        appendChallengeComparison(invalidRecord, evalsDir);

        const routingSummary = formatRoutingSummary(
          primaryRouting,
          challengerRouting,
          invalidRecord.challengeType,
          primaryExecution,
          challengerExecution,
          provenanceValidation,
        );
        const primaryCommentBody = buildChallengeCommentBody({
          pairId,
          rationale: invalidRecord.rationale,
          otherPrUrl: challengerPrUrl,
          routingSummary,
          provenanceValidation,
        });
        const challengerCommentBody = buildChallengeCommentBody({
          pairId,
          rationale: invalidRecord.rationale,
          otherPrUrl: primaryPrUrl,
          routingSummary,
          provenanceValidation,
        });

        if (args.comment || config.challenge?.autoMergeWinner) {
          withBodyFile(primaryCommentBody, (bodyFile) => {
            tryGh(['pr', 'comment', primaryNumber, '--body-file', bodyFile], repoDir, `comment primary PR ${primaryNumber}`);
          });
          withBodyFile(challengerCommentBody, (bodyFile) => {
            tryGh(['pr', 'comment', challengerNumber, '--body-file', bodyFile], repoDir, `comment challenger PR ${challengerNumber}`);
          });
        }

        console.log(JSON.stringify(invalidRecord, null, 2));
        if (resultFile) {
          writeJobResultFile(resultFile, {
            ok: true,
            exitCode,
            comparison: invalidRecord,
          });
        }
        return;
      }

      if (variedDimensions && !hasAnyVariedDimension(variedDimensions)) {
        const skippedRecord = buildSkippedIdenticalComparison({
          challengePairId: pairId,
          primaryModel,
          challengerModel,
          primaryPrUrl,
          challengerPrUrl,
          primaryEvalScore: primaryEval.score,
          challengerEvalScore: challengerEval.score,
          primaryRouting,
          challengerRouting,
          ...forkDescriptor,
          primaryDiffIdentity,
          challengerDiffIdentity,
        });
        skippedRecord.primaryExecution = primaryExecution;
        skippedRecord.challengerExecution = challengerExecution;
        skippedRecord.provenanceValidation = provenanceValidation;
        recordForResult = skippedRecord;
        appendChallengeComparison(skippedRecord, evalsDir);
        retainComparedLoserPatch({
          record: skippedRecord,
          pairId,
          evalsDir,
          repoDir,
        });

        const routingSummary = formatRoutingSummary(
          primaryRouting,
          challengerRouting,
          skippedRecord.challengeType,
          primaryExecution,
          challengerExecution,
          provenanceValidation,
        );
        const primaryCommentBody = buildChallengeCommentBody({
          pairId,
          winner: skippedRecord.winner,
          winnerModel: skippedRecord.winnerModel,
          rationale: skippedRecord.rationale,
          otherPrUrl: challengerPrUrl,
          routingSummary,
        });
        const challengerCommentBody = buildChallengeCommentBody({
          pairId,
          winner: skippedRecord.winner,
          winnerModel: skippedRecord.winnerModel,
          rationale: skippedRecord.rationale,
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
          tryGh(['pr', 'merge', primaryNumber, '--merge', '--delete-branch=false'], repoDir, `merge winner PR ${primaryNumber}`);
          withBodyFile('Closing after skipped challenge comparison. Routing dimensions were identical.', (bodyFile) => {
            tryGh(['pr', 'comment', challengerNumber, '--body-file', bodyFile], repoDir, `comment loser PR ${challengerNumber}`);
          });
          tryGh(['pr', 'close', challengerNumber], repoDir, `close loser PR ${challengerNumber}`);
        }

        console.log(JSON.stringify(skippedRecord, null, 2));
        if (resultFile) {
          writeJobResultFile(resultFile, {
            ok: true,
            exitCode,
            comparison: skippedRecord,
          });
        }
        return;
      }
      const primarySelected = selectChallengeEvalScore(primaryEval, challengeType);
      const challengerSelected = selectChallengeEvalScore(challengerEval, challengeType);

      const dataQualityWarnings: string[] = [];
      if (primarySelected.warning) dataQualityWarnings.push(`primary: ${primarySelected.warning}`);
      if (challengerSelected.warning) dataQualityWarnings.push(`challenger: ${challengerSelected.warning}`);
      if (dataQualityWarnings.length > 0) {
        console.warn(`[compare-prs] Data quality warnings for ${pairId}:`);
        for (const w of dataQualityWarnings) console.warn(`  ${w}`);
      }

      const primaryStageEval = primaryEval.challengeStageEval;
      const challengerStageEval = challengerEval.challengeStageEval;
      const stageEvidenceMode = (
        (challengeType === 'planner-only' || challengeType === 'reviewer-only')
          ? (
              primaryStageEval?.provenance === 'direct' && challengerStageEval?.provenance === 'direct'
                ? 'direct'
                : 'inferred-fallback'
            )
          : 'not-applicable'
      ) as const;

      if (challengeType === 'planner-only' || challengeType === 'reviewer-only') {
        console.log(
          `[compare-prs] pair=${pairId} varied_stage=${variedStage} stage_evidence=${stageEvidenceMode} primary_pr=${primaryNumber} challenger_pr=${challengerNumber}`
        );
      }

      const presentationOrder = resolvePresentationOrder(args['presentation-order'] as string | undefined);
      console.log(
        `[compare-prs] pair=${pairId} presentation_order=${presentationOrder} primary_pr=${primaryNumber} challenger_pr=${challengerNumber}`
      );

      const promptLimit = Number.parseInt(process.env.CHALLENGE_COMPARISON_MAX_PROMPT_BYTES || '500000', 10);
      const cappedPrompt = buildCappedComparisonPrompt({
        issuePrompt,
        primaryDiff,
        challengerDiff,
        presentationOrder,
        primaryRouting,
        challengerRouting,
        challengeType,
        primaryStageEval,
        challengerStageEval,
        primaryExecution,
        challengerExecution,
      }, Number.isFinite(promptLimit) ? promptLimit : 500000);
      if (cappedPrompt.truncated) {
        console.warn(
          `Comparison prompt truncated from ${cappedPrompt.originalBytes} to ${cappedPrompt.finalBytes} bytes`,
        );
      }
      const prompt = cappedPrompt.prompt;
      let response = await callClaude(prompt, {
        mode: 'sync',
        model: comparisonModel,
        timeout: 180_000,
        retry: true,
        maxRetries: 2,
      });
      let verdict: ValidatedComparisonResult;
      try {
        verdict = mapBlindVerdictToSides(
          validateComparisonJson(parseJsonFromLLM(response.text)),
          presentationOrder,
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('JavaScript code instead of JSON')) {
          throw error;
        }

        console.warn('LLM returned JavaScript syntax. Retrying with stricter JSON instructions...');
        const stricterPrompt = `${prompt}

IMPORTANT: Return ONLY valid JSON. Do NOT use:
- JavaScript shorthand properties (use "key": value, not key)
- Spread syntax (...rest)
- Unquoted property names
- Code comments or explanations

Return a raw JSON object with no code fences, no comments, and no JavaScript syntax.`;
        response = await callClaude(stricterPrompt, {
          mode: 'sync',
          model: comparisonModel,
          timeout: 180_000,
          retry: false,
        });
        verdict = mapBlindVerdictToSides(
          validateComparisonJson(parseJsonFromLLM(response.text)),
          presentationOrder,
        );
      }

      // Attribute the win to the varied stage's model. For planner/reviewer
      // challenges the coder is shared, so crediting it would be meaningless.
      const winnerRouting = verdict.winner === 'primary' ? primaryRouting : challengerRouting;
      const winnerSolutionModel = verdict.winner === 'primary' ? primaryModel : challengerModel;
      const winnerModel = challengeType === 'planner-only'
        ? (winnerRouting?.planner || winnerSolutionModel)
        : challengeType === 'reviewer-only'
          ? (winnerRouting?.reviewer || winnerSolutionModel)
          : winnerSolutionModel;

      const record: ChallengeComparison = {
        challengePairId: pairId,
        primaryModel,
        challengerModel,
        primaryPrUrl,
        challengerPrUrl,
        primaryEvalScore: primarySelected.score,
        challengerEvalScore: challengerSelected.score,
        winner: verdict.winner,
        winnerModel,
        rationale: verdict.rationale,
        dimensions: verdict.dimensions,
        timestamp: new Date().toISOString(),
        primaryRouting,
        challengerRouting,
        primaryExecution,
        challengerExecution,
        provenanceValidation,
        variedDimensions,
        challengeType,
        variedStage,
        stageEvidenceMode,
        presentationOrder,
        workflowInsight: verdict.workflowInsight,
        primaryEvalScoreSource: primarySelected.source,
        challengerEvalScoreSource: challengerSelected.source,
        ...(dataQualityWarnings.length > 0 ? { dataQualityWarnings } : {}),
        comparisonOutcome: 'compared',
        ...forkDescriptor,
        primaryDiffIdentity,
        challengerDiffIdentity,
      };
      recordForResult = record;

      appendChallengeComparison(record, evalsDir);
      retainComparedLoserPatch({
        record,
        pairId,
        evalsDir,
        repoDir,
      });

      const routingSummary = formatRoutingSummary(
        primaryRouting,
        challengerRouting,
        challengeType,
        primaryExecution,
        challengerExecution,
        provenanceValidation,
      );
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
    } catch (error) {
      exitCode = 1;
      if (resultFile) {
        writeJobResultFile(resultFile, {
          ok: false,
          exitCode,
          reason: error instanceof Error ? error.message : 'comparison_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }

    if (resultFile) {
      writeJobResultFile(resultFile, {
        ok: true,
        exitCode,
        comparison: recordForResult,
      });
    }
  },
});
