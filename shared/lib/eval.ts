/**
 * Shared eval module — LLM judge for scoring autonomous task execution.
 *
 * Builds on the eval-schema (HOK-697) types and rubric.
 *
 * @module eval
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from 'crypto';
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getScoreBand, type EvalRecord, type InterventionRecord, type Outcomes, type RoutingDecision } from './eval-schema.ts';
import { callClaude, parseJsonFromLLM } from './llm-cli.ts';
import { getEvalConfig } from './config.ts';
import { loadPricingTable } from './workflow-cost.ts';
import { createPromptArtifact, type PromptArtifact } from './prompt-hash.ts';
import { errorMessage } from './error-utils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const DEFAULT_PROVIDER = 'claude-cli';
const SUPPORTED_PROVIDERS = ['claude-cli', 'anthropic'] as const;
const SCHEMA_VERSION = '1.3.0';
const MAX_RETRIES = 2;
const TIMEOUT_MS = 120_000;

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Legacy intervention metadata (flat format).
 */
export interface InterventionMeta {
  /** What the intervention was */
  description: string;
  /** Severity level */
  severity?: 'minor' | 'major';
}

/**
 * Input parameters for task evaluation.
 */
export interface EvalInput {
  /** The original task description */
  taskPrompt: string;
  /** PR review text / diff summary */
  prReviewOutput: string;
  /** Optional intervention metadata (legacy format) */
  interventions?: InterventionMeta[];
  /** Structured intervention events (new format) */
  interventionRecords?: InterventionRecord[];
  /** Pre-formatted structured intervention text for the judge (overrides interventions list formatting) */
  interventionText?: string;
  /** Linear issue ID (e.g. HOK-698) */
  issueId?: string;
  /** Pull request URL */
  prUrl?: string;
  /** Wall-clock time for task completion */
  timeSeconds?: number;
  /** Routing decision metadata (HOK-775) */
  routingDecision?: RoutingDecision;
  /** Expanded task packet content (if available) */
  taskPacket?: string;
  /** Implementation plan content (if available) */
  planContent?: string;
  /** Self-review summary (if available) */
  selfReviewSummary?: string;
  /** Extra metadata to pass through */
  metadata?: Record<string, unknown>;
}

/**
 * Judge configuration.
 */
interface JudgeConfig {
  model: string;
  provider: typeof SUPPORTED_PROVIDERS[number];
}

/**
 * Judge response structure.
 */
interface JudgeResponse {
  score: number;
  rationale: string;
  interventionFlags: string[];
  stageScores?: Record<string, { score: number; rationale: string }>;
}

/**
 * Token usage metadata.
 */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * LLM call result.
 */
interface LLMCallResult {
  text: string;
  usage?: TokenUsage;
  costUsd?: number;
}

/**
 * Pricing table entry.
 */
interface PricingEntry {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
}

/**
 * Options for evaluateTask (primarily for testing).
 */
export interface EvaluateTaskOptions {
  /** Override for the LLM call function (testing) */
  _callFn?: (prompt: string, model: string) => Promise<LLMCallResult>;
}

// ────────────────────────────────────────────────────────────────
// Internal Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Load judge config from .wavemill-config.json.
 *
 * Returns { model, provider } with defaults applied.
 * Validates provider against supported list.
 */
function loadJudgeConfig(): JudgeConfig {
  const evalConfig = getEvalConfig();
  const configModel = evalConfig.judge?.model || DEFAULT_MODEL;
  const configProvider = (evalConfig.judge?.provider || DEFAULT_PROVIDER) as typeof SUPPORTED_PROVIDERS[number];

  // Validate provider
  if (!SUPPORTED_PROVIDERS.includes(configProvider)) {
    throw new Error(
      `Invalid eval judge provider: "${configProvider}". Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`
    );
  }

  // Validate model is non-empty
  if (typeof configModel !== 'string' || configModel.trim().length === 0) {
    throw new Error('Invalid eval judge model: model must be a non-empty string.');
  }

  return { model: configModel, provider: configProvider };
}

let _promptTemplate: string | null = null;

