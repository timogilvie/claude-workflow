#!/usr/bin/env -S npx tsx

/**
 * PR Review Tool
 *
 * Performs LLM-powered code review on a GitHub pull request.
 * Analyzes diff, task packet, plan, and design context to identify major issues.
 *
 * Usage:
 *   npx tsx tools/review-pr.ts <pr-number> [--repo owner/name]
 *   npx tsx tools/review-pr.ts 42
 *   npx tsx tools/review-pr.ts 42 --repo timogilvie/wavemill
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPullRequest, getPullRequestDiff } from '../shared/lib/github.js';
import { findTaskPacket, findPlan, gatherDesignContext } from '../shared/lib/review-context-gatherer.ts';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-opus-4-6';
const TIMEOUT_MS = 180_000; // 3 minutes for large diffs

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface ReviewFinding {
  severity: 'blocker' | 'warning';
  location: string;
  category: string;
  description: string;
}

interface ReviewResult {
  verdict: 'ready' | 'not_ready';
  codeReviewFindings: ReviewFinding[];
  uiFindings?: ReviewFinding[];
}

interface Args {
  prNumber: number;
  repo?: string;
  help?: boolean;
}

// ────────────────────────────────────────────────────────────────
// Argument Parsing
// ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = { prNumber: 0 };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) {
      args.repo = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    } else if (!args.prNumber && /^\d+$/.test(argv[i])) {
      args.prNumber = parseInt(argv[i], 10);
    }
  }

  return args;
}

function showHelp(): void {
  console.log(`
PR Review Tool — LLM-powered code review for pull requests

Usage:
  npx tsx tools/review-pr.ts <pr-number> [options]

Arguments:
  <pr-number>     Pull request number (required)

Options:
  --repo OWNER/NAME   Review PR from different repository
  --help, -h          Show this help message

Environment Variables:
  REVIEW_MODEL    Override review model (default: ${DEFAULT_MODEL})

Examples:
  # Review PR #42 in current repository
  npx tsx tools/review-pr.ts 42

  # Review PR in different repository
  npx tsx tools/review-pr.ts 42 --repo timogilvie/wavemill

Output:
  Displays structured review findings in the terminal:
  - Verdict (✅ READY or ❌ NOT READY)
  - Code review findings (blockers and warnings)
  - UI findings (if applicable)
  - Summary statistics

The review focuses on major issues:
  - Logical errors and edge cases
  - Security concerns
  - Deviation from plan/requirements
  - Missing error handling at boundaries
  - Architectural consistency
`);
}

// ────────────────────────────────────────────────────────────────
// Context Gathering
// ────────────────────────────────────────────────────────────────

/**
 * Extract slug from branch name.
 * Supports: task/*, feature/*, bugfix/*, bug/*
 */
