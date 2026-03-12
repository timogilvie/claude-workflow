#!/usr/bin/env -S npx tsx
import '../shared/lib/env.js';
import { runTool } from '../shared/lib/tool-runner.ts';
import { installIssueProcessTimeout, printIssue } from '../shared/lib/issue-tool.ts';

installIssueProcessTimeout();

runTool({
  name: 'get-issue',
  description: 'Fetch and display a Linear issue',
  options: {
    json: { type: 'boolean', description: 'Output raw issue JSON' },
  },
  positional: {
    name: 'identifier',
    description: 'Issue identifier (e.g., HOK-123)',
    required: true,
  },
  examples: [
    'npx tsx tools/get-issue.ts HOK-671',
    'npx tsx tools/get-issue.ts HOK-123',
    'npx tsx tools/get-issue.ts HOK-123 --json | jq .',
  ],
  async run({ args, positional }) {
    const identifier = positional[0];

    if (!identifier) {
      console.error('Error: Issue identifier is required');
      process.exit(1);
    }

    await printIssue(identifier, { json: !!args.json });
  },
});
