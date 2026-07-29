#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import {
  pickChallengeModelsWithReason,
  pickChallengeWorkflowsWithContextAndReason,
  pickChallengeWorkflowsWithReason,
  getChallengeModelPool,
  canRunChallenge,
  chooseChallengeStage,
  decideChallengeLaunch,
  extractChallengeRecommendation,
  variedModelForStage,
  type ChallengePairSelection,
  type ChallengeNativeRejection,
  type ChallengeTaskEntry,
  type ChallengeSelectionSource,
} from '../shared/lib/challenge-mode.ts';
import type { ModelExclusionDiagnostic } from '../shared/lib/model-exclusions.ts';
import { buildEvalSummary, modelStageCount } from '../shared/lib/challenge-scheduler.ts';
import { resolveAgent } from '../shared/lib/model-router.ts';
import { readBothRouteArtifacts } from '../shared/lib/route-artifact.ts';
import { readTaskPromptFromFile } from '../shared/lib/workflow-router.ts';

function buildChallengeExecutionIntent(input: {
  issue: string;
  slug: string;
  pair: ChallengePairSelection;
  selectionSource: string;
  nativeCertificationRejections?: ChallengeNativeRejection[];
  modelExclusions?: ModelExclusionDiagnostic[];
  noChallengeReason?: string;
}) {
  const sideIntent = (entry: ChallengeTaskEntry) => ({
    key: entry.key,
    issueId: entry.issueId,
    slug: entry.slug,
    branch: entry.branch,
    role: entry.role,
    planner: {
      model: entry.planner || '',
      agent: entry.plannerAgent || '',
    },
    coder: {
      model: entry.model || '',
      agent: entry.agent || '',
    },
    reviewer: {
      model: entry.reviewer || '',
      agent: entry.reviewerAgent || '',
    },
    planDepth: entry.planDepth || '',
    codeDepth: entry.codeDepth || '',
    reviewMode: entry.reviewMode || '',
  });

  return {
    schemaVersion: 1,
    pairId: input.pair.pairId,
    issueId: input.issue,
    slug: input.slug,
    selectedStage: input.pair.challengeStage || 'implementation',
    selectionSource: input.selectionSource,
    primary: sideIntent(input.pair.primary),
    challenger: sideIntent(input.pair.challenger),
    ...(input.nativeCertificationRejections && input.nativeCertificationRejections.length > 0
      ? { nativeCertificationRejections: input.nativeCertificationRejections }
      : {}),
    ...(input.modelExclusions && input.modelExclusions.length > 0
      ? { modelExclusions: input.modelExclusions }
      : {}),
    ...(input.noChallengeReason ? { noChallengeReason: input.noChallengeReason } : {}),
  };
}

