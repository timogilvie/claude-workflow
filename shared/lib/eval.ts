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
import {
  SCHEMA_VERSION,
  getScoreBand,
  type EvalRecord,
  type InterventionRecord,
  type Outcomes,
  type PlanCritique,
  type PlanCritiqueDimension,
  type RoutingDecision,
  type RubricEval,
  type RubricCriteria,
  type RubricCriterion,
  type RubricCriterionScore,
  type RubricDeterminativeBoundary,
} from './eval-schema.ts';
import { callClaude, parseJsonFromLLM } from './llm-cli.ts';
import { getEvalConfig } from './config.ts';
import { loadPricingTable } from './workflow-cost.ts';
import { createPromptArtifact, type PromptArtifact } from './prompt-hash.ts';
import { errorMessage } from './error-utils.ts';
import { getLatestSession } from './session.ts';
import { attachEligibility, attachManifestRef } from './eval-record-builder.ts';
import { attachPromptSizeDiagnostic } from './eval-record-builder.ts';
import {
  enforcePromptSizeLimit,
  resolveEvalPromptSizeConfig,
  type EvalOversizePolicy,
  type PromptComponents,
} from './eval-prompt-size.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_PROVIDER = 'claude-cli';
const SUPPORTED_PROVIDERS = ['claude-cli', 'anthropic'] as const;
const MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 120_000;

