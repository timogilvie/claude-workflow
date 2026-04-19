import { getEffectiveRegistry, getModel, type RegistryTaskType } from './model-registry.ts';
import { getVerificationConfig, type VerificationConfig } from './config.ts';

/**
 * Verification requirements for a given coding task.
 * Determines what extra checks must be performed when a weaker model is used.
 */
export interface VerificationRequirements {
  /** Is verification needed for this model/task combination? */
  verificationNeeded: boolean;

  /** Mandatory checks that must pass before commit */
  mandatory: {
    typecheck: boolean;
    lint: boolean;
    test: boolean;
    selfExplanation: boolean;
  };

  /** Second-pass review requirements */
  secondPassReview: {
    required: boolean;
    preferredReviewer?: string; // Stronger model if available
  };

  /** Patch size cap (enforced when no stronger reviewer available) */
  patchSizeCap?: {
    maxLines: number;
    reason: string;
  };

  /** Metadata for logging */
  metadata: {
    coderModel: string;
    coderScore: number;
    threshold: number;
    qualityGap: number;
    strongerReviewerAvailable: boolean;
  };
}

/**
 * Default quality thresholds per task type.
 * Models scoring below these thresholds are considered "weak" and trigger extra verification.
 */
const DEFAULT_QUALITY_THRESHOLDS: Record<RegistryTaskType, number> = {
  routing: 70,
  planning: 70,
  coding: 80,
  review: 80,
  classify: 70,
};

/**
 * Default patch size cap configuration.
 */
const DEFAULT_PATCH_SIZE_CONFIG = {
  baseLines: 200,
  adjustByQualityGap: true,
  minMultiplier: 0.5,
};

/**
 * Determine verification requirements for a coding task.
 *
 * @param coderModel - Model ID being used for coding
 * @param taskType - Type of task (usually 'coding')
 * @param availableReviewers - List of model IDs available for review
 * @param repoDir - Repository directory for config loading
 * @returns Verification requirements for this task
 */
export function determineVerificationRequirements(
  coderModel: string,
  taskType: RegistryTaskType,
  availableReviewers: string[],
  repoDir?: string,
): VerificationRequirements {
  const registry = getEffectiveRegistry(repoDir);
  const config = getVerificationConfig(repoDir);

  // Get coder model capabilities
  const coderCapabilities = getModel(registry, coderModel);
  if (!coderCapabilities) {
    throw new Error(`Unknown coder model: ${coderModel}`);
  }

  const coderScore = coderCapabilities.qualityScores[taskType];

  // Get quality threshold
  const threshold = getQualityThreshold(taskType, config);
  const qualityGap = threshold - coderScore;

  // If coder meets threshold, no extra verification needed
  if (coderScore >= threshold) {
    return createNoVerificationResult(coderModel, coderScore, threshold);
  }

  // Coder is below threshold - check for stronger reviewers
  const strongerReviewer = findStrongerReviewer(
    coderScore,
    taskType,
    availableReviewers,
    registry,
  );

  // Determine mandatory checks
  const mandatoryChecks = getMandatoryChecks(config);

  // Determine if second-pass review is needed
  const needsSecondPass = shouldRequireSecondPass(strongerReviewer !== undefined, config);

  // Determine if patch size cap is needed
  const patchSizeCap = strongerReviewer === undefined
    ? calculatePatchSizeCap(qualityGap, config)
    : undefined;

  return {
    verificationNeeded: true,
    mandatory: mandatoryChecks,
    secondPassReview: {
      required: needsSecondPass,
      preferredReviewer: strongerReviewer,
    },
    patchSizeCap,
    metadata: {
      coderModel,
      coderScore,
      threshold,
      qualityGap,
      strongerReviewerAvailable: strongerReviewer !== undefined,
    },
  };
}

/**
 * Create a "no verification needed" result for strong models.
 */
function createNoVerificationResult(
  coderModel: string,
  coderScore: number,
  threshold: number,
): VerificationRequirements {
  return {
    verificationNeeded: false,
    mandatory: {
      typecheck: false,
      lint: false,
      test: false,
      selfExplanation: false,
    },
    secondPassReview: {
      required: false,
    },
    metadata: {
      coderModel,
      coderScore,
      threshold,
      qualityGap: 0,
      strongerReviewerAvailable: false,
    },
  };
}