async function loadPromptTemplate(): Promise<string> {
  if (_promptTemplate) return _promptTemplate;
  const promptPath = join(__dirname, '../../tools/prompts/eval-judge.md');
  _promptTemplate = await readFile(promptPath, 'utf-8');
  return _promptTemplate;
}

function buildJudgePrompt(
  template: string,
  taskPrompt: string,
  prReviewOutput: string,
  interventions: InterventionMeta[],
  interventionText?: string,
  taskPacket?: string,
  planContent?: string,
  selfReviewSummary?: string
): string {
  let finalInterventionText: string;
  if (interventionText) {
    // Use pre-formatted structured intervention text (from intervention-detector)
    finalInterventionText = interventionText;
  } else if (interventions && interventions.length > 0) {
    // Fall back to legacy flat list format
    finalInterventionText = interventions
      .map((i, idx) => `${idx + 1}. [${i.severity || 'unknown'}] ${i.description}`)
      .join('\n');
  } else {
    finalInterventionText = 'No interventions recorded.';
  }

  return template
    .replace('{{TASK_PROMPT}}', taskPrompt)
    .replace('{{PR_REVIEW_OUTPUT}}', prReviewOutput)
    .replace('{{INTERVENTION_METADATA}}', finalInterventionText)
    .replace('{{TASK_PACKET}}', taskPacket || 'Not available for this workflow.')
    .replace('{{PLAN_CONTENT}}', planContent || 'Not available for this workflow.')
    .replace('{{SELF_REVIEW_SUMMARY}}', selfReviewSummary || 'Not available for this workflow.');
}

async function callClaudeWithRetry(prompt: string, model: string): Promise<LLMCallResult> {
  const result = await callClaude(prompt, {
    mode: 'sync',
    model,
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    retry: true,
    maxRetries: MAX_RETRIES,
  });

  return {
    text: result.text,
    usage: result.usage,
    costUsd: result.costUsd,
  };
}

/**
 * Compute estimated cost in USD from token usage and a pricing table.
 *
 * Returns undefined if the model is not found in the pricing table.
 */
function computeCost(
  modelId: string,
  usage: TokenUsage | undefined,
  pricingTable: Record<string, PricingEntry>
): number | undefined {
  if (!usage || !pricingTable) return undefined;

  const pricing = pricingTable[modelId];
  if (!pricing) return undefined;

  const inputCost = (usage.inputTokens * pricing.inputCostPerMTok) / 1_000_000;
  const outputCost = (usage.outputTokens * pricing.outputCostPerMTok) / 1_000_000;
  return inputCost + outputCost;
}

function parseJudgeResponse(raw: string): JudgeResponse {
  const parsed = parseJsonFromLLM(raw) as {
    score?: number;
    rationale?: string;
    interventionFlags?: string[];
    stageScores?: Record<string, { score?: number; rationale?: string }>;
  };

  if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 1) {
    throw new Error(`Invalid score: ${parsed.score}. Must be a number between 0 and 1.`);
  }

  if (typeof parsed.rationale !== 'string' || parsed.rationale.trim().length === 0) {
    throw new Error('Rationale must be a non-empty string.');
  }

  if (!Array.isArray(parsed.interventionFlags)) {
    parsed.interventionFlags = [];
  }

  // Parse and validate stageScores (optional)
  let stageScores: Record<string, { score: number; rationale: string }> | undefined;
  if (parsed.stageScores && typeof parsed.stageScores === 'object') {
    stageScores = {};
    for (const [stage, stageData] of Object.entries(parsed.stageScores)) {
      if (
        typeof stageData?.score === 'number' &&
        stageData.score >= 0 &&
        stageData.score <= 1 &&
        typeof stageData?.rationale === 'string'
      ) {
        stageScores[stage] = {
          score: stageData.score,
          rationale: stageData.rationale.trim(),
        };
      }
    }
    // Only include if at least one valid stage score
    if (Object.keys(stageScores).length === 0) {
      stageScores = undefined;
    }
  }

  return {
    score: parsed.score,
    rationale: parsed.rationale.trim(),
    interventionFlags: parsed.interventionFlags,
    ...(stageScores && { stageScores }),
  };
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Evaluate a task execution using an LLM judge.
 *
 * Returns an EvalRecord (as defined in eval-schema.ts) populated with
 * the judge's score, rationale, and the derived score band.
 *
 * @param input - Evaluation input parameters
 * @param outcomes - Optional pre-collected outcome components
 * @param options - Optional configuration (primarily for testing)
 * @returns Promise resolving to an EvalRecord
 *
 * @example
 * ```typescript
 * const result = await evaluateTask({
 *   taskPrompt: 'Add a loading spinner',
 *   prReviewOutput: 'Clean diff, all tests pass',
 *   issueId: 'HOK-123',
 * });
 * console.log(`Score: ${result.score}, Band: ${result.scoreBand}`);
 * ```
 */