function getEvalTimeoutMs(): number {
  const raw = process.env.EVAL_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

const TIMEOUT_MS = getEvalTimeoutMs();

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
  timeSeconds?: number | null;
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
  stageScores?: Record<string, { score: number; rationale: string; rubricCriteria?: RubricCriterion[] }>;
  planCritique?: PlanCritique;
  rubricEval?: RubricEval;
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

function normalizeTimeSeconds(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Options for evaluateTask (primarily for testing).
 */
export interface EvaluateTaskOptions {
  /** Override for the LLM call function (testing) */
  _callFn?: (prompt: string, model: string) => Promise<LLMCallResult>;
  /** Override prompt size guard config (testing) */
  _promptSizeConfig?: { maxPromptBytes?: number; oversizePolicy?: EvalOversizePolicy };
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

function buildInterventionText(
  interventions: InterventionMeta[],
  interventionText?: string,
): string {
  if (interventionText) {
    // Use pre-formatted structured intervention text (from intervention-detector)
    return interventionText;
  }

  if (interventions && interventions.length > 0) {
    // Fall back to legacy flat list format
    return interventions
      .map((i, idx) => `${idx + 1}. [${i.severity || 'unknown'}] ${i.description}`)
      .join('\n');
  }

  return 'No interventions recorded.';
}

function buildPromptComponents(
  template: string,
  input: {
    taskPrompt: string;
    prReviewOutput: string;
    interventionText: string;
    taskPacket?: string;
    planContent?: string;
    selfReviewSummary?: string;
  },
): PromptComponents {
  const insertedComponents: PromptComponents = {
    taskPrompt: input.taskPrompt,
    prReviewOutput: input.prReviewOutput,
    interventionMetadata: input.interventionText,
    taskPacket: input.taskPacket || 'Not available for this workflow.',
    planContent: input.planContent || 'Not available for this workflow.',
    selfReviewSummary: input.selfReviewSummary || 'Not available for this workflow.',
  };
  const templateScaffold = fillJudgePrompt(template, {
    taskPrompt: '',
    prReviewOutput: '',
    interventionMetadata: '',
    taskPacket: '',
    planContent: '',
    selfReviewSummary: '',
  });

  return {
    ...insertedComponents,
    templateScaffold,
  };
}

function fillJudgePrompt(template: string, components: PromptComponents): string {
  return template
    .replace('{{TASK_PROMPT}}', components.taskPrompt ?? '')
    .replace('{{PR_REVIEW_OUTPUT}}', components.prReviewOutput ?? '')
    .replace('{{INTERVENTION_METADATA}}', components.interventionMetadata ?? '')
    .replace('{{TASK_PACKET}}', components.taskPacket ?? '')
    .replace('{{PLAN_CONTENT}}', components.planContent ?? '')
    .replace('{{SELF_REVIEW_SUMMARY}}', components.selfReviewSummary ?? '');
}

async function callClaudeWithRetry(prompt: string, model: string): Promise<LLMCallResult> {
  const result = await callClaude(prompt, {
    mode: 'sync',
    model,
    taskType: 'classify',
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    retry: true,
    maxRetries: MAX_RETRIES,
  });

  return result;
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

const PLAN_CRITIQUE_DIMENSIONS = [
  'component_boundaries',
  'invariant_coverage',
  'approach_soundness',
  'missed_patches',
  'overall',
] as const satisfies readonly (keyof PlanCritique)[];

function parsePlanCritiqueDimension(
  value: unknown,
): PlanCritiqueDimension | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const dimension = value as {
    score?: number;
    rationale?: string;
  };

  if (
    typeof dimension.score !== 'number' ||
    dimension.score < 0 ||
    dimension.score > 1 ||
    typeof dimension.rationale !== 'string'
  ) {
    return undefined;
  }

  const rationale = dimension.rationale.trim();
  if (rationale.length === 0) {
    return undefined;
  }

  return {
    score: dimension.score,
    rationale,
  };
}

function parsePlanCritique(value: unknown): PlanCritique | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const rawPlanCritique = value as Partial<Record<keyof PlanCritique, unknown>>;
  const parsedDimensions = PLAN_CRITIQUE_DIMENSIONS.reduce<
    Partial<Record<keyof PlanCritique, PlanCritiqueDimension>>
  >((acc, dimensionName) => {
    const parsedDimension = parsePlanCritiqueDimension(
      rawPlanCritique[dimensionName],
    );
    if (parsedDimension) {
      acc[dimensionName] = parsedDimension;
    }
    return acc;
  }, {});

  if (PLAN_CRITIQUE_DIMENSIONS.every((dimensionName) => parsedDimensions[dimensionName])) {
    return parsedDimensions as PlanCritique;
  }

  return undefined;
}

const RUBRIC_DETERMINATIVE_BOUNDARIES = new Set<string>([
  'no_interventions',
  'cosmetic_only',
  'functional_bug',
  'multiple_bugs',
  'heavy_intervention',
]);

const RUBRIC_CRITERIA_KEYS = [
  'completeness',
  'correctness',
  'code_quality',
  'intervention_impact',
  'autonomy',
] as const satisfies readonly (keyof RubricCriteria)[];

function parseRubricCriterionScore(value: unknown): RubricCriterionScore | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { score?: unknown; rationale?: unknown };
  if (
    typeof v.score !== 'number' ||
    v.score < 0 ||
    v.score > 1 ||
    typeof v.rationale !== 'string' ||
    v.rationale.trim().length === 0
  ) {
    return undefined;
  }
  return { score: v.score, rationale: v.rationale.trim() };
}

function parseRubricEval(value: unknown): RubricEval | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const raw = value as Record<string, unknown>;

  if (raw.schema_version !== '1.0') return undefined;
  if (typeof raw.rubric_version !== 'string' || raw.rubric_version.trim().length === 0) return undefined;

  const rawCriteria = raw.criteria;
  if (!rawCriteria || typeof rawCriteria !== 'object') return undefined;

  const criteriaObj = rawCriteria as Record<string, unknown>;
  const parsedCriteria: Partial<Record<keyof RubricCriteria, RubricCriterionScore>> = {};

  for (const key of RUBRIC_CRITERIA_KEYS) {
    const parsed = parseRubricCriterionScore(criteriaObj[key]);
    if (!parsed) return undefined;
    parsedCriteria[key] = parsed;
  }

  const determinative_boundary = typeof raw.determinative_boundary === 'string' &&
    RUBRIC_DETERMINATIVE_BOUNDARIES.has(raw.determinative_boundary)
    ? (raw.determinative_boundary as RubricDeterminativeBoundary)
    : undefined;

  return {
    schema_version: '1.0',
    rubric_version: raw.rubric_version as string,
    criteria: parsedCriteria as RubricCriteria,
    ...(determinative_boundary && { determinative_boundary }),
  };
}

