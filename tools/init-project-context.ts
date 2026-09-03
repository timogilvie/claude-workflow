#!/usr/bin/env -S npx tsx
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { generateProjectContext } from '../shared/lib/project-context-generator.ts';

runTool({
  name: 'init-project-context',
  description: 'Initialize project context documentation',
  options: {
    force: { type: 'boolean', short: 'f', description: 'Overwrite existing project-context.md' },
    refresh: { type: 'boolean', description: 'Refresh generated navigation while preserving existing documentation' },
  },
  positional: {
    name: 'repoPath',
    description: 'Repository path (default: current directory)',
  },
  examples: [
    'npx tsx tools/init-project-context.ts',
    'npx tsx tools/init-project-context.ts /path/to/repo',
    'npx tsx tools/init-project-context.ts --force',
    'npx tsx tools/init-project-context.ts --refresh',
  ],
  additionalHelp: `Analyzes a codebase and generates the initial .wavemill/project-context.md file.
This file maintains living documentation of architectural decisions, patterns, conventions, and recent work.`,
  async run({ args, positional }) {
    const repoDir = resolveRepoDir(positional[0]);
    await generateProjectContext({ repoDir, force: !!args.force, refresh: !!args.refresh });
  },
});
