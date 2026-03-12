#!/usr/bin/env -S npx tsx
import '../shared/lib/env.js';
import { runTool } from '../shared/lib/tool-runner.ts';
import { installIssueProcessTimeout, printIssue } from '../shared/lib/issue-tool.ts';

installIssueProcessTimeout();

runTool({
  name: 'get-issue-json',
  description: 'Fetch a Linear issue and output as JSON',
  options: {
  },
  positional: {
    name: 'identifier',
    description: 'Issue identifier (e.g., HOK-123)',
    required: true,
  },
  examples: [
    'npx tsx tools/get-issue-json.ts HOK-671',
    'npx tsx tools/get-issue-json.ts HOK-123 | jq .',
  ],
  async run({ positional }) {
    const identifier = positional[0];

    if (!identifier) {
      console.error('Error: Issue identifier is required');
      process.exit(1);
    }

    await printIssue(identifier, { json: true });
  },
});
