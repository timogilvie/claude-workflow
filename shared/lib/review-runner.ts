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

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  gatherReviewContext,
  type ReviewContext,
  type DesignContext,
} from './review-context-gatherer.js';

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

/**
 * Load judge config from .wavemill-config.json.
 * Falls back to defaults if not found or malformed.
 */
function loadJudgeConfig(repoDir: string): JudgeConfig {
  let configModel = DEFAULT_MODEL;
  let configProvider = DEFAULT_PROVIDER;

  const configPath = join(repoDir, '.wavemill-config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.eval?.judge?.model) {
        configModel = config.eval.judge.model;
      }
      if (config.eval?.judge?.provider) {
        configProvider = config.eval.judge.provider;
      }
    } catch {
      // Malformed config — use defaults
    }
  }

  // Validate provider
  if (!SUPPORTED_PROVIDERS.includes(configProvider)) {
    throw new Error(
      `Invalid review judge provider: "${configProvider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`
    );
  }

  return { model: configModel, provider: configProvider };
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
 * Invoke Claude CLI with the review prompt.
 * Returns the raw response text.
 */
async function callClaude(prompt: string, model: string): Promise<string> {
  // Write prompt to temp file to avoid shell argument-length limits
  const tmpFile = join(tmpdir(), `wavemill-review-${Date.now()}.txt`);

  try {
    writeFileSync(tmpFile, prompt, 'utf-8');

    const raw = execSync(
      `claude -p --output-format json --model "${model}" < "${tmpFile}"`,
      {
        encoding: 'utf-8',
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        shell: '/bin/bash',
        env: { ...process.env, CLAUDECODE: '' },
      }
    );

    // Parse JSON response
    let text = '';
    try {
      const data = JSON.parse(raw);
      text = (data.result || '').trim();
    } catch {
      // If JSON parse fails, treat entire output as text
      text = raw.trim();
    }

    if (!text) {
      throw new Error('Empty response from Claude CLI');
    }

    return text;
  } finally {
    // Clean up temp file
    if (existsSync(tmpFile)) {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Best effort cleanup
      }
    }
  }
}

/**
 * Invoke LLM with retry logic.
 */
async function invokeLLMWithRetry(
  prompt: string,
  model: string,
  maxRetries: number = MAX_RETRIES
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callClaude(prompt, model);
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.pow(2, attempt + 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(
    `LLM invocation failed after ${maxRetries + 1} attempts: ${lastError?.message}`
  );
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
  // Extract JSON from response (may have markdown code blocks)
  let jsonText = responseText.trim();

  // Remove markdown code fence if present
  if (jsonText.startsWith('```json')) {
    jsonText = jsonText.replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '');
  } else if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```\s*$/, '');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Failed to parse LLM response as JSON: ${(error as Error).message}`);
  }

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
  const judgeConfig = loadJudgeConfig(repoDir);

  // Gather review context
  const context = gatherReviewContext(targetBranch, repoDir, {
    designStandards: !options.skipUi,
  });

  // Load prompt template
  const template = loadPromptTemplate();

  // Determine if we should skip design context in the prompt
  const skipDesignContext = options.skipUi || options.uiOnly === true;

  // Fill prompt
  const prompt = fillPromptTemplate(template, context, skipDesignContext);

  if (options.verbose) {
    console.error('=== Review Prompt ===');
    console.error(prompt.substring(0, 500) + '...');
    console.error('');
  }

  // Invoke LLM
  if (options.verbose) {
    console.error(`Invoking ${judgeConfig.model}...`);
  }

  const responseText = await invokeLLMWithRetry(prompt, judgeConfig.model);

  if (options.verbose) {
    console.error('=== LLM Response ===');
    console.error(responseText);
    console.error('');
  }

  // Parse response
  const result = parseReviewResponse(responseText, context);

  return result;
}