export async function evaluateTask(
  input: EvalInput,
  outcomes: Outcomes | undefined = undefined,
  options: EvaluateTaskOptions = {}
): Promise<EvalRecord> {
  const { _callFn } = options;
  const {
    taskPrompt,
    prReviewOutput,
    interventions = [],
    interventionRecords,
    interventionText,
    issueId,
    prUrl,
    timeSeconds = 0,
    routingDecision,
    taskPacket,
    planContent,
    selfReviewSummary,
    metadata = {},
  } = input;

  // Determine which intervention format to use
  // If interventionRecords provided, prefer it; else use legacy interventions
  const hasStructuredInterventions = interventionRecords && interventionRecords.length > 0;
  const interventionsToUse = hasStructuredInterventions ? interventionRecords : interventions;
  const interventionCount = hasStructuredInterventions
    ? interventionRecords.length
    : interventions.length;

  // Resolve judge model: env var > config file > default
  const judgeConfig = loadJudgeConfig();
  const model = process.env.EVAL_MODEL || judgeConfig.model;
  const provider = judgeConfig.provider;
  const pricingTable = loadPricingTable();

  const template = await loadPromptTemplate();
  const prompt = buildJudgePrompt(
    template,
    taskPrompt,
    prReviewOutput,
    interventions,
    interventionText,
    taskPacket,
    planContent,
    selfReviewSummary
  );

  // Capture prompt artifact for GEPA training (HOK-1003)
  // Gracefully handle missing template file - this is metadata and should not block evals
  let promptArtifacts: PromptArtifact[] = [];
  try {
    const promptTemplatePath = join(__dirname, '../../tools/prompts/eval-judge.md');
    const promptArtifact = createPromptArtifact(promptTemplatePath, prompt);
    promptArtifacts = [promptArtifact];
  } catch (err) {
    console.warn(`[eval] Failed to capture prompt artifact: ${errorMessage(err)}`);
  }

  const callFn = _callFn || callClaudeWithRetry;

  // Call Claude (with retry built-in)
  const response = await callFn(prompt, model);

  // Parse response
  const { score, rationale, interventionFlags, stageScores } = parseJudgeResponse(response.text);
  const band = getScoreBand(score);

  const tokenUsage = response.usage || undefined;
  // Prefer the CLI's authoritative cost; fall back to pricing table estimate
  const estimatedCost = response.costUsd !== undefined
    ? response.costUsd
    : computeCost(model, tokenUsage, pricingTable);

  return {
    id: randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: taskPrompt,
    modelId: model,
    modelVersion: model,
    judgeModel: model,
    judgeProvider: provider,
    score,
    scoreBand: band.label,
    timeSeconds,
    timestamp: new Date().toISOString(),
    interventionRequired: interventionCount > 0,
    interventionCount,
    interventionDetails: hasStructuredInterventions
      ? interventionRecords.map((i) => i.note)
      : interventions.map((i) => i.description),
    ...(hasStructuredInterventions && { interventions: interventionRecords }),
    rationale,
    ...(issueId && { issueId }),
    ...(prUrl && { prUrl }),
    ...(tokenUsage && { tokenUsage }),
    ...(estimatedCost !== undefined && { estimatedCost }),
    ...(outcomes && { outcomes }),
    ...(routingDecision && { routingDecision }),
    ...(promptArtifacts.length > 0 && { promptArtifacts }),
    metadata: { ...metadata, interventionFlags, ...(stageScores && { stageScores }) },
  };
}