runTool({
  name: 'resolve-challenge-task',
  description: 'Resolve whether a mill task should run in challenge mode and return the launch plan.',
  options: {
    issue: { type: 'string', description: 'Task key / issue identifier' },
    slug: { type: 'string', description: 'Base task slug' },
    title: { type: 'string', description: 'Task title' },
    'force-model': { type: 'string', description: 'Explicit forced model; disables challenge mode when non-empty' },
    'primary-model': { type: 'string', description: 'Router-selected or forced primary model' },
    'remaining-slots': { type: 'string', description: 'Available mill slots before launch' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
    file: { type: 'string', description: 'Task packet file path (for routing)' },
    'feature-dir': { type: 'string', description: 'Feature directory for reading route artifacts' },
  },
  async run({ args }) {
    const repoDir = (args['repo-dir'] as string) || process.cwd();
    const issue = args.issue as string;
    const slug = args.slug as string;
    const title = args.title as string;
    const forceModel = (args['force-model'] as string | undefined)?.trim() || undefined;
    const primaryModel = (args['primary-model'] as string | undefined)?.trim() || undefined;
    const remainingSlots = Number(args['remaining-slots'] || '1');
    const taskFile = args.file as string | undefined;
    const featureDir = args['feature-dir'] as string | undefined;

    if (!issue || !slug || !title) {
      throw new Error('--issue, --slug, and --title are required');
    }

    const config = loadWavemillConfig(repoDir);
    const challenge = config.challenge || {};
    const router = config.router || {};
    const defaultAgent = router.defaultAgent || 'claude';
    const pool = getChallengeModelPool(challenge, router);

    const singleAgent = primaryModel
      ? resolveAgent(primaryModel, router.agentMap || {}, defaultAgent, repoDir, 'coding')
      : defaultAgent;

    const base = {
      issue,
      slug,
      title,
      mode: 'single',
      slotsRequired: 1,
      decisionSource: 'bootstrap',
      reason: 'challenge_disabled',
      single: {
        key: issue,
        issueId: issue,
        slug,
        branch: `task/${slug}`,
        role: 'primary',
        model: primaryModel || '',
        agent: singleAgent,
      },
    };

    if (forceModel) {
      console.log(JSON.stringify({ ...base, reason: 'forced_model' }));
      return;
    }

    if (challenge.enabled !== true) {
      console.log(JSON.stringify(base));
      return;
    }

    if (remainingSlots < 2) {
      console.log(JSON.stringify({ ...base, reason: 'insufficient_slots' }));
      return;
    }

    if (!canRunChallenge(pool)) {
      console.log(JSON.stringify({ ...base, reason: 'insufficient_models' }));
      return;
    }

    const routeArtifacts = featureDir
      ? readBothRouteArtifacts(featureDir)
      : { bootstrap: null, expanded: null };
    const hasUsableRoute = Boolean(routeArtifacts.bootstrap || routeArtifacts.expanded);
    const recommendation = extractChallengeRecommendation(routeArtifacts);

    const launchDecision = decideChallengeLaunch({
      pool,
      primaryModel,
      rate: challenge.rate ?? 0.10,
      recommendationRate: challenge.recommendationRate,
      recommendation,
    });

    if (!launchDecision.launch) {
      console.log(JSON.stringify({
        ...base,
        reason: 'roll_not_selected',
        selectionPath: launchDecision.selectionPath,
        selectionSource: launchDecision.selectionSource,
        requiresRefresh: !hasUsableRoute,
      }));
      return;
    }

    const forcedChallengerModel = launchDecision.forcedChallengerModel;

    // A recommendation carrying a stage (low-data-stage, or new-model with a
    // least-covered cell) pins the varied stage; otherwise sample from the
    // configured weights (implementation-only by default).
    const challengeStage = chooseChallengeStage({
      weights: challenge.stageWeights,
      recommendedStage: launchDecision.recommendation?.stage,
      routeArtifactsAvailable: hasUsableRoute,
    });
    const summary = buildEvalSummary(repoDir);
    const coverage = (model: string, stage: 'plan' | 'implementation' | 'review') =>
      modelStageCount(summary, model, stage);
    const rotationSeed = `${issue}|${challengeStage}`;
    const recommendedChallengerModel = launchDecision.recommendation?.challengerModel;

    // If task file provided, use workflow routing for both sides
    let selectionFailureReason = 'selection_failed';
    let pair;
    let nativeCertificationRejections: ChallengeNativeRejection[] | undefined;
    let modelExclusions: ModelExclusionDiagnostic[] | undefined;

    if (featureDir) {
      const selection = pickChallengeWorkflowsWithContextAndReason(pool, {
        pairId: issue,
        issueId: issue,
        slug,
        prompt: title,
        primaryModel,
        forcedChallengerModel,
          challengeStage,
          agentMap: router.agentMap,
          defaultAgent,
          repoDir,
          coverage,
          rotationSeed,
          recommendedChallengerModel,
        }, routeArtifacts);
      pair = selection.pair;
      selectionFailureReason = selection.failureReason || selectionFailureReason;
      nativeCertificationRejections = selection.nativeCertificationRejections;
      modelExclusions = selection.modelExclusions;
    }

    if (!pair && taskFile) {
      try {
        const prompt = readTaskPromptFromFile(taskFile);
        const selection = pickChallengeWorkflowsWithReason(pool, {
          pairId: issue,
          issueId: issue,
          slug,
          prompt,
          primaryModel,
          forcedChallengerModel,
          challengeStage,
          agentMap: router.agentMap,
          defaultAgent,
          repoDir,
          coverage,
          rotationSeed,
          recommendedChallengerModel,
        });
        pair = selection.pair;
        selectionFailureReason = selection.failureReason || selectionFailureReason;
        nativeCertificationRejections = [
          ...(nativeCertificationRejections || []),
          ...(selection.nativeCertificationRejections || []),
        ];
        modelExclusions = [
          ...(modelExclusions || []),
          ...(selection.modelExclusions || []),
        ];
      } catch (error) {
        // Fall back to model-only selection if task file is unreadable
        console.error(`Warning: Failed to read task file for routing: ${error}`);
        const selection = pickChallengeModelsWithReason(pool, {
          pairId: issue,
          issueId: issue,
          slug,
          primaryModel,
          forcedChallengerModel,
          agentMap: router.agentMap,
          defaultAgent,
          repoDir,
          coverage,
          rotationSeed,
          recommendedChallengerModel,
        });
        pair = selection.pair;
        selectionFailureReason = selection.failureReason || selectionFailureReason;
        nativeCertificationRejections = [
          ...(nativeCertificationRejections || []),
          ...(selection.nativeCertificationRejections || []),
        ];
        modelExclusions = [
          ...(modelExclusions || []),
          ...(selection.modelExclusions || []),
        ];
      }
    } else if (!pair) {
      // No task file provided - use model-only selection (backward compatibility)
      const selection = pickChallengeModelsWithReason(pool, {
        pairId: issue,
        issueId: issue,
        slug,
        primaryModel,
        forcedChallengerModel,
        agentMap: router.agentMap,
        defaultAgent,
        repoDir,
        coverage,
        rotationSeed,
        recommendedChallengerModel,
      });
      pair = selection.pair;
      selectionFailureReason = selection.failureReason || selectionFailureReason;
      nativeCertificationRejections = [
        ...(nativeCertificationRejections || []),
        ...(selection.nativeCertificationRejections || []),
      ];
      modelExclusions = [
        ...(modelExclusions || []),
        ...(selection.modelExclusions || []),
      ];
    }

    // Emit human-readable warnings for skipped native models (mirrors router reasoning output)
    if (nativeCertificationRejections && nativeCertificationRejections.length > 0) {
      const roleToStage: Record<string, string> = { planner: 'plan', coder: 'implementation', reviewer: 'review' };
      for (const rejection of nativeCertificationRejections) {
        const stage = roleToStage[rejection.role] || rejection.role;
        const details = [
          `launchPhase=${rejection.requestedLaunchPhase}`,
          `certPhase=${rejection.requestedPhase}`,
          `reason=${rejection.reason}`,
          `provider=${rejection.nativeProvider ?? 'unknown'}`,
        ];
        if (rejection.eligibleRoles) {
          details.push(`eligibleRoles=${rejection.eligibleRoles.join(',') || 'none'}`);
        }
        if (rejection.allowedNativeAgentPhases) {
          details.push(`allowedNativeAgentPhases=${rejection.allowedNativeAgentPhases.join(',') || 'none'}`);
        }
        process.stderr.write(
          `Challenge skipped native model ${rejection.modelId} for ${stage} stage (${details.join(', ')}).\n`,
        );
      }
    }

    if (!pair) {
      const selectionSource: ChallengeSelectionSource = (modelExclusions || []).length > 0
        ? 'model-exclusion'
        : (nativeCertificationRejections || []).length > 0
          ? 'eligibility-rejection'
          : 'no-challenge';
      console.log(JSON.stringify({
        ...base,
        reason: selectionFailureReason,
        selectionSource,
        noChallengeReason: selectionFailureReason,
        requiresRefresh: !hasUsableRoute,
        ...(nativeCertificationRejections && nativeCertificationRejections.length > 0
          ? { nativeCertificationRejections }
          : {}),
        ...(modelExclusions && modelExclusions.length > 0 ? { modelExclusions } : {}),
      }));
      return;
    }

    // The pair may have fallen back to coder variation (no route context, or
    // route missing the requested stage model) — report the effective stage.
    const effectiveStage = pair.challengeStage || 'implementation';
    const challengerVaried = variedModelForStage(pair.challenger, effectiveStage);
    const challengerSource = pair.selectionReason || (
      forcedChallengerModel && challengerVaried === forcedChallengerModel
        ? 'recommendation'
        : 'random'
    );
    const selectionSource = pair.routeContext?.selectionSource || launchDecision.selectionSource;
    const challengeExecutionIntent = buildChallengeExecutionIntent({
      issue,
      slug,
      pair,
      selectionSource,
      nativeCertificationRejections,
      modelExclusions,
    });

    console.log(JSON.stringify({
      issue,
      slug,
      title,
      mode: 'challenge',
      slotsRequired: 2,
      decisionSource: pair.routeContext?.decisionSource || 'bootstrap',
      reason: 'selected',
      primaryModel,
      selectionPath: launchDecision.selectionPath,
      selectionSource,
      requiresRefresh: !hasUsableRoute,
      challengerSource,
      selectionReason: pair.selectionReason,
      coverageCount: pair.challengerCoverageCount,
      challengeStage: effectiveStage,
      challengeExecutionIntent,
      ...(launchDecision.recommendation
        ? {
            challengeRecommendation: {
              reason: launchDecision.recommendation.reason,
              challengerModel: launchDecision.recommendation.challengerModel,
              defaultModel: launchDecision.recommendation.defaultModel,
              stage: launchDecision.recommendation.stage,
            },
          }
        : {}),
      ...(nativeCertificationRejections && nativeCertificationRejections.length > 0
        ? { nativeCertificationRejections }
        : {}),
      ...(modelExclusions && modelExclusions.length > 0 ? { modelExclusions } : {}),
      routeContext: pair.routeContext,
      entries: [
        { ...pair.primary, variedModel: variedModelForStage(pair.primary, effectiveStage) },
        { ...pair.challenger, variedModel: challengerVaried },
      ],
    }));
  },
});
