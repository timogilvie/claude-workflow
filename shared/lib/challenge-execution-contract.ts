import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChallengeStage } from './challenge-mode.ts';
import type { ChallengeRoutingMeta } from './challenge-comparison.ts';
import type { EvalRecord, EvalRouting } from './eval-schema.ts';

export type ChallengeValidity = 'valid' | 'invalid_challenge' | 'identical_control';
export type InvalidChallengeReason =
  | 'stage_override_lost'
  | 'native_launch_fallback'
  | 'identical_effective_route';

export interface ChallengeSideIntent {
  pairId: string;
  side: 'primary' | 'challenger';
  challengeStage: ChallengeStage;
  expectedStageModel: string;
  expectedStageAgent?: string;
  expectedRoute: ChallengeRoutingMeta;
}

export interface ChallengeExecutionIntent {
  pairId: string;
  challengeStage: ChallengeStage;
  intentionallyIdentical?: boolean;
  routeContext?: unknown;
  selectionReason?: string;
  primary: ChallengeSideIntent;
  challenger: ChallengeSideIntent;
}

export interface ChallengeStageEvidence {
  stage: ChallengeStage;
  agent?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  fallbackReason?: string;
  source?: string;
}

export interface ChallengeExecutionAttestation {
  pairId: string;
  side: 'primary' | 'challenger';
  validity: ChallengeValidity;
  challengeStage: ChallengeStage;
  expectedStageModel: string;
  expectedStageAgent?: string;
  effectiveRoute?: ChallengeRoutingMeta;
  evidence: ChallengeStageEvidence[];
  invalidReason?: InvalidChallengeReason;
  invalidDetails?: string;
}

