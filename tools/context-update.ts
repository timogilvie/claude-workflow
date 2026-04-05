#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveRepoDir } from '../shared/lib/context-tool.ts';
import { updateSubsystemSpec } from '../shared/lib/context-updater.ts';

runTool({
  name: 'context-update',
  description: 'Refresh a specific subsystem spec',
  options: {
    'no-confirm': { type: 'boolean', description: 'Skip diff confirmation (apply changes automatically)' },
  },
  positional: {
    name: 'subsystemId repoPath',
    description: 'Subsystem ID and optional repository path',
    multiple: true,
  },
  examples: [
    'npx tsx tools/context-update.ts linear-api',
    'npx tsx tools/context-update.ts linear-api --no-confirm',
  ],
  additionalHelp: `Reads source files and uses LLM to generate an updated specification.
Preserves structure and manual edits where possible.`,
  async run({ args, positional }) {
    const subsystemId = positional[0];
    if (!subsystemId) {
      throw new Error('Subsystem ID is required');
    }
    const repoDir = resolveRepoDir(positional[1]);
    await updateSubsystemSpec({
      subsystemId,
      repoDir,
      noConfirm: !!args['no-confirm'],
    });
  },
});