function extractSlugFromBranch(branchName: string): string | null {
  const match = branchName.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Find task packet for a given branch name.
 * Checks features/ and bugs/ directories.
 */
function findTaskPacketForBranch(branchName: string, repoDir: string): string | null {
  const slug = extractSlugFromBranch(branchName);
  if (!slug) return null;

  // Try new split format in features/
  const featureHeaderPath = join(repoDir, 'features', slug, 'task-packet-header.md');
  const featureDetailsPath = join(repoDir, 'features', slug, 'task-packet-details.md');

  if (existsSync(featureHeaderPath)) {
    try {
      let content = readFileSync(featureHeaderPath, 'utf-8');
      if (existsSync(featureDetailsPath)) {
        const details = readFileSync(featureDetailsPath, 'utf-8');
        content = `${content}\n\n---\n\n${details}`;
      }
      return content;
    } catch {
      // Continue
    }
  }

  // Try legacy format in features/
  const featureLegacyPath = join(repoDir, 'features', slug, 'task-packet.md');
  if (existsSync(featureLegacyPath)) {
    try {
      return readFileSync(featureLegacyPath, 'utf-8');
    } catch {
      // Continue
    }
  }

  // Try bugs/ directory
  const bugsHeaderPath = join(repoDir, 'bugs', slug, 'task-packet-header.md');
  const bugsDetailsPath = join(repoDir, 'bugs', slug, 'task-packet-details.md');

  if (existsSync(bugsHeaderPath)) {
    try {
      let content = readFileSync(bugsHeaderPath, 'utf-8');
      if (existsSync(bugsDetailsPath)) {
        const details = readFileSync(bugsDetailsPath, 'utf-8');
        content = `${content}\n\n---\n\n${details}`;
      }
      return content;
    } catch {
      // Continue
    }
  }

  const bugsLegacyPath = join(repoDir, 'bugs', slug, 'task-packet.md');
  if (existsSync(bugsLegacyPath)) {
    try {
      return readFileSync(bugsLegacyPath, 'utf-8');
    } catch {
      // Not found
    }
  }

  return null;
}

/**
 * Find plan for a given branch name.
 * Checks features/ and bugs/ directories.
 */
function findPlanForBranch(branchName: string, repoDir: string): string | null {
  const slug = extractSlugFromBranch(branchName);
  if (!slug) return null;

  // Try features/
  const featurePlanPath = join(repoDir, 'features', slug, 'plan.md');
  if (existsSync(featurePlanPath)) {
    try {
      return readFileSync(featurePlanPath, 'utf-8');
    } catch {
      // Continue
    }
  }

  // Try bugs/
  const bugsPlanPath = join(repoDir, 'bugs', slug, 'plan.md');
  if (existsSync(bugsPlanPath)) {
    try {
      return readFileSync(bugsPlanPath, 'utf-8');
    } catch {
      // Not found
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────────
// LLM Integration
// ────────────────────────────────────────────────────────────────

/**
 * Load review prompt template.
 */
function loadReviewTemplate(): string {
  const templatePath = join(__dirname, 'prompts', 'review.md');
  return readFileSync(templatePath, 'utf-8');
}

/**
 * Build review prompt by substituting template parameters.
 */
function buildReviewPrompt(
  template: string,
  diff: string,
  plan: string | null,
  taskPacket: string | null,
  designContext: any | null
): string {
  let prompt = template;

  // Substitute diff
  prompt = prompt.replace('{{DIFF}}', diff);

  // Substitute plan context
  const planText = plan || 'No implementation plan available for this PR.';
  prompt = prompt.replace('{{PLAN_CONTEXT}}', planText);

  // Substitute task packet context
  const taskPacketText = taskPacket || 'No task packet available for this PR.';
  prompt = prompt.replace('{{TASK_PACKET_CONTEXT}}', taskPacketText);

  // Substitute design context
  if (designContext) {
    const designText = JSON.stringify(designContext, null, 2);
    prompt = prompt.replace('{{DESIGN_CONTEXT}}', designText);
  } else {
    prompt = prompt.replace('{{DESIGN_CONTEXT}}', 'null');
  }

  return prompt;
}

/**
 * Call Claude CLI with prompt.
 * Returns parsed JSON response.
 */
function callClaude(prompt: string, model: string): ReviewResult {
  const tmpFile = join(tmpdir(), `wavemill-review-${Date.now()}.txt`);

  try {
    writeFileSync(tmpFile, prompt, 'utf-8');

    const raw = execSync(
      `claude -p --output-format json --model "${model}" < "${tmpFile}"`,
      {
        encoding: 'utf-8',
        timeout: TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024,
        shell: '/bin/bash',
        env: { ...process.env, CLAUDECODE: '' },
      }
    );

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

    // Parse review result from text
    return parseReviewResult(text);
  } catch (error) {
    throw new Error(`Failed to call Claude: ${(error as Error).message}`);
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Parse review result from Claude's response.
 * Handles markdown code fences and extracts JSON.
 */
function parseReviewResult(text: string): ReviewResult {
  // Try to extract JSON from code fence
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch (error) {
      // Continue to fallback
    }
  }

  // Try to find the first complete JSON object
  const jsonMatch = text.match(/(\{[\s\S]*?\n\})/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (error) {
      // Continue to fallback
    }
  }

  // Fallback: strip code fences and try to parse
  let cleaned = text
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Failed to parse review result as JSON: ${(error as Error).message}\n\nRaw response:\n${text.substring(0, 500)}...`);
  }
}

// ────────────────────────────────────────────────────────────────
// Output Formatting
// ────────────────────────────────────────────────────────────────

/**
 * Display formatted review results in terminal.
 */
function displayResults(result: ReviewResult, prNumber: number, prTitle: string): void {
  console.log('\n' + '='.repeat(80));
  console.log(`PR #${prNumber}: ${prTitle}`);
  console.log('='.repeat(80) + '\n');

  // Display verdict
  if (result.verdict === 'ready') {
    console.log('✅ \x1b[32mREADY TO MERGE\x1b[0m - No blocking issues found\n');
  } else {
    console.log('❌ \x1b[31mNOT READY\x1b[0m - Blocking issues must be addressed\n');
  }

  // Count findings by severity
  const codeBlockers = result.codeReviewFindings.filter(f => f.severity === 'blocker');
  const codeWarnings = result.codeReviewFindings.filter(f => f.severity === 'warning');
  const uiBlockers = result.uiFindings?.filter(f => f.severity === 'blocker') || [];
  const uiWarnings = result.uiFindings?.filter(f => f.severity === 'warning') || [];

  const totalBlockers = codeBlockers.length + uiBlockers.length;
  const totalWarnings = codeWarnings.length + uiWarnings.length;

  // Display summary
  console.log('📊 \x1b[1mSummary\x1b[0m');
  console.log(`   Blockers: ${totalBlockers}`);
  console.log(`   Warnings: ${totalWarnings}`);
  console.log('');

  // Display code review findings
  if (result.codeReviewFindings.length > 0) {
    console.log('💻 \x1b[1mCode Review Findings\x1b[0m\n');

    if (codeBlockers.length > 0) {
      console.log('  \x1b[31m🚫 BLOCKERS\x1b[0m\n');
      codeBlockers.forEach((finding, idx) => {
        console.log(`  ${idx + 1}. \x1b[31m${finding.location}\x1b[0m [${finding.category}]`);
        console.log(`     ${finding.description}\n`);
      });
    }

    if (codeWarnings.length > 0) {
      console.log('  \x1b[33m⚠️  WARNINGS\x1b[0m\n');
      codeWarnings.forEach((finding, idx) => {
        console.log(`  ${idx + 1}. \x1b[33m${finding.location}\x1b[0m [${finding.category}]`);
        console.log(`     ${finding.description}\n`);
      });
    }
  } else {
    console.log('💻 \x1b[1mCode Review\x1b[0m');
    console.log('   \x1b[32m✓\x1b[0m No issues found\n');
  }

  // Display UI findings (if present)
  if (result.uiFindings && result.uiFindings.length > 0) {
    console.log('🎨 \x1b[1mUI Review Findings\x1b[0m\n');

    if (uiBlockers.length > 0) {
      console.log('  \x1b[31m🚫 BLOCKERS\x1b[0m\n');
      uiBlockers.forEach((finding, idx) => {
        console.log(`  ${idx + 1}. \x1b[31m${finding.location}\x1b[0m [${finding.category}]`);
        console.log(`     ${finding.description}\n`);
      });
    }

    if (uiWarnings.length > 0) {
      console.log('  \x1b[33m⚠️  WARNINGS\x1b[0m\n');
      uiWarnings.forEach((finding, idx) => {
        console.log(`  ${idx + 1}. \x1b[33m${finding.location}\x1b[0m [${finding.category}]`);
        console.log(`     ${finding.description}\n`);
      });
    }
  }

  console.log('='.repeat(80) + '\n');
}

// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Show help
  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Validate PR number
  if (!args.prNumber) {
    console.error('Error: PR number is required\n');
    showHelp();
    process.exit(1);
  }

  const repoDir = process.cwd();
  const model = process.env.REVIEW_MODEL || DEFAULT_MODEL;

  try {
    console.log(`\n🔍 Reviewing PR #${args.prNumber}...\n`);

    // Fetch PR metadata
    console.log('📥 Fetching PR metadata...');
    const pr = getPullRequest(args.prNumber, { repo: args.repo });
    console.log(`   Title: ${pr.title}`);
    console.log(`   Author: ${pr.author}`);
    console.log(`   Branch: ${pr.headRefName} → ${pr.baseRefName}`);
    console.log('');

    // Fetch PR diff
    console.log('📄 Fetching PR diff...');
    const { diff } = getPullRequestDiff(args.prNumber, { repo: args.repo });
    console.log(`   ${diff.split('\n').length} lines\n`);

    // Find task packet and plan
    console.log('📋 Gathering context...');
    const taskPacket = findTaskPacketForBranch(pr.headRefName, repoDir);
    const plan = findPlanForBranch(pr.headRefName, repoDir);
    console.log(`   Task packet: ${taskPacket ? '✓ found' : '✗ not found'}`);
    console.log(`   Plan: ${plan ? '✓ found' : '✗ not found'}`);

    // Gather design context
    const designContext = gatherDesignContext(repoDir);
    console.log(`   Design context: ${designContext ? '✓ found' : '✗ not found'}`);
    console.log('');

    // Load review template
    console.log('📝 Loading review template...');
    const template = loadReviewTemplate();
    console.log('   ✓ Loaded\n');

    // Build prompt
    console.log('🔨 Building review prompt...');
    const prompt = buildReviewPrompt(template, diff, plan, taskPacket, designContext);
    console.log('   ✓ Ready\n');

    // Call Claude
    console.log(`🤖 Running review with ${model}...`);
    console.log('   (this may take 1-3 minutes for large diffs)\n');
    const result = callClaude(prompt, model);

    // Display results
    displayResults(result, args.prNumber, pr.title);

    // Exit with appropriate code
    process.exit(result.verdict === 'ready' ? 0 : 1);
  } catch (error) {
    console.error(`\n❌ Error: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

main();
