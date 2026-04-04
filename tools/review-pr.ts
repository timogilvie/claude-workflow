#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { getPullRequest, getPullRequestDiff } from '../shared/lib/github.js';
import { findTaskPacket, findPlan, gatherDesignContext, analyzeDiffMetadata, type ReviewContext } from '../shared/lib/review-context-gatherer.ts';
import { runReview, type ReviewerPersona } from '../shared/lib/review-engine.ts';
import { displayPrReviewResults } from '../shared/lib/review-formatter.ts';

const TIMEOUT_MS = 180_000; // 3 minutes for large PR diffs
// This file now focuses on PR-specific operations: fetching from GitHub and displaying results

runTool({
  name: 'review-pr',
  description: 'LLM-powered code review for pull requests',
  options: {
    repo: { type: 'string', description: 'Review PR from different repository (OWNER/NAME)' },
    reviewers: { type: 'string', description: 'Comma-separated list of reviewers (general,security,performance,correctness,design) or "all"' },
  },
  positional: {
    name: 'prNumber',
    description: 'Pull request number (required)',
  },
  examples: [
    'npx tsx tools/review-pr.ts 42',
    'npx tsx tools/review-pr.ts 42 --repo timogilvie/wavemill',
    'npx tsx tools/review-pr.ts 42 --reviewers security,performance',
    'npx tsx tools/review-pr.ts 42 --reviewers all',
  ],
  additionalHelp: `Environment Variables:
  REVIEW_MODEL    Override review model (uses .wavemill-config.json if not set)

Reviewer Personas:
  general         Default broad review (bugs, security, architecture, requirements)
  security        Authentication, injection, secrets, smart contracts, OWASP top 10
  performance     N+1 queries, re-renders, bundle size, caching, algorithms
  correctness     Edge cases, off-by-one, race conditions, type safety
  design          Visual hierarchy, spacing, colors, polish (requires ui.creativeDirection: true)

The review focuses on major issues:
  - Logical errors and edge cases
  - Security concerns
  - Deviation from plan/requirements
  - Missing error handling at boundaries
  - Architectural consistency`,
  async run({ args, positional }) {
    const prNumber = positional[0] ? parseInt(positional[0], 10) : 0;
    if (!prNumber) {
      console.error('Error: PR number is required');
      process.exit(1);
    }

    const repoDir = process.cwd();
    const model = process.env.REVIEW_MODEL;

    // Parse reviewers argument
    const reviewersArg = args.reviewers as string | undefined;
    let reviewers: ReviewerPersona[] = ['general']; // default

    if (reviewersArg === 'all') {
      reviewers = ['general', 'security', 'performance', 'correctness', 'design'];
    } else if (reviewersArg) {
      const parsed = reviewersArg.split(',').map(r => r.trim()) as ReviewerPersona[];
      const valid: ReviewerPersona[] = ['general', 'security', 'performance', 'correctness', 'design'];
      const invalid = parsed.filter(p => !valid.includes(p));

      if (invalid.length > 0) {
        console.error(`Error: Invalid reviewer personas: ${invalid.join(', ')}`);
        console.error(`Valid options: ${valid.join(', ')}`);
        process.exit(1);
      }

      reviewers = parsed;
    }

    try {
      console.log(`\n🔍 Reviewing PR #${prNumber}...\n`);

      if (reviewers.length > 1 || reviewers[0] !== 'general') {
        console.log(`📋 Reviewers: ${reviewers.join(', ')}\n`);
      }

      console.log('📥 Fetching PR metadata...');
      const pr = getPullRequest(prNumber, { repo: args.repo as string | undefined });
      console.log(`   Title: ${pr.title}`);
      console.log(`   Author: ${pr.author}`);
      console.log(`   Branch: ${pr.headRefName} → ${pr.baseRefName}`);
      console.log('');

      console.log('📄 Fetching PR diff...');
      const { diff } = getPullRequestDiff(prNumber, { repo: args.repo as string | undefined });
      console.log(`   ${diff.split('\n').length} lines\n`);

      console.log('📋 Gathering context...');
      const taskPacket = findTaskPacket(pr.headRefName, repoDir);
      const plan = findPlan(pr.headRefName, repoDir);
      const designContext = gatherDesignContext(repoDir);
      console.log(`   Task packet: ${taskPacket ? '✓ found' : '✗ not found'}`);
      console.log(`   Plan: ${plan ? '✓ found' : '✗ not found'}`);
      console.log(`   Design context: ${designContext ? '✓ found' : '✗ not found'}`);
      console.log('');

      const { files, lineCount, hasUiChanges } = analyzeDiffMetadata(diff);

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

      console.log('🤖 Running review...');
      console.log('   (this may take 1-3 minutes for large diffs)\n');
      const result = await runReview(context, repoDir, {
        model,
        timeout: TIMEOUT_MS,
        reviewers,
      });

      displayPrReviewResults(result, prNumber, pr.title);
      process.exit(result.verdict === 'ready' ? 0 : 1);
    } catch (error) {
      console.error(`\n❌ Error: ${(error as Error).message}\n`);
      process.exit(1);
    }
  },
});
