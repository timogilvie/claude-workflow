#!/usr/bin/env -S npx tsx

/**
 * Route Task Tool
 *
 * Produces stage-aware workflow routing guidance for planning, coding, and review.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { routeWorkflow, readTaskPromptFromFile, summarizeWorkflowRoute } from '../shared/lib/workflow-router.ts';

runTool({
  name: 'route-task',
  description: 'Recommend planner/coder/reviewer models and expected workflow cost',
  options: {
    file: {
      type: 'string',
      description: 'Read task prompt from a file instead of CLI argument',
    },
    json: {
      type: 'boolean',
      description: 'Output machine-readable JSON',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
  },
  positional: {
    name: 'prompt',
    description: 'Task text to route',
    multiple: true,
  },
  examples: [
    '# Route a task from inline text',
    'npx tsx tools/route-task.ts "Create a route CLI command with JSON output"',
    '',
    '# Route a selected-task file',
    'npx tsx tools/route-task.ts --file features/my-feature/selected-task.json',
    '',
    '# Return JSON for scripting',
    'npx tsx tools/route-task.ts --json --file features/my-feature/selected-task.json',
  ],
  async run({ args, positional }) {
    let prompt = '';
    if (args.file) {
      try {
        prompt = readTaskPromptFromFile(args.file);
      } catch (err) {
        throw new Error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (positional.length > 0) {
      prompt = positional.join(' ');
    } else {
      throw new Error('Provide a task prompt as argument or via --file. Run with --help for usage information.');
    }

    const repoDir = args['repo-dir'] || process.cwd();
    const decision = routeWorkflow(prompt, { repoDir });

    if (args.json) {
      console.log(JSON.stringify(decision, null, 2));
      return;
    }

    console.log(summarizeWorkflowRoute(decision, repoDir));
  },
});