/**
 * Get quality threshold for a task type from config or defaults.
 */
function getQualityThreshold(
  taskType: RegistryTaskType,
  config?: VerificationConfig,
): number {
  return config?.qualityThresholds?.[taskType] ?? DEFAULT_QUALITY_THRESHOLDS[taskType];
}

/**
 * Find a stronger reviewer (higher quality score than coder).
 */
function findStrongerReviewer(
  coderScore: number,
  taskType: RegistryTaskType,
  availableReviewers: string[],
  registry: ReturnType<typeof getEffectiveRegistry>,
): string | undefined {
  let bestReviewer: string | undefined;
  let bestScore = coderScore;

  for (const reviewerId of availableReviewers) {
    const reviewerCapabilities = getModel(registry, reviewerId);
    if (!reviewerCapabilities) {
      continue;
    }

    const reviewerScore = reviewerCapabilities.qualityScores[taskType === 'coding' ? 'review' : taskType];
    if (reviewerScore > bestScore) {
      bestReviewer = reviewerId;
      bestScore = reviewerScore;
    }
  }

  return bestReviewer;
}

/**
 * Get mandatory checks configuration.
 */
function getMandatoryChecks(config?: VerificationConfig) {
  const defaults = {
    typecheck: true,
    lint: true,
    test: true,
    selfExplanation: true,
  };

  if (!config?.mandatoryChecks) {
    return defaults;
  }

  return {
    typecheck: config.mandatoryChecks.typecheck ?? defaults.typecheck,
    lint: config.mandatoryChecks.lint ?? defaults.lint,
    test: config.mandatoryChecks.test ?? defaults.test,
    selfExplanation: config.mandatoryChecks.selfExplanation ?? defaults.selfExplanation,
  };
}

/**
 * Determine if second-pass review should be required.
 */
function shouldRequireSecondPass(
  strongerReviewerAvailable: boolean,
  config?: VerificationConfig,
): boolean {
  if (!strongerReviewerAvailable) {
    return false;
  }

  const enabled = config?.secondPassReview?.enabled ?? true;
  return enabled;
}

/**
 * Calculate patch size cap based on quality gap.
 *
 * Formula: cap = baseLines * max(minMultiplier, 1 - (qualityGap / 50))
 *
 * Example: Haiku (score=60, gap=20 from threshold=80)
 *   cap = 200 * max(0.5, 1 - (20/50))
 *   cap = 200 * max(0.5, 0.6)
 *   cap = 200 * 0.6 = 120 lines
 */
function calculatePatchSizeCap(
  qualityGap: number,
  config?: VerificationConfig,
): { maxLines: number; reason: string } {
  const baseLines = config?.patchSizeCap?.baseLines ?? DEFAULT_PATCH_SIZE_CONFIG.baseLines;
  const adjustByGap = config?.patchSizeCap?.adjustByQualityGap ?? DEFAULT_PATCH_SIZE_CONFIG.adjustByQualityGap;
  const minMultiplier = DEFAULT_PATCH_SIZE_CONFIG.minMultiplier;

  if (!adjustByGap) {
    return {
      maxLines: baseLines,
      reason: 'No stronger reviewer available - patch size cap enforced',
    };
  }

  // Calculate multiplier based on quality gap
  const multiplier = Math.max(minMultiplier, 1 - (qualityGap / 50));
  const maxLines = Math.round(baseLines * multiplier);

  return {
    maxLines,
    reason: `No stronger reviewer available and coder quality ${qualityGap} points below threshold - patch size capped to reduce risk`,
  };
}

/**
 * Check if a model is considered weak for a given task type.
 * Useful for logging and debugging.
 */
export function isWeakModel(
  modelId: string,
  taskType: RegistryTaskType,
  repoDir?: string,
): boolean {
  const registry = getEffectiveRegistry(repoDir);
  const config = getVerificationConfig(repoDir);

  const capabilities = getModel(registry, modelId);
  if (!capabilities) {
    return false;
  }

  const score = capabilities.qualityScores[taskType];
  const threshold = getQualityThreshold(taskType, config);

  return score < threshold;
}