function parseStageRubricCriteria(
  value: unknown,
  stageName: string,
): RubricCriterion[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    console.warn(`[eval] Ignoring invalid rubricCriteria for stage "${stageName}": expected array.`);
    return undefined;
  }

  const parsedCriteria: RubricCriterion[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      console.warn(`[eval] Ignoring malformed rubricCriteria item for stage "${stageName}".`);
      continue;
    }

    const rawCriterion = item as {
      criterion?: unknown;
      score?: unknown;
      notes?: unknown;
    };

    if (
      typeof rawCriterion.criterion !== 'string' ||
      rawCriterion.criterion.trim().length === 0 ||
      typeof rawCriterion.score !== 'number' ||
      rawCriterion.score < 0 ||
      rawCriterion.score > 1
    ) {
      console.warn(`[eval] Ignoring malformed rubricCriteria item for stage "${stageName}".`);
      continue;
    }

    const criterion: RubricCriterion = {
      criterion: rawCriterion.criterion.trim(),
      score: rawCriterion.score,
    };
    if (typeof rawCriterion.notes === 'string' && rawCriterion.notes.trim().length > 0) {
      criterion.notes = rawCriterion.notes.trim();
    }
    parsedCriteria.push(criterion);
  }

  return parsedCriteria.length > 0 ? parsedCriteria : undefined;
}