type ChallengeEntryLike = {
  model?: string;
  agent?: string;
  planner?: string;
  plannerAgent?: string;
  reviewer?: string;
  reviewerAgent?: string;
  planDepth?: string;
  codeDepth?: string;
  reviewMode?: string;
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function routeFromEntry(entry: ChallengeEntryLike): ChallengeRoutingMeta {
  return {
    planner: clean(entry.planner),
    coder: clean(entry.model),
    reviewer: clean(entry.reviewer),
    planDepth: clean(entry.planDepth),
    codeDepth: clean(entry.codeDepth),
    reviewMode: clean(entry.reviewMode),
  };
}

function stageModel(entry: ChallengeEntryLike, stage: ChallengeStage): string {
  if (stage === 'plan') return clean(entry.planner) || clean(entry.model);
  if (stage === 'review') return clean(entry.reviewer) || clean(entry.model);
  return clean(entry.model);
}

function stageAgent(entry: ChallengeEntryLike, stage: ChallengeStage): string | undefined {
  const value = stage === 'plan'
    ? clean(entry.plannerAgent) || clean(entry.agent)
    : stage === 'review'
      ? clean(entry.reviewerAgent) || clean(entry.agent)
      : clean(entry.agent);
  return value || undefined;
}

export function buildChallengeExecutionIntent(input: {
  pairId: string;
  challengeStage: ChallengeStage;
  primary: ChallengeEntryLike;
  challenger: ChallengeEntryLike;
  routeContext?: unknown;
  selectionReason?: string;
  intentionallyIdentical?: boolean;
}): ChallengeExecutionIntent {
  const primaryRoute = routeFromEntry(input.primary);
  const challengerRoute = routeFromEntry(input.challenger);
  return {
    pairId: input.pairId,
    challengeStage: input.challengeStage,
    ...(input.intentionallyIdentical ? { intentionallyIdentical: true } : {}),
    ...(input.routeContext ? { routeContext: input.routeContext } : {}),
    ...(input.selectionReason ? { selectionReason: input.selectionReason } : {}),
    primary: {
      pairId: input.pairId,
      side: 'primary',
      challengeStage: input.challengeStage,
      expectedStageModel: stageModel(input.primary, input.challengeStage),
      ...(stageAgent(input.primary, input.challengeStage) ? { expectedStageAgent: stageAgent(input.primary, input.challengeStage) } : {}),
      expectedRoute: primaryRoute,
    },
    challenger: {
      pairId: input.pairId,
      side: 'challenger',
      challengeStage: input.challengeStage,
      expectedStageModel: stageModel(input.challenger, input.challengeStage),
      ...(stageAgent(input.challenger, input.challengeStage) ? { expectedStageAgent: stageAgent(input.challenger, input.challengeStage) } : {}),
      expectedRoute: challengerRoute,
    },
  };
}

export function routingMetaFromRawRoute(raw: unknown): ChallengeRoutingMeta | undefined {
  const data = raw as Record<string, unknown> | null | undefined;
  if (!data) return undefined;
  return {
    planner: clean(data.planner),
    coder: clean(data.coder),
    reviewer: clean(data.reviewer),
    planDepth: clean(data.planDepth),
    codeDepth: clean(data.codeDepth),
    reviewMode: clean(data.reviewMode ?? data.reviewRecommended),
  };
}

export function modelForChallengeStage(route: ChallengeRoutingMeta | undefined, stage: ChallengeStage): string {
  if (!route) return '';
  if (stage === 'plan') return clean(route.planner);
  if (stage === 'review') return clean(route.reviewer);
  return clean(route.coder);
}

export function routesIdentical(a: ChallengeRoutingMeta | undefined, b: ChallengeRoutingMeta | undefined): boolean {
  if (!a || !b) return false;
  return a.planner === b.planner
    && a.coder === b.coder
    && a.reviewer === b.reviewer
    && a.planDepth === b.planDepth
    && a.codeDepth === b.codeDepth
    && a.reviewMode === b.reviewMode;
}

function sideIntentFromRecord(record: EvalRecord): ChallengeSideIntent | undefined {
  const intent = record.challengeIntent;
  if (!intent || !record.challengeSide) return undefined;
  return record.challengeSide === 'challenger' ? intent.challenger : intent.primary;
}

function stageRole(stage: ChallengeStage): keyof EvalRouting {
  return stage === 'plan' ? 'planner' : stage === 'review' ? 'reviewer' : 'coder';
}

export function attestEvalRecordChallengeExecution(record: EvalRecord): ChallengeExecutionAttestation | undefined {
  const sideIntent = sideIntentFromRecord(record);
  if (!sideIntent) return undefined;

  const effectiveRoute = record.challengeExecutionRoute
    ?? routingMetaFromRawRoute(record.routeProvenance?.activeRoute)
    ?? routingMetaFromRawRoute((record.taskDescriptor as { route?: unknown } | undefined)?.route);
  const role = stageRole(sideIntent.challengeStage);
  const routing = record.routing?.[role];
  const evidence: ChallengeStageEvidence[] = [];
  if (routing) {
    evidence.push({
      stage: sideIntent.challengeStage,
      requestedModel: String(routing.requestedSelector ?? ''),
      resolvedModel: routing.resolvedModelId,
      fallbackReason: routing.fallbackReason,
      source: 'routing.jsonl',
    });
  }
  if (sideIntent.challengeStage === 'plan' && record.executedPlanning) {
    evidence.push({
      stage: 'plan',
      agent: record.executedPlanning.agent,
      model: record.executedPlanning.model,
      source: record.executedPlanning.source,
    });
  } else if (sideIntent.challengeStage === 'implementation' && record.modelId) {
    evidence.push({
      stage: 'implementation',
      agent: record.agentType,
      model: record.modelId,
      source: 'eval.modelId',
    });
  } else if ((sideIntent.challengeStage === 'plan' || sideIntent.challengeStage === 'review') && record.challengeStageEval) {
    for (const item of record.challengeStageEval.evidence) {
      evidence.push({
        stage: sideIntent.challengeStage,
        source: item.source ?? record.challengeStageEval.provenance,
      });
    }
  }

  const expected = sideIntent.expectedStageModel;
  const routeModel = modelForChallengeStage(effectiveRoute, sideIntent.challengeStage);
  let invalidReason: InvalidChallengeReason | undefined;
  let invalidDetails: string | undefined;
  if (expected && routeModel && expected !== routeModel) {
    invalidReason = 'stage_override_lost';
    invalidDetails = `Expected ${sideIntent.challengeStage} model ${expected}, effective route has ${routeModel}.`;
  }

  const actualModel = evidence.find((item) => item.model)?.model
    ?? evidence.find((item) => item.resolvedModel)?.resolvedModel;
  const requestedModel = evidence.find((item) => item.requestedModel)?.requestedModel;
  const fallbackReason = evidence.find((item) => item.fallbackReason)?.fallbackReason;
  if (!invalidReason && expected && actualModel && actualModel !== expected) {
    invalidReason = requestedModel === expected || fallbackReason ? 'native_launch_fallback' : 'stage_override_lost';
    invalidDetails = `Expected ${sideIntent.challengeStage} model ${expected}, launch evidence has ${actualModel}.`;
  }

  return {
    pairId: sideIntent.pairId,
    side: sideIntent.side,
    validity: invalidReason ? 'invalid_challenge' : (record.challengeIntent?.intentionallyIdentical ? 'identical_control' : 'valid'),
    challengeStage: sideIntent.challengeStage,
    expectedStageModel: expected,
    ...(sideIntent.expectedStageAgent ? { expectedStageAgent: sideIntent.expectedStageAgent } : {}),
    ...(effectiveRoute ? { effectiveRoute } : {}),
    evidence,
    ...(invalidReason ? { invalidReason, invalidDetails } : {}),
  };
}

export function loadChallengeIntentFromFeatureDir(featureDir: string): ChallengeExecutionIntent | undefined {
  for (const file of ['challenge-intent.json', '.challenge-intent.json']) {
    const candidate = path.join(featureDir, file);
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, 'utf-8')) as ChallengeExecutionIntent;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
