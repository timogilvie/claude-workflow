#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { getCurrentOperatingMode } from '../shared/lib/operating-mode.ts';

runTool({
  name: 'get-operating-mode',
  description: 'Print current operating mode (normal | constrained | survival)',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory (default: cwd)' },
    json: { type: 'boolean', description: 'Output as JSON object' },
  },
  examples: [
    'npx tsx tools/get-operating-mode.ts',
    'npx tsx tools/get-operating-mode.ts --json',
    'npx tsx tools/get-operating-mode.ts --repo-dir /path/to/repo',
  ],
  async run({ args }) {
    const repoDir = (args['repo-dir'] as string | undefined) ?? process.cwd();
    const mode = getCurrentOperatingMode(repoDir);
    if (args.json) {
      console.log(JSON.stringify({ mode }));
    } else {
      console.log(mode);
    }
  },
});
