export interface ChallengeRoutingMeta {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth: string;
  codeDepth: string;
  reviewMode: string;
  routerVariant?: string;
  plannerPromptVariant?: string;
  reviewerPromptVariant?: string;
}

export interface VariedDimensions {
  planner: boolean;
  coder: boolean;
  reviewer: boolean;
  planDepth: boolean;
  codeDepth: boolean;
  reviewMode: boolean;
  routerVariant: boolean;
  plannerPromptVariant: boolean;
  reviewerPromptVariant: boolean;
}

export interface RoutingComparableInput {
  planner?: string;
  plannerModel?: string;
  coder?: string;
  model?: string;
  challengeModel?: string;
  reviewer?: string;
  reviewerModel?: string;
  planDepth?: string;
  codeDepth?: string;
  reviewMode?: string;
  routerVariant?: string;
  plannerPromptVariant?: string;
  reviewerPromptVariant?: string;
}

export interface RepairableChallengePair<TEntry extends RoutingComparableInput = RoutingComparableInput> {
  primary: TEntry;
  challenger: TEntry;
  challengeStage?: string;
}

function normalize(value: string | undefined): string {
  return (value || '').trim();
}

function variantDiffers(a: string | undefined, b: string | undefined): boolean {
  const left = normalize(a);
  const right = normalize(b);
  return left !== '' && right !== '' && left !== right;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function extractRoutingDimensions(input: RoutingComparableInput | undefined): ChallengeRoutingMeta | undefined {
  if (!input) {
    return undefined;
  }

  return {
    planner: normalize(input.planner ?? input.plannerModel),
    coder: normalize(input.coder ?? input.model ?? input.challengeModel),
    reviewer: normalize(input.reviewer ?? input.reviewerModel),
    planDepth: normalize(input.planDepth),
    codeDepth: normalize(input.codeDepth),
    reviewMode: normalize(input.reviewMode),
    routerVariant: normalize(input.routerVariant),
    plannerPromptVariant: normalize(input.plannerPromptVariant),
    reviewerPromptVariant: normalize(input.reviewerPromptVariant),
  };
}

export function diffRoutingDimensions(
  primary: RoutingComparableInput | undefined,
  challenger: RoutingComparableInput | undefined,
): VariedDimensions | undefined {
  const left = extractRoutingDimensions(primary);
  const right = extractRoutingDimensions(challenger);
  if (!left || !right) {
    return undefined;
  }

  return {
    planner: left.planner !== right.planner,
    coder: left.coder !== right.coder,
    reviewer: left.reviewer !== right.reviewer,
    planDepth: left.planDepth !== right.planDepth,
    codeDepth: left.codeDepth !== right.codeDepth,
    reviewMode: left.reviewMode !== right.reviewMode,
    routerVariant: variantDiffers(left.routerVariant, right.routerVariant),
    plannerPromptVariant: variantDiffers(left.plannerPromptVariant, right.plannerPromptVariant),
    reviewerPromptVariant: variantDiffers(left.reviewerPromptVariant, right.reviewerPromptVariant),
  };
}

export function detectVariedDimensions(
  primary: RoutingComparableInput | undefined,
  challenger: RoutingComparableInput | undefined,
): VariedDimensions | undefined {
  return diffRoutingDimensions(primary, challenger);
}

export function hasVariedRoutingDimension(
  primary: RoutingComparableInput | undefined,
  challenger: RoutingComparableInput | undefined,
): boolean {
  const varied = diffRoutingDimensions(primary, challenger);
  return Boolean(varied) && Object.values(varied).some(Boolean);
}

function stageValue(input: RoutingComparableInput | undefined, stage: string): string {
  const routing = extractRoutingDimensions(input);
  if (!routing) {
    return '';
  }
  if (stage === 'plan') {
    return routing.planner;
  }
  if (stage === 'review') {
    return routing.reviewer;
  }
  return routing.coder;
}

export function repairChallengePairSelection<TPair extends RepairableChallengePair>(
  pair: TPair,
  options: {
    allowedModels: string[];
    forcedChallengerModel?: string;
    candidateStages?: string[];
    applyStageModel: (pair: TPair, stage: string, challengerModel: string) => TPair;
  },
): TPair | null {
  if (hasVariedRoutingDimension(pair.primary, pair.challenger)) {
    return pair;
  }

  const allowedModels = uniqueNonEmpty(options.allowedModels);
  const stages = uniqueNonEmpty([pair.challengeStage || '', ...(options.candidateStages || ['implementation', 'plan', 'review'])]);

  for (const stage of stages) {
    const primaryValue = stageValue(pair.primary, stage);
    if (!primaryValue) {
      continue;
    }

    const candidates = uniqueNonEmpty([
      options.forcedChallengerModel || '',
      ...allowedModels.filter((model) => model !== primaryValue),
    ]);

    for (const challengerModel of candidates) {
      if (challengerModel === primaryValue) {
        continue;
      }
      const repaired = options.applyStageModel(pair, stage, challengerModel);
      if (hasVariedRoutingDimension(repaired.primary, repaired.challenger)) {
        return repaired;
      }
    }
  }

  return null;
}
