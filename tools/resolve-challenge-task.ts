#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import { pickChallengeModels, pickChallengeWorkflows, getChallengeModelPool, canRunChallenge } from '../shared/lib/challenge-mode.ts';
import { resolveAgent } from '../shared/lib/model-router.ts';
import { readTaskPromptFromFile } from '../shared/lib/workflow-router.ts';

runTool({
  name: 'resolve-challenge-task',
  description: 'Resolve whether a mill task should run in challenge mode and return the launch plan.',
  options: {
    issue: { type: 'string', description: 'Task key / issue identifier' },
    slug: { type: 'string', description: 'Base task slug' },
    title: { type: 'string', description: 'Task title' },
    'primary-model': { type: 'string', description: 'Router-selected or forced primary model' },
    'remaining-slots': { type: 'string', description: 'Available mill slots before launch' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
    file: { type: 'string', description: 'Task packet file path (for routing)' },
  },
  async run({ args }) {
    const repoDir = (args['repo-dir'] as string) || process.cwd();
    const issue = args.issue as string;
    const slug = args.slug as string;
    const title = args.title as string;
    const primaryModel = (args['primary-model'] as string | undefined)?.trim() || undefined;
    const remainingSlots = Number(args['remaining-slots'] || '1');
    const taskFile = args.file as string | undefined;

    if (!issue || !slug || !title) {
      throw new Error('--issue, --slug, and --title are required');
    }

    const config = loadWavemillConfig(repoDir);
    const challenge = config.challenge || {};
    const router = config.router || {};
    const defaultAgent = router.defaultAgent || 'claude';
    const pool = getChallengeModelPool(challenge, router);

    const singleAgent = primaryModel
      ? resolveAgent(primaryModel, router.agentMap || {}, defaultAgent)
      : defaultAgent;

    const base = {
      issue,
      slug,
      title,
      mode: 'single',
      slotsRequired: 1,
      reason: 'challenge_disabled',
      single: {
        key: issue,
        issueId: issue,
        slug,
        branch: `task/${slug}`,
        role: 'primary',
        model: primaryModel || '',
        agent: singleAgent,
      },
    };

    if (challenge.enabled !== true) {
      console.log(JSON.stringify(base));
      return;
    }

    if (remainingSlots < 2) {
      console.log(JSON.stringify({ ...base, reason: 'insufficient_slots' }));
      return;
    }

    if (!canRunChallenge(pool)) {
      console.log(JSON.stringify({ ...base, reason: 'insufficient_models' }));
      return;
    }

    const rate = challenge.rate ?? 0.10;
    if (Math.random() >= rate) {
      console.log(JSON.stringify({ ...base, reason: 'roll_not_selected' }));
      return;
    }

    // If task file provided, use workflow routing for both sides
    let pair;
    if (taskFile) {
      try {
        const prompt = readTaskPromptFromFile(taskFile);
        pair = pickChallengeWorkflows(pool, prompt, {
          pairId: issue,
          issueId: issue,
          slug,
          primaryModel,
          agentMap: router.agentMap,
          defaultAgent,
          repoDir,
        });
      } catch (error) {
        // Fall back to model-only selection if task file is unreadable
        console.error(`Warning: Failed to read task file for routing: ${error}`);
        pair = pickChallengeModels(pool, {
          pairId: issue,
          issueId: issue,
          slug,
          primaryModel,
          agentMap: router.agentMap,
          defaultAgent,
        });
      }
    } else {
      // No task file provided - use model-only selection (backward compatibility)
      pair = pickChallengeModels(pool, {
        pairId: issue,
        issueId: issue,
        slug,
        primaryModel,
        agentMap: router.agentMap,
        defaultAgent,
      });
    }

    if (!pair) {
      console.log(JSON.stringify({ ...base, reason: 'selection_failed' }));
      return;
    }

    console.log(JSON.stringify({
      issue,
      slug,
      title,
      mode: 'challenge',
      slotsRequired: 2,
      reason: 'selected',
      primaryModel,
      entries: [pair.primary, pair.challenger],
    }));
  },
});
