/**
 * Review Orchestrator - Coordinates multi-pass code reviews
 *
 * Implements second-pass review logic when verification requirements indicate
 * a stronger reviewer should validate changes made by a weaker coder model.
 *
 * @module review-orchestrator
 */

import { determineVerificationRequirements, type VerificationRequirements } from './verification-engine.ts';
import { runReview, type ReviewResult } from './review-engine.ts';
import type { ReviewContext } from './review-context-gatherer.ts';

export interface ReviewPassSpec {
  passNumber: number;
  reviewerModel: string;
  focus: 'general' | 'risk-areas' | 'verification';
  requiresStrongerModel: boolean;
  reason?: string;
}

export interface MultiPassReviewResult {
  passes: Array<{
    spec: ReviewPassSpec;
    result: ReviewResult;
  }>;
  finalVerdict: 'ready' | 'not_ready';
  allFindings: ReviewResult['codeReviewFindings'];
}

/**
 * Risk patterns that trigger focused second-pass review.
 * These are file paths or patterns that indicate high-risk code areas.
 */
const DEFAULT_RISK_PATTERNS = [
  '**/auth/**',
  '**/authentication/**',
  '**/authorization/**',
  '**/migrations/**',
  '**/schema/**',
  '**/*crypto*',
  '**/*encryption*',
  '**/*permission*',
  '**/*security*',
  '**/sql/**',
];

/**
 * Orchestrate code review with optional second pass.
 *
 * Determines if a second review pass is needed based on:
 * - Coder model quality vs threshold
 * - Availability of stronger reviewer
 * - Presence of high-risk code changes
 *
 * @param context - Review context (branch, files, etc.)
 * @param coderModel - Model used for coding phase
 * @param primaryReviewer - Recommended reviewer model
 * @param availableReviewers - All available reviewer models
 * @param repoDir - Repository directory
 * @returns Multi-pass review result with all findings
 */
export async function orchestrateReview(
  context: ReviewContext,
  coderModel: string,
  primaryReviewer: string,
  availableReviewers: string[],
  repoDir: string,
): Promise<MultiPassReviewResult> {
  // Determine verification requirements
  const verificationReqs = determineVerificationRequirements(
    coderModel,
    'coding',
    availableReviewers,
    repoDir,
  );

  // Always run primary review pass
  const passes: MultiPassReviewResult['passes'] = [];
  const primaryPass = await runReviewPass(
    {
      passNumber: 1,
      reviewerModel: primaryReviewer,
      focus: 'general',
      requiresStrongerModel: false,
      reason: 'Primary review pass',
    },
    context,
    repoDir,
  );
  passes.push(primaryPass);

  // Determine if second pass is needed
  if (verificationReqs.secondPassReview.required) {
    const strongerReviewer = verificationReqs.secondPassReview.preferredReviewer;
    if (!strongerReviewer) {
      console.warn('Second-pass review required but no stronger reviewer available');
    } else if (hasRiskyChanges(context, repoDir)) {
      // Run second pass focused on risk areas
      const secondPass = await runReviewPass(
        {
          passNumber: 2,
          reviewerModel: strongerReviewer,
          focus: 'risk-areas',
          requiresStrongerModel: true,
          reason: `Weak coder model (${coderModel}) + risky code changes detected`,
        },
        context,
        repoDir,
      );
      passes.push(secondPass);
    } else {
      console.log(`Second-pass review skipped: no risky changes detected (coder: ${coderModel})`);
    }
  }

  // Aggregate results
  const allFindings = passes.flatMap((p) => p.result.codeReviewFindings);
  const finalVerdict = passes.some((p) => p.result.verdict === 'not_ready') ? 'not_ready' : 'ready';

  return {
    passes,
    finalVerdict,
    allFindings,
  };
}

/**
 * Run a single review pass.
 */
async function runReviewPass(
  spec: ReviewPassSpec,
  context: ReviewContext,
  repoDir: string,
): Promise<{ spec: ReviewPassSpec; result: ReviewResult }> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Review Pass ${spec.passNumber}: ${spec.focus}`);
  console.log(`Model: ${spec.reviewerModel}`);
  if (spec.reason) {
    console.log(`Reason: ${spec.reason}`);
  }
  console.log('='.repeat(60) + '\n');

  // Run review with appropriate focus
  const result = await runReview(context, {
    model: spec.reviewerModel,
    verbose: true,
    // For second-pass risk-focused reviews, we could add filtering here
    // For now, just run full review and document the intent
  });

  return { spec, result };
}

/**
 * Check if the changes include high-risk code areas.
 *
 * Returns true if any changed files match risk patterns.
 */
function hasRiskyChanges(context: ReviewContext, repoDir: string): boolean {
  const riskPatterns = loadRiskPatterns(repoDir);

  // Check if any changed files match risk patterns
  for (const file of context.files || []) {
    for (const pattern of riskPatterns) {
      if (matchesPattern(file, pattern)) {
        console.log(`  Risky change detected: ${file} (matches pattern: ${pattern})`);
        return true;
      }
    }
  }

  return false;
}

/**
 * Load risk patterns from config or use defaults.
 */
function loadRiskPatterns(repoDir: string): string[] {
  // For now, just use defaults
  // Future: load from .wavemill-config.json verification.secondPassReview.riskPatterns
  return DEFAULT_RISK_PATTERNS;
}

/**
 * Simple glob-style pattern matching.
 * Supports * and ** wildcards.
 */
function matchesPattern(path: string, pattern: string): boolean {
  // Convert glob pattern to regex
  // IMPORTANT: Escape dots BEFORE replacing wildcards to avoid consuming the dots in .*
  const regexPattern = pattern
    .replace(/\./g, '\\.')    // Escape dots first
    .replace(/\*\*/g, '.*')   // ** matches any path segment
    .replace(/\*/g, '[^/]*'); // * matches within a segment

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(path);
}

/**
 * Build review chain metadata for eval records.
 *
 * This captures the multi-pass review decision and execution for GEPA training.
 */
export function buildReviewChainMetadata(
  result: MultiPassReviewResult,
  verificationReqs: VerificationRequirements,
): {
  reviewChain: Array<{
    pass: number;
    model: string;
    focus: string;
    requiresStrongerModel: boolean;
  }>;
  verificationContext: {
    coderModel: string;
    coderScore: number;
    threshold: number;
    qualityGap: number;
    secondPassTriggered: boolean;
  };
} {
  return {
    reviewChain: result.passes.map((p) => ({
      pass: p.spec.passNumber,
      model: p.spec.reviewerModel,
      focus: p.spec.focus,
      requiresStrongerModel: p.spec.requiresStrongerModel,
    })),
    verificationContext: {
      coderModel: verificationReqs.metadata.coderModel,
      coderScore: verificationReqs.metadata.coderScore,
      threshold: verificationReqs.metadata.threshold,
      qualityGap: verificationReqs.metadata.qualityGap,
      secondPassTriggered: result.passes.length > 1,
    },
  };
}
