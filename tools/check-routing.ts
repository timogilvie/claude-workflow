#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { checkRoutingHealth, formatRoutingHealth } from '../shared/lib/check-routing.ts';

runTool({
  name: 'check-routing',
  description: 'Validate workflow routing inputs and print a sample route',
  options: {
    json: {
      type: 'boolean',
      description: 'Output machine-readable JSON',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory to inspect (default: current directory)',
    },
    prompt: {
      type: 'string',
      description: 'Sample prompt to route during the health check',
    },
  },
  examples: [
    'npx tsx tools/check-routing.ts',
    'npx tsx tools/check-routing.ts --json',
    'npx tsx tools/check-routing.ts --repo-dir ~/src/wavemill --prompt "Fix workflow routing fallback"',
  ],
  async run({ args }) {
    const report = await checkRoutingHealth(args['repo-dir'] || process.cwd(), args.prompt);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatRoutingHealth(report));
  },
});
