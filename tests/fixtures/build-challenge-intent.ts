#!/usr/bin/env -S npx tsx
/**
 * Emit a canonical challenge intent using the *production* builder.
 *
 * Shell tests must never hand-write a challenge intent. The bug this guards
 * against shipped green three times because a regression fixture was authored
 * from an assumption about the schema rather than captured from the builder:
 * it combined envelope fields (`schemaVersion`, `selectedStage`) with
 * projection-shaped sides carrying `expectedRoute`, a combination no code path
 * ever produced. The test passed; production silently discarded the selected
 * challenge arm on every rerouting pass.
 *
 * Usage:
 *   npx tsx tests/fixtures/build-challenge-intent.ts \
 *     --stage review \
 *     --pair-id HOK-1512 \
 *     --primary-reviewer gpt-5.6-terra --primary-reviewer-agent codex \
 *     --challenger-reviewer kimi-k2 --challenger-reviewer-agent native-openrouter
 *
 * Any stage slot not supplied defaults to a shared placeholder, matching how a
 * real pair shares every stage except the one it varies.
 */

import { buildChallengeExecutionIntent, type ChallengeStage } from '../../shared/lib/challenge-mode.ts';

function arg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const stageInput = arg('stage', 'implementation');
const stage: ChallengeStage =
  stageInput === 'plan' || stageInput === 'review' ? stageInput : 'implementation';

const pairId = arg('pair-id', 'HOK-1512');
const issueId = arg('issue-id', pairId);

function side(role: 'primary' | 'challenger') {
  return {
    key: role === 'primary' ? pairId : `${pairId}_c`,
    issueId,
    slug: arg('slug', 'test-slug'),
    branch: `task/${arg('slug', 'test-slug')}`,
    role,
    model: arg(`${role}-coder`, 'bootstrap-coder'),
    agent: arg(`${role}-coder-agent`, 'claude'),
    planner: arg(`${role}-planner`, 'bootstrap-planner'),
    plannerAgent: arg(`${role}-planner-agent`, 'claude'),
    reviewer: arg(`${role}-reviewer`, 'bootstrap-reviewer'),
    reviewerAgent: arg(`${role}-reviewer-agent`, 'claude'),
    planDepth: arg('plan-depth', 'light'),
    codeDepth: arg('code-depth', 'medium'),
    reviewMode: arg('review-mode', 'llm'),
  };
}

const intent = buildChallengeExecutionIntent({
  pairId,
  issueId,
  selectedStage: stage,
  decisionSource: 'bootstrap',
  selectionPath: 'random-roll',
  primary: side('primary'),
  challenger: side('challenger'),
});

process.stdout.write(`${JSON.stringify(intent)}\n`);
