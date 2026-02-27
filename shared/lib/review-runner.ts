/**
 * Review runner - Core logic for self-review tool.
 *
 * Orchestrates the review process:
 * 1. Gather context (diff, plan, task packet, design artifacts)
 * 2. Fill review prompt template
 * 3. Invoke LLM judge
 * 4. Parse and return structured findings
 *
 * @module review-runner
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  gatherReviewContext,
  type ReviewContext,
  type DesignContext,
} from './review-context-gatherer.js';
import { callClaude, parseJsonFromLLM } from './llm-cli.js';
import { loadWavemillConfig } from './config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface ReviewOptions {
  /** Branch to diff against (default: "main") */
  targetBranch?: string;
  /** Repository directory (default: cwd) */
  repoDir?: string;
  /** Skip UI verification even if design context exists */
  skipUi?: boolean;
  /** Run only UI verification (skip code review) */
  uiOnly?: boolean;
  /** Print verbose output */
  verbose?: boolean;
}

export interface ReviewFinding {
  severity: 'blocker' | 'warning';
  location: string;
  category: string;
  description: string;
}

export interface ReviewResult {
  verdict: 'ready' | 'not_ready';
  codeReviewFindings: ReviewFinding[];
  uiFindings?: ReviewFinding[];
  metadata?: {
    branch: string;
    files: string[];
    hasUiChanges: boolean;
    designContextAvailable: boolean;
    uiVerificationRun: boolean;
  };
}

