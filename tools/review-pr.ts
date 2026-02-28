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

import { getPullRequest, getPullRequestDiff } from '../shared/lib/github.js';
import { findTaskPacket, findPlan, gatherDesignContext, analyzeDiffMetadata, type ReviewContext } from '../shared/lib/review-context-gatherer.ts';
import { runReview, type ReviewResult, type ReviewFinding } from '../shared/lib/review-engine.ts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 180_000; // 3 minutes for large PR diffs

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

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
  REVIEW_MODEL    Override review model (uses .wavemill-config.json if not set)

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

// Note: All review logic moved to shared/lib/review-engine.ts
// This file now focuses on PR-specific operations: fetching from GitHub and displaying results

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

  // Separate plan compliance findings from other code findings
  const planComplianceFindings = result.codeReviewFindings.filter(f => f.category === 'plan_compliance');
  const otherCodeFindings = result.codeReviewFindings.filter(f => f.category !== 'plan_compliance');

  // Count findings by severity
  const codeBlockers = otherCodeFindings.filter(f => f.severity === 'blocker');
  const codeWarnings = otherCodeFindings.filter(f => f.severity === 'warning');
  const planBlockers = planComplianceFindings.filter(f => f.severity === 'blocker');
  const planWarnings = planComplianceFindings.filter(f => f.severity === 'warning');
  const uiBlockers = result.uiFindings?.filter(f => f.severity === 'blocker') || [];
  const uiWarnings = result.uiFindings?.filter(f => f.severity === 'warning') || [];

  const totalBlockers = codeBlockers.length + planBlockers.length + uiBlockers.length;
  const totalWarnings = codeWarnings.length + planWarnings.length + uiWarnings.length;

  // Display summary
  console.log('📊 \x1b[1mSummary\x1b[0m');
  console.log(`   Blockers: ${totalBlockers}`);
  console.log(`   Warnings: ${totalWarnings}`);
  console.log('');

  // Display code review findings (excluding plan compliance)
  if (otherCodeFindings.length > 0) {
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

  // Display plan compliance findings (if present)
  if (planComplianceFindings.length > 0) {
    console.log('📋 \x1b[1mPlan Compliance\x1b[0m\n');

    if (planBlockers.length > 0) {
      console.log('  \x1b[31m🚫 BLOCKERS\x1b[0m\n');
      planBlockers.forEach((finding, idx) => {
        console.log(`  ${idx + 1}. \x1b[31m${finding.location}\x1b[0m`);
        console.log(`     ${finding.description}\n`);
      });
    }

    if (planWarnings.length > 0) {
      console.log('  \x1b[33m⚠️  WARNINGS\x1b[0m\n');
      planWarnings.forEach((finding, idx) => {
        console.log(`  ${idx + 1}. \x1b[33m${finding.location}\x1b[0m`);
        console.log(`     ${finding.description}\n`);
      });
    }
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
  const model = process.env.REVIEW_MODEL; // Optional override

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

    // Gather context
    console.log('📋 Gathering context...');
    const taskPacket = findTaskPacket(pr.headRefName, repoDir);
    const plan = findPlan(pr.headRefName, repoDir);
    const designContext = gatherDesignContext(repoDir);
    console.log(`   Task packet: ${taskPacket ? '✓ found' : '✗ not found'}`);
    console.log(`   Plan: ${plan ? '✓ found' : '✗ not found'}`);
    console.log(`   Design context: ${designContext ? '✓ found' : '✗ not found'}`);
    console.log('');

    // Analyze diff metadata
    const { files, lineCount, hasUiChanges } = analyzeDiffMetadata(diff);

    // Build review context
    const context: ReviewContext = {
      diff,
      taskPacket,
      plan,
      designContext,
      metadata: {
        branch: pr.headRefName,
        files,
        lineCount,
        hasUiChanges,
      },
    };

    // Run review using shared engine
    console.log('🤖 Running review...');
    console.log('   (this may take 1-3 minutes for large diffs)\n');
    const result = await runReview(context, repoDir, {
      model, // Uses config if undefined
      timeout: TIMEOUT_MS, // 180s for large PR diffs
    });

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