function parseJudgeResponse(raw: string): JudgeResponse {
  const parsed = parseJsonFromLLM(raw) as {
    score?: number;
    rationale?: string;
    interventionFlags?: string[];
    stageScores?: Record<string, { score?: number; rationale?: string; rubricCriteria?: unknown }>;
    planCritique?: unknown;
    rubricEval?: unknown;
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
  let stageScores: Record<string, { score: number; rationale: string; rubricCriteria?: RubricCriterion[] }> | undefined;
  if (parsed.stageScores && typeof parsed.stageScores === 'object') {
    stageScores = {};
    for (const [stage, stageData] of Object.entries(parsed.stageScores)) {
      if (
        typeof stageData?.score === 'number' &&
        stageData.score >= 0 &&
        stageData.score <= 1 &&
        typeof stageData?.rationale === 'string'
      ) {
        const rubricCriteria = parseStageRubricCriteria(stageData.rubricCriteria, stage);
        stageScores[stage] = {
          score: stageData.score,
          rationale: stageData.rationale.trim(),
          ...(rubricCriteria && { rubricCriteria }),
        };
      }
    }
    // Only include if at least one valid stage score
    if (Object.keys(stageScores).length === 0) {
      stageScores = undefined;
    }
  }

  const planCritique = parsePlanCritique(parsed.planCritique);
  const rubricEval = parseRubricEval(parsed.rubricEval);

  return {
    score: parsed.score,
    rationale: parsed.rationale.trim(),
    interventionFlags: parsed.interventionFlags,
    ...(stageScores && { stageScores }),
    ...(planCritique && { planCritique }),
    ...(rubricEval && { rubricEval }),
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
  const { _callFn, _promptSizeConfig } = options;
  const {
    taskPrompt,
    prReviewOutput,
    interventions = [],
    interventionRecords,
    interventionText,
    issueId,
    prUrl,
    timeSeconds,
    routingDecision,
    taskPacket,
    planContent,
    selfReviewSummary,
    metadata = {},
  } = input;
  const normalizedTimeSeconds = normalizeTimeSeconds(timeSeconds);

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
  const finalInterventionText = buildInterventionText(interventions, interventionText);
  const rawComponents = buildPromptComponents(template, {
    taskPrompt,
    prReviewOutput,
    interventionText: finalInterventionText,
    taskPacket,
    planContent,
    selfReviewSummary,
  });
  const { limitBytes, policy } = resolveEvalPromptSizeConfig(_promptSizeConfig ?? getEvalConfig());
  const enforcement = enforcePromptSizeLimit({
    components: rawComponents,
    limitBytes,
    policy,
  });
  let prompt = fillJudgePrompt(template, enforcement.components);
  const finalPromptBytes = Buffer.byteLength(prompt, 'utf8');
  if (finalPromptBytes !== enforcement.diagnostic.totalBytes) {
    enforcement.diagnostic.totalBytes = finalPromptBytes;
  }
  if (finalPromptBytes > limitBytes) {
    enforcement.diagnostic.action = 'rejected';
    enforcement.action = 'rejected';
  }
  console[enforcement.action === 'pass' ? 'log' : 'warn'](
    `[eval] prompt_size ${JSON.stringify(enforcement.diagnostic)}`,
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

  const activeSessionId = process.env.WAVEMILL_SESSION || (await getLatestSession())?.sessionId;

  if (enforcement.action === 'rejected') {
    const record: EvalRecord = {
      id: randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      originalPrompt: taskPrompt,
      modelId: model,
      modelVersion: model,
      judgeModel: model,
      judgeProvider: provider,
      score: 0,
      scoreBand: 'Failure',
      timeSeconds: normalizedTimeSeconds,
      timestamp: new Date().toISOString(),
      interventionRequired: interventionCount > 0,
      interventionCount,
      interventionDetails: hasStructuredInterventions
        ? interventionRecords.map((i) => i.note)
        : interventions.map((i) => i.description),
      ...(hasStructuredInterventions && { interventions: interventionRecords }),
      rationale: `Eval prompt exceeded configured byte limit before judge invocation (${enforcement.diagnostic.totalBytes} > ${limitBytes}).`,
      failureReason: 'eval_prompt_too_large',
      ...(issueId && { issueId }),
      ...(prUrl && { prUrl }),
      ...(outcomes && { outcomes }),
      ...(routingDecision && { routingDecision }),
      ...(promptArtifacts.length > 0 && { promptArtifacts }),
      metadata: {
        ...metadata,
        interventionFlags: [],
      },
    };
    attachPromptSizeDiagnostic(record, enforcement.diagnostic);
    attachManifestRef(record, activeSessionId);
    attachEligibility(record);
    return record;
  }

  const callFn = _callFn || callClaudeWithRetry;

  // Call Claude (with retry built-in)
  const response = await callFn(prompt, model);

  // Parse response
  const { score, rationale, interventionFlags, stageScores, planCritique, rubricEval } = parseJudgeResponse(response.text);
  const band = getScoreBand(score);

  const tokenUsage = response.usage || undefined;
  // Prefer the CLI's authoritative cost; fall back to pricing table estimate
  const estimatedCost = response.costUsd !== undefined
    ? response.costUsd
    : computeCost(model, tokenUsage, pricingTable);

  const record: EvalRecord = {
    id: randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: taskPrompt,
    modelId: model,
    modelVersion: model,
    judgeModel: model,
    judgeProvider: provider,
    score,
    scoreBand: band.label,
    timeSeconds: normalizedTimeSeconds,
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
    ...(rubricEval && { rubricEval }),
    metadata: {
      ...metadata,
      interventionFlags,
      ...(stageScores && { stageScores }),
      ...(planCritique && { planCritique }),
    },
  };
  attachPromptSizeDiagnostic(record, enforcement.diagnostic);
  attachManifestRef(record, activeSessionId);
  attachEligibility(record);
  return record;
}