interface JudgeConfig {
  model: string;
  provider: string;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const DEFAULT_PROVIDER = 'claude-cli';
const SUPPORTED_PROVIDERS = ['claude-cli', 'anthropic'];
const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

// ────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────

interface UiConfig {
  visualVerification: boolean;
  devServer?: string;
}

interface Config {
  judge: JudgeConfig;
  ui: UiConfig;
}

/**
 * Load configuration from .wavemill-config.json.
 * Falls back to defaults if not found or malformed.
 */
function loadConfig(repoDir: string): Config {
  const config = loadWavemillConfig(repoDir);

  const configModel = config.eval?.judge?.model || DEFAULT_MODEL;
  const configProvider = config.eval?.judge?.provider || DEFAULT_PROVIDER;
  const visualVerification = config.ui?.visualVerification ?? true;
  const devServer = config.ui?.devServer;

  // Validate provider
  if (!SUPPORTED_PROVIDERS.includes(configProvider)) {
    throw new Error(
      `Invalid review judge provider: "${configProvider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`
    );
  }

  return {
    judge: { model: configModel, provider: configProvider },
    ui: { visualVerification, devServer },
  };
}

// ────────────────────────────────────────────────────────────────
// Prompt Template
// ────────────────────────────────────────────────────────────────

/**
 * Load the review prompt template from tools/prompts/review.md
 */
function loadPromptTemplate(): string {
  const promptPath = join(__dirname, '../../tools/prompts/review.md');
  if (!existsSync(promptPath)) {
    throw new Error(`Review prompt template not found at: ${promptPath}`);
  }
  return readFileSync(promptPath, 'utf-8');
}

/**
 * Fill the prompt template with context.
 *
 * Substitutes:
 * - {{DIFF}}
 * - {{PLAN_CONTEXT}}
 * - {{TASK_PACKET_CONTEXT}}
 * - {{DESIGN_CONTEXT}}
 */
function fillPromptTemplate(
  template: string,
  context: ReviewContext,
  skipDesignContext: boolean
): string {
  const diff = context.diff || '(No diff available)';
  const plan = context.plan || 'No plan document provided.';
  const taskPacket = context.taskPacket || 'No task packet provided.';

  // Design context handling:
  // - If skipDesignContext is true OR designContext is null, set to null (which tells LLM to skip UI review)
  // - Otherwise, format design context for the prompt
  let designContext: string;
  if (skipDesignContext || context.designContext === null) {
    designContext = 'null';
  } else {
    designContext = formatDesignContext(context.designContext);
  }

  return template
    .replace('{{DIFF}}', diff)
    .replace('{{PLAN_CONTEXT}}', plan)
    .replace('{{TASK_PACKET_CONTEXT}}', taskPacket)
    .replace('{{DESIGN_CONTEXT}}', designContext);
}

/**
 * Format design context for the prompt.
 */
function formatDesignContext(ctx: DesignContext): string {
  const parts: string[] = [];

  if (ctx.designGuide) {
    parts.push('### Design Guide\n\n' + ctx.designGuide);
  }

  if (ctx.tailwindConfig) {
    parts.push('### Tailwind Config (Theme)\n\n```js\n' + ctx.tailwindConfig + '\n```');
  }

  if (ctx.componentLibrary) {
    parts.push(`### Component Library\n\n${ctx.componentLibrary}`);
  }

  if (ctx.cssVariables) {
    parts.push('### CSS Variables\n\n```css\n' + ctx.cssVariables + '\n```');
  }

  if (ctx.designTokens) {
    parts.push('### Design Tokens\n\n```json\n' + ctx.designTokens + '\n```');
  }

  if (ctx.storybook) {
    parts.push('### Storybook\n\nStorybook is configured in this repository.');
  }

  return parts.length > 0 ? parts.join('\n\n') : 'No design artifacts found.';
}

// ────────────────────────────────────────────────────────────────
// LLM Invocation
// ────────────────────────────────────────────────────────────────

/**
 * Invoke LLM with retry logic.
 */
async function invokeLLMWithRetry(
  prompt: string,
  model: string,
  maxRetries: number = MAX_RETRIES
): Promise<string> {
  const result = await callClaude(prompt, {
    mode: 'sync',
    model,
    timeout: TIMEOUT_MS, // 120000
    maxBuffer: 10 * 1024 * 1024,
    retry: true,
    maxRetries,
  });

  return result.text;
}

// ────────────────────────────────────────────────────────────────
// Response Parsing
// ────────────────────────────────────────────────────────────────

/**
 * Parse the LLM's JSON response into a ReviewResult.
 *
 * Expected format:
 * {
 *   "verdict": "ready" | "not_ready",
 *   "codeReviewFindings": [...],
 *   "uiFindings": [...]  // optional
 * }
 */
function parseReviewResponse(
  responseText: string,
  context: ReviewContext
): ReviewResult {
  const parsed = parseJsonFromLLM<any>(responseText);

  // Validate structure
  if (!parsed.verdict || !['ready', 'not_ready'].includes(parsed.verdict)) {
    throw new Error(`Invalid verdict in response: ${parsed.verdict}`);
  }

  if (!Array.isArray(parsed.codeReviewFindings)) {
    throw new Error('Missing or invalid codeReviewFindings array');
  }

  const result: ReviewResult = {
    verdict: parsed.verdict as 'ready' | 'not_ready',
    codeReviewFindings: parsed.codeReviewFindings,
    metadata: {
      branch: context.metadata.branch,
      files: context.metadata.files,
      hasUiChanges: context.metadata.hasUiChanges,
      designContextAvailable: context.designContext !== null,
      uiVerificationRun: false,
    },
  };

  // Include UI findings if present
  if (parsed.uiFindings && Array.isArray(parsed.uiFindings)) {
    result.uiFindings = parsed.uiFindings;
    if (result.metadata) {
      result.metadata.uiVerificationRun = true;
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

/**
 * Run a code review on the current branch.
 *
 * @param options - Review configuration options
 * @returns ReviewResult with verdict and findings
 */
export async function reviewChanges(
  options: ReviewOptions = {}
): Promise<ReviewResult> {
  const targetBranch = options.targetBranch || 'main';
  const repoDir = options.repoDir ? resolve(options.repoDir) : process.cwd();

  // Load configuration
  const config = loadConfig(repoDir);

  // Gather review context (skip design standards if explicitly requested)
  const context = gatherReviewContext(targetBranch, repoDir, {
    designStandards: !options.skipUi,
  });

  // Determine if UI verification should run
  const shouldRunUiVerification =
    !options.skipUi &&
    context.designContext !== null &&
    context.metadata.hasUiChanges &&
    config.ui.visualVerification;

  if (options.verbose) {
    console.error('=== Review Configuration ===');
    console.error(`Target branch: ${targetBranch}`);
    console.error(`Repository: ${repoDir}`);
    console.error(`Judge model: ${config.judge.model}`);
    console.error(`Design context available: ${context.designContext !== null}`);
    console.error(`UI changes detected: ${context.metadata.hasUiChanges}`);
    console.error(`UI verification enabled: ${config.ui.visualVerification}`);
    console.error(`Should run UI verification: ${shouldRunUiVerification}`);
    if (config.ui.devServer) {
      console.error(`Dev server: ${config.ui.devServer}`);
    }
    console.error('');
  }

  // UI Verification (Phase 2 - Future Enhancement)
  // Note: Screenshot capture and console checking would be implemented here
  if (shouldRunUiVerification) {
    if (options.verbose) {
      console.error('UI verification requested but screenshot capture not yet implemented.');
      console.error('Proceeding with static design context review only.');
      console.error('');
    }

    // Future implementation:
    // - Check for dev server availability
    // - Launch headless browser (Playwright/Puppeteer)
    // - Capture screenshots at breakpoints
    // - Capture console errors/warnings
    // - Add findings to context for LLM review
  }

  // Load prompt template
  const template = loadPromptTemplate();

  // Determine if we should skip design context in the prompt
  // Skip only if user explicitly requested --skip-ui
  const skipDesignContext = options.skipUi === true;

  // Fill prompt
  const prompt = fillPromptTemplate(template, context, skipDesignContext);

  if (options.verbose) {
    console.error('=== Review Prompt ===');
    console.error(prompt.substring(0, 500) + '...');
    console.error('');
  }

  // Invoke LLM
  if (options.verbose) {
    console.error(`Invoking ${config.judge.model}...`);
  }

  const responseText = await invokeLLMWithRetry(prompt, config.judge.model);

  if (options.verbose) {
    console.error('=== LLM Response ===');
    console.error(responseText);
    console.error('');
  }

  // Parse response
  const result = parseReviewResponse(responseText, context);

  // Update metadata to reflect if UI verification was attempted
  if (result.metadata && shouldRunUiVerification) {
    result.metadata.uiVerificationRun = result.uiFindings !== undefined && result.uiFindings.length > 0;
  }

  return result;
}
