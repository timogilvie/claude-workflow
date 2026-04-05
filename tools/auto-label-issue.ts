#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { autoLabelIssue } from '../shared/lib/issue-labeler.ts';

runTool({
  name: 'auto-label-issue',
  description: 'Automatically label Linear issues based on content',
  options: {
    'dry-run': { type: 'boolean', description: 'Show proposed labels without applying them' },
    interactive: { type: 'boolean', short: 'i', description: 'Ask for confirmation before applying labels' },
  },
  positional: {
    name: 'issueId',
    description: 'Linear issue identifier (e.g., HOK-123)',
  },
  examples: [
    'npx tsx tools/auto-label-issue.ts HOK-123',
    'npx tsx tools/auto-label-issue.ts HOK-123 --dry-run',
    'npx tsx tools/auto-label-issue.ts HOK-123 --interactive',
  ],
  async run({ args, positional }) {
    const identifier = positional[0];
    if (!identifier) {
      throw new Error('Issue ID is required');
    }

    await autoLabelIssue(identifier, {
      dryRun: !!args['dry-run'],
      interactive: !!args.interactive,
    });
  },
});
